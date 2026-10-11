// set_property_values — the static-write counterpart to inspect_property_tree.
//
// The handler runs unmodified in a vm against a writable mock of the After
// Effects property model, built from what AE 26.5x89 was measured to do
// (docs/fragile-areas-ae.md, "Static property writes"): out-of-range values and
// wrong shapes throw rather than clamp; a hidden property throws "hidden"; a
// keyed one throws on setValue; a 2D layer's Position keeps its own Z; with an
// expression on, `.value` is evaluated and `valueAtTime(t, true)` is the
// underlying value; a Shape read is a copy. inspect_property_tree runs in the
// same context, so "a path it returns is accepted unchanged" is asserted on the
// real pair, not on a hand-written path.
//
//   node tests/unit/set-property-values.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
const { schemas } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "index.js")).href);
const { parseOpArgs, validateBatchOps } = await import(
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "tools", "batchSteps.js")).href
);

const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const clone = (v) => (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);

// ---------------------------------------------------------------------------
// The mock property model
// ---------------------------------------------------------------------------

const PT = { PROPERTY: 6212, NAMED_GROUP: 6213, INDEXED_GROUP: 6214 };
const PVT = {
  NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417,
  COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424,
};
const SHAPE_FIELDS = ["vertices", "inTangents", "outTangents", "closed", "featherSegLocs", "featherRelSegLocs", "featherRadii", "featherTypes", "featherInterps", "featherTensions", "featherRelCornerAngles"];

let log = [];        // every setValue that reached a property, in order
let undoOpened = 0;
let undoClosed = 0;
let saved = 0;

class Node {
  get propertyIndex() { return this.parent ? this.parent.children.indexOf(this) + 1 : undefined; }
  get propertyDepth() { return this.parent ? this.parent.propertyDepth + 1 : 0; }
  get parentProperty() { return this.parent ?? null; }
  active = true;
  elided = false;
  isModified = false;
  isEffect = false;
  isMask = false;
  canSetEnabled = false;
  enabled = true;
}

class Group extends Node {
  constructor(name, matchName, children = [], { indexed = false, ...extra } = {}) {
    super();
    Object.assign(this, { name, matchName, children, propertyType: indexed ? PT.INDEXED_GROUP : PT.NAMED_GROUP, ...extra });
    for (const c of children) c.parent = this;
  }
  get numProperties() { return this.children.length; }
  property(k) {
    if (typeof k === "number") return this.children[k - 1] ?? null;
    return this.children.find((c) => c.matchName === k || c.name === k) ?? null;
  }
}

class Prop extends Node {
  constructor(name, matchName, vt, value, o = {}) {
    super();
    Object.assign(this, { name, matchName, propertyType: PT.PROPERTY, propertyValueType: vt });
    this._value = value;
    this.keys = o.keys ?? [];
    this.canSetExpression = o.canSetExpression ?? true;
    this.canVaryOverTime = o.canVaryOverTime ?? true;
    this.expression = o.expression ?? "";
    this.expressionEnabled = o.expressionEnabled ?? !!o.expression;
    this.evaluate = o.evaluate ?? null;      // what an enabled expression makes of the value
    this.isSpatial = !!o.isSpatial;
    this.dimensionsSeparated = !!o.dimensionsSeparated;
    this.isSeparationLeader = !!o.isSeparationLeader;
    this.isSeparationFollower = !!o.isSeparationFollower;
    this.hasMin = o.min !== undefined;
    this.hasMax = o.max !== undefined;
    this.minValue = o.min;
    this.maxValue = o.max;
    this.isDropdownEffect = !!o.dropdown;
    this.refuse = o.refuse ?? null;          // runtime throw nothing predicts (a layer style that is off)
    this.ignore = !!o.ignore;                // accepts the write and keeps its value
    this.transform = o.transform ?? null;    // what AE stores for a written value (rounding, dropped Z)
  }
  get numKeys() { return this.keys.length; }
  _raw() {
    if (this.propertyValueType === PVT.NO_VALUE) throw new Error("Can not get or set a value from this property. This property's propertyValueType is PropertyValueType.NO_VALUE.");
    if (this.propertyValueType === PVT.CUSTOM_VALUE) throw new Error("This propertyValueType CUSTOM_VALUE has not been implemented.");
    if (this.propertyValueType === PVT.SHAPE) {
      const s = new ShapeCtor();
      for (const f of SHAPE_FIELDS) s[f] = clone(this._value[f] ?? (f === "closed" ? true : []));
      return s;
    }
    return clone(this._value);
  }
  get value() {
    const raw = this._raw();
    return this.expression && this.expressionEnabled && this.evaluate ? this.evaluate(raw) : raw;
  }
  valueAtTime(t, preExpression) {
    const raw = this._raw();
    return !preExpression && this.expression && this.expressionEnabled && this.evaluate ? this.evaluate(raw) : raw;
  }
  setValue(v) {
    log.push({ matchName: this.matchName, value: clone(v instanceof ShapeCtor ? Object.fromEntries(SHAPE_FIELDS.map((f) => [f, v[f]])) : v) });
    this._raw();
    if (this.keys.length) throw new Error("Can not call setValue() on a property with keyframes. Use setValueAtTime() or setValueAtKey() instead.");
    if (!this.canSetExpression && this.canVaryOverTime) throw new Error("Can not “set value” with this property, because the property or a parent property is hidden.");
    if (this.refuse) throw new Error(this.refuse);
    const vt = this.propertyValueType;
    const vector = [PVT.TwoD, PVT.TwoD_SPATIAL, PVT.ThreeD, PVT.ThreeD_SPATIAL, PVT.COLOR].includes(vt);
    if (vector && !Array.isArray(v)) throw new Error("Unable to call “setValue” because of parameter 1. Value is not an array.");
    if (!vector && vt !== PVT.SHAPE && typeof v !== "number") throw new Error("Unable to call “setValue” because of parameter 1. Array is not a number.");
    for (const n of Array.isArray(v) ? v : [v]) {
      if (this.hasMin && n < this.minValue) throw new Error(`Value ${n} out of range ${this.minValue} to ${this.maxValue}.`);
      if (this.hasMax && n > this.maxValue) throw new Error(`Value ${n} out of range ${this.minValue} to ${this.maxValue}.`);
    }
    if (this.ignore) return;
    if (vt === PVT.SHAPE) { this._value = Object.fromEntries(SHAPE_FIELDS.map((f) => [f, clone(v[f])])); return; }
    this._value = this.transform ? this.transform(clone(v), clone(this._value)) : clone(v);
  }
}

let ShapeCtor = null;

/** An AV layer: the root group with flags the handler reads. */
function makeLayer(id, name, children, { threeD = false, kind = "av", lightType } = {}) {
  const layer = new Group(name, "ADBE AV Layer", children);
  Object.assign(layer, { id, threeDLayer: threeD, __kind: kind, lightType });
  return layer;
}

function transform2D() {
  return new Group("Transform", "ADBE Transform Group", [
    new Prop("Anchor Point", "ADBE Anchor Point", PVT.ThreeD_SPATIAL, [0, 0, 0], { isSpatial: true, transform: (v, old) => [v[0], v[1], old[2]] }),
    new Prop("Position", "ADBE Position", PVT.ThreeD_SPATIAL, [960, 540, 0], { isSpatial: true, isSeparationLeader: true, transform: (v, old) => [v[0], v[1], old[2]] }),
    new Prop("X Position", "ADBE Position_0", PVT.OneD, 0, { canSetExpression: false, isSeparationFollower: true }),
    new Prop("Scale", "ADBE Scale", PVT.ThreeD, [100, 100, 100], { transform: (v, old) => [v[0], v[1], old[2]] }),
    new Prop("Orientation", "ADBE Orientation", PVT.ThreeD_SPATIAL, [0, 0, 0], { canSetExpression: false }),
    new Prop("Rotation", "ADBE Rotate Z", PVT.OneD, 0),
    new Prop("Opacity", "ADBE Opacity", PVT.OneD, 100, { min: 0, max: 100 }),
  ]);
}

function glow(radius) {
  return new Group("Glow", "ADBE Glo2", [
    new Prop("Glow Based On", "ADBE Glo2-0001", PVT.OneD, 2, { dropdown: true, min: 1, max: 2, canSetExpression: false, canVaryOverTime: false }),
    new Prop("Glow Radius", "ADBE Glo2-0003", PVT.OneD, radius, { min: 0, max: 1000 }),
    new Prop("Color A", "ADBE Glo2-0012", PVT.COLOR, [1, 1, 1, 1]),
    new Group("Compositing Options", "ADBE Effect Built In Params", [
      new Prop("Effect Opacity", "ADBE Effect Mask Opacity", PVT.OneD, 100, { min: 0, max: 100 }),
    ]),
  ], { isEffect: true });
}

/** A 2D shape layer carrying most of what the tool has to handle. */
function richLayer() {
  const effects = new Group("Effects", "ADBE Effect Parade", [
    glow(10),
    glow(25),
    new Group("Curves", "ADBE CurvesCustom", [new Prop("Curves", "ADBE CurvesCustom-0001", PVT.CUSTOM_VALUE, null)], { isEffect: true }),
    new Group("Fractal Noise", "ADBE Fractal Noise", [
      new Prop("Transform", "ADBE Fractal Noise-0007", PVT.NO_VALUE, null, { canSetExpression: false, canVaryOverTime: false }),
      new Prop("Fractal Type", "ADBE Fractal Noise-0001", PVT.OneD, 1, { min: 1, max: 20, transform: (v) => Math.round(v) }),
    ], { isEffect: true }),
    new Group("Stroke", "ADBE Stroke", [new Prop("Path", "ADBE Stroke-0001", PVT.MASK_INDEX, 0, { canSetExpression: false, canVaryOverTime: false })], { isEffect: true }),
    new Group("Set Matte", "ADBE Set Matte3", [new Prop("Take Matte From Layer", "ADBE Set Matte3-0001", PVT.LAYER_INDEX, 0, { canSetExpression: false, canVaryOverTime: false })], { isEffect: true }),
  ], { indexed: true });
  const masks = new Group("Masks", "ADBE Mask Parade", [
    new Group("Mask 1", "ADBE Mask Atom", [
      new Prop("Mask Path", "ADBE Mask Shape", PVT.SHAPE, {
        vertices: [[0, 0], [100, 0], [100, 100], [0, 100]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], closed: true,
        featherSegLocs: [2], featherRelSegLocs: [0.25], featherRadii: [9], featherTypes: [0], featherInterps: [0], featherTensions: [0], featherRelCornerAngles: [0],
      }),
      new Prop("Mask Feather", "ADBE Mask Feather", PVT.TwoD, [0, 0], { min: 0, max: 32000 }),
    ], { isMask: true }),
  ], { indexed: true });
  const contents = new Group("Contents", "ADBE Root Vectors Group", [
    new Group("Group 1", "ADBE Vector Group", [
      new Group("Contents", "ADBE Vectors Group", [
        new Group("Rectangle Path 1", "ADBE Vector Shape - Rect", [
          new Prop("Size", "ADBE Vector Rect Size", PVT.TwoD, [100, 100], { min: 0 }),
          new Prop("Roundness", "ADBE Vector Rect Roundness", PVT.OneD, 0, { min: 0 }),
        ]),
        new Group("Path 1", "ADBE Vector Shape - Group", [
          new Prop("Path", "ADBE Vector Shape", PVT.SHAPE, { vertices: [[0, 0], [10, 0]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: false }),
        ]),
        new Group("Fill 1", "ADBE Vector Graphic - Fill", [
          new Prop("Color", "ADBE Vector Fill Color", PVT.COLOR, [1, 0, 0, 0.5]),
          new Prop("Fill Rule", "ADBE Vector Fill Rule", PVT.OneD, 1, { min: 1, max: 2, canSetExpression: false, canVaryOverTime: false }),
        ]),
      ]),
    ]),
  ]);
  const styles = new Group("Layer Styles", "ADBE Layer Styles", [
    new Group("Drop Shadow", "dropShadow/enabled", [
      new Prop("Blend Mode", "dropShadow/mode2", PVT.OneD, 5, { min: 1, max: 33, refuse: "Can not “set value” with this property, because the property or a parent property is hidden." }),
    ]),
  ]);
  const text = new Group("Text", "ADBE Text Properties", [new Prop("Source Text", "ADBE Text Document", PVT.TEXT_DOCUMENT, { text: "hi" })]);
  const marker = new Prop("Marker", "ADBE Marker", PVT.MARKER, {}, { canSetExpression: false });
  const remap = new Prop("Time Remap", "ADBE Time Remapping", PVT.OneD, 0, { canSetExpression: false, min: 0, max: 2 });
  return makeLayer(5, "Rich", [marker, remap, text, contents, masks, effects, transform2D(), styles]);
}

function cameraLayer() {
  const tr = transform2D();
  tr.property("ADBE Scale").canSetExpression = false;
  return makeLayer(6, "Cam", [tr, new Group("Camera Options", "ADBE Camera Options Group", [
    new Prop("Zoom", "ADBE Camera Zoom", PVT.OneD, 888.89, { min: 1 }),
    new Prop("Aperture", "ADBE Camera Aperture", PVT.OneD, 25.3, { min: 0 }),
  ])], { kind: "camera" });
}

function lightLayer(type = "SPOT") {
  return makeLayer(7, "Light", [transform2D(), new Group("Light Options", "ADBE Light Options Group", [
    new Prop("Intensity", "ADBE Light Intensity", PVT.OneD, 100),
    new Prop("Color", "ADBE Light Color", PVT.COLOR, [1, 1, 1, 1]),
    new Prop("Cone Angle", "ADBE Light Cone Angle", PVT.OneD, 90, { min: 0, max: 180 }),
  ])], { kind: "light", lightType: type });
}

function textLayer() {
  const animator = new Group("Animator 1", "ADBE Text Animator", [
    new Group("Properties", "ADBE Text Animator Properties", [
      new Prop("Position", "ADBE Text Position 3D", PVT.ThreeD_SPATIAL, [0, 0, 0]),
      new Prop("Opacity", "ADBE Text Opacity", PVT.OneD, 100, { canSetExpression: false, min: 0, max: 100 }),
    ]),
  ]);
  const tr = transform2D();
  return makeLayer(8, "Kinetic", [new Group("Text", "ADBE Text Properties", [new Group("Animators", "ADBE Text Animators", [animator], { indexed: true })]), tr], { threeD: true });
}

function load(layers) {
  log = [];
  undoOpened = 0;
  undoClosed = 0;
  saved = 0;
  const ctx = {
    app: {
      beginUndoGroup: () => { undoOpened++; },
      endUndoGroup: () => { undoClosed++; },
      project: {
        itemByID: (id) => ctx.__items[id] ?? (() => { throw new Error("internal verification failure, sorry! {Item Not Found}"); })(),
        save: () => { saved++; },
      },
    },
    __items: {},
    PropertyType: PT,
    PropertyValueType: PVT,
    KeyframeInterpolationType: { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 },
    MaskMode: { NONE: 6812, ADD: 6813, SUBTRACT: 6814 },
    ParagraphJustification: { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7415, RIGHT_JUSTIFY: 7414, FULL_JUSTIFY_LASTLINE_LEFT: 7416 },
    LightType: { PARALLEL: 4412, SPOT: 4413, POINT: 4414, AMBIENT: 4415 },
  };
  vm.createContext(ctx);
  vm.runInContext("function CompItem(){} function Shape(){}", ctx);
  ShapeCtor = vm.runInContext("Shape", ctx);
  // Layer classes decided by the mock's own flag, so `instanceof` works on the
  // plain group objects the mock builds.
  ctx.__kind = (k) => ({ [Symbol.hasInstance]: (o) => !!o && (k === "av" ? o.__kind === "av" : o.__kind === k) });
  vm.runInContext("var AVLayer = __kind('av'), CameraLayer = __kind('camera'), LightLayer = __kind('light');", ctx);
  for (const l of layers) if (l.__kind === "light") l.lightType = ctx.LightType[l.lightType];
  for (const f of ["core.jsx", "ids.jsx", "comps.jsx", "transforms.jsx", "keyframes.jsx", "expressions.jsx", "text.jsx", "explore.jsx", "inspect.jsx", "propwrite.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const comp = vm.runInContext("new CompItem()", ctx);
  Object.assign(comp, { id: 1, name: "MCP Test", time: 0, numLayers: layers.length, layer: (i) => layers[i - 1] });
  ctx.__items[1] = comp;
  const dispatch = vm.runInContext("dispatch", ctx);
  const call = (op, args) => plain(dispatch(JSON.stringify({ op, args: { compId: 1, ...args } })));
  return {
    set: (layerId, updates) => call("set_property_values", { layerId, updates }),
    inspect: (args) => call("inspect_property_tree", args),
  };
}

const prop = (layer, p) => p.reduce((g, seg) => g.property(seg), layer);
const ok = (r) => { assert.equal(r.ok, true, r.error); return r.result; };
const refused = (r, re) => {
  assert.equal(r.ok, false, "expected a refusal");
  if (re) assert.match(r.error, re);
  return r.error;
};

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
}

const OPACITY = ["ADBE Transform Group", "ADBE Opacity"];
const POSITION = ["ADBE Transform Group", "ADBE Position"];
const SCALE = ["ADBE Transform Group", "ADBE Scale"];
const FILL = ["ADBE Root Vectors Group", "ADBE Vector Group", "ADBE Vectors Group", "ADBE Vector Graphic - Fill"];
const MASK = ["ADBE Mask Parade", "ADBE Mask Atom", "ADBE Mask Shape"];

// ---------------------------------------------------------------------------
// Value types that land
// ---------------------------------------------------------------------------

check("1. a scalar write lands and the result is the read-back value", () => {
  const layer = richLayer();
  const r = ok(load([layer]).set(5, [{ path: OPACITY, value: 40 }]));
  assert.deepEqual(r.updates, [{ path: OPACITY, name: "Opacity", matchName: "ADBE Opacity", valueType: "OneD", previousValue: 100, actualValue: 40, changed: true }]);
  assert.equal(prop(layer, OPACITY)._value, 40);
  assert.deepEqual([r.compId, r.layerId, r.updateCount, r.appliedCount], [1, 5, 1, 1]);
});

check("2. a TwoD value lands", () => {
  const layer = richLayer();
  const r = ok(load([layer]).set(5, [{ path: [...FILL.slice(0, 3), "ADBE Vector Shape - Rect", "ADBE Vector Rect Size"], value: [200, 80] }]));
  assert.deepEqual(r.updates[0].actualValue, [200, 80]);
  assert.equal(r.updates[0].valueType, "TwoD");
});

check("3. a ThreeD value lands (2D layer, Z kept as it reads)", () => {
  const layer = richLayer();
  const r = ok(load([layer]).set(5, [{ path: SCALE, value: [50, 60, 100] }, { path: POSITION, value: [10, 20, 0] }]));
  assert.deepEqual(r.updates.map((u) => u.actualValue), [[50, 60, 100], [10, 20, 0]]);
});

check("4. a COLOR lands as four numbers; three keep the current alpha (AE alone would reset it to 1)", () => {
  const layer = richLayer();
  const run = load([layer]);
  const r = ok(run.set(5, [{ path: [...FILL, "ADBE Vector Fill Color"], value: [0, 1, 0] }]));
  assert.deepEqual(r.updates[0].actualValue, [0, 1, 0, 0.5]);
  assert.deepEqual(log.at(-1).value, [0, 1, 0, 0.5], "the alpha is sent explicitly");
  const r2 = ok(run.set(5, [{ path: [...FILL, "ADBE Vector Fill Color"], value: [0.2, 0.4, 0.6, 1] }]));
  assert.deepEqual(r2.updates[0].actualValue, [0.2, 0.4, 0.6, 1]);
});

// ---------------------------------------------------------------------------
// Preflight refusals: nothing written
// ---------------------------------------------------------------------------

check("5. a dimension mismatch is refused before any write", () => {
  const run = load([richLayer()]);
  refused(run.set(5, [{ path: SCALE, value: [50, 60] }]), /takes exactly 3 numbers/);
  refused(run.set(5, [{ path: OPACITY, value: [1, 2] }]), /takes a single number/);
  refused(run.set(5, [{ path: SCALE, value: 50 }]), /takes an array of 3 numbers/);
  refused(run.set(5, [{ path: [...FILL, "ADBE Vector Fill Color"], value: [1, 0, 0, 1, 1] }]), /\[r, g, b\] or \[r, g, b, a\]/);
  assert.equal(log.length, 0);
});

check("6. a group endpoint is refused", () => {
  const run = load([richLayer()]);
  refused(run.set(5, [{ path: ["ADBE Effect Parade", 1] }].map((u) => ({ ...u, value: 1 }))), /is a group \("Glow", ADBE Glo2\)/);
  assert.equal(log.length, 0);
});

check("7. an invalid path is refused with the segment named", () => {
  const run = load([richLayer()]);
  refused(run.set(5, [{ path: ["ADBE Transform Group", "Nope"], value: 1 }]), /segment returned null at \[1\]=Nope/);
  refused(run.set(99, [{ path: OPACITY, value: 1 }]), /No layer with id 99/);
  assert.equal(log.length, 0);
});

check("8. NO_VALUE section markers and buttons are refused", () => {
  const run = load([richLayer()]);
  refused(run.set(5, [{ path: ["ADBE Effect Parade", "ADBE Fractal Noise", "ADBE Fractal Noise-0007"], value: 1 }]), /NO_VALUE\) has no value/);
  assert.equal(log.length, 0);
});

check("9. CUSTOM_VALUE plugin data is refused", () => {
  const run = load([richLayer()]);
  refused(run.set(5, [{ path: ["ADBE Effect Parade", "ADBE CurvesCustom", "ADBE CurvesCustom-0001"], value: 1 }]), /CUSTOM_VALUE\) holds plugin-defined data/);
  assert.equal(log.length, 0);
});

check("10. a hidden property is refused, with the reason where it is known", () => {
  const run = load([richLayer(), cameraLayer(), textLayer()]);
  refused(run.set(5, [{ path: ["ADBE Transform Group", "ADBE Orientation"], value: [10, 0, 0] }]), /the layer is 2D — this property needs threeDLayer:true/);
  refused(run.set(5, [{ path: ["ADBE Transform Group", "ADBE Position_0"], value: 3 }]), /leader's dimensions are not separated/);
  refused(run.set(6, [{ path: SCALE, value: [50, 50, 50] }]), /hidden/);
  refused(run.set(8, [{ path: ["ADBE Text Properties", "ADBE Text Animators", "ADBE Text Animator", "ADBE Text Animator Properties", "ADBE Text Opacity"], value: 20 }]), /hidden/);
  refused(run.set(5, [{ path: ["ADBE Time Remapping"], value: 1 }]), /Time Remap is off/);
  assert.equal(log.length, 0);
});

check("11. a keyed property is refused and its keys are untouched", () => {
  const layer = richLayer();
  prop(layer, OPACITY).keys = [{ time: 0, value: 0 }, { time: 1, value: 100 }, { time: 2, value: 50 }];
  const run = load([layer]);
  refused(run.set(5, [{ path: OPACITY, value: 30 }]), /has 3 keyframes, so it has no single static value — this tool never removes keys/);
  assert.equal(prop(layer, OPACITY).keys.length, 3);
  assert.equal(log.length, 0);
});

check("12. expression policy: the underlying value is written and verified, the expression kept and reported", () => {
  const layer = richLayer();
  Object.assign(prop(layer, OPACITY), { expression: "value / 2", expressionEnabled: true, evaluate: (v) => v / 2 });
  prop(layer, OPACITY)._value = 80;
  const r = ok(load([layer]).set(5, [{ path: OPACITY, value: 60 }]));
  const u = r.updates[0];
  assert.equal(u.previousValue, 80, "pre-expression value, not the evaluated 40");
  assert.equal(u.actualValue, 60);
  assert.equal(u.expressionEnabled, true);
  assert.equal(u.evaluatedValue, 30);
  assert.equal(prop(layer, OPACITY).expression, "value / 2", "the expression is left alone");
  // A disabled expression: `.value` is the value itself, nothing to report.
  const l2 = richLayer();
  Object.assign(prop(l2, OPACITY), { expression: "value / 2", expressionEnabled: false, evaluate: (v) => v / 2 });
  const r2 = ok(load([l2]).set(5, [{ path: OPACITY, value: 60 }]));
  assert.equal(r2.updates[0].expressionEnabled, undefined);
  assert.equal(r2.updates[0].actualValue, 60);
});

check("13. several valid updates land in order, in one call", () => {
  const layer = richLayer();
  const r = ok(load([layer]).set(5, [
    { path: OPACITY, value: 25 },
    { path: ["ADBE Effect Parade", 2, "ADBE Glo2-0003"], value: 77 },
    { path: [...FILL, "ADBE Vector Fill Color"], value: [0, 0, 1, 1] },
  ]));
  assert.equal(r.appliedCount, 3);
  assert.deepEqual(log.map((w) => w.matchName), ["ADBE Opacity", "ADBE Glo2-0003", "ADBE Vector Fill Color"]);
});

check("14. an invalid later update means no earlier one is written, and every problem is named", () => {
  const layer = richLayer();
  const run = load([layer]);
  const err = refused(run.set(5, [
    { path: OPACITY, value: 25 },
    { path: ["ADBE Effect Parade", 2, "ADBE Glo2-0003"], value: 77 },
    { path: SCALE, value: [1, 2] },
    { path: ["ADBE Transform Group", "Nope"], value: 1 },
  ]));
  assert.match(err, /update 3 \(ADBE Transform Group > ADBE Scale\): .*takes exactly 3/);
  assert.match(err, /update 4 \(ADBE Transform Group > Nope\)/);
  assert.match(err, /Nothing was changed\.$/);
  assert.equal(log.length, 0);
  assert.equal(prop(layer, OPACITY)._value, 100);
});

check("15. two updates that reach one property are refused, however the paths are spelled", () => {
  const run = load([richLayer()]);
  refused(run.set(5, [{ path: OPACITY, value: 1 }, { path: ["Transform", "Opacity"], value: 2 }]), /update 2 .*same property as update 1/);
  refused(run.set(5, [{ path: OPACITY, value: 1 }, { path: [7, 7], value: 2 }]), /same property as update 1/);
  assert.equal(log.length, 0);
  // Two Glows' radii are different properties.
  ok(run.set(5, [{ path: ["ADBE Effect Parade", 1, "ADBE Glo2-0003"], value: 1 }, { path: ["ADBE Effect Parade", 2, "ADBE Glo2-0003"], value: 2 }]));
});

check("out-of-range, non-finite, whole-number and index values are refused up front", () => {
  const run = load([richLayer(), cameraLayer()]);
  refused(run.set(5, [{ path: OPACITY, value: 150 }]), /above this property's maximum 100/);
  refused(run.set(5, [{ path: OPACITY, value: -5 }]), /below this property's minimum 0/);
  refused(run.set(5, [{ path: ["ADBE Effect Parade", 1, "ADBE Glo2-0001"], value: 1.5 }]), /takes a whole number/);
  refused(run.set(5, [{ path: ["ADBE Effect Parade", "ADBE Stroke", "ADBE Stroke-0001"], value: 2 }]), /mask index: 0 for none, or 1..1 on this layer/);
  refused(run.set(5, [{ path: ["ADBE Effect Parade", "ADBE Set Matte3", "ADBE Set Matte3-0001"], value: 2 }]), /layer 2 \("Cam"\) is not an AV layer/);
  refused(run.set(5, [{ path: ["ADBE Effect Parade", "ADBE Set Matte3", "ADBE Set Matte3-0001"], value: 9 }]), /0 for none, or 1..2 in this comp/);
  assert.equal(log.length, 0);
  const r = ok(run.set(5, [{ path: ["ADBE Effect Parade", "ADBE Stroke", "ADBE Stroke-0001"], value: 1 }, { path: ["ADBE Effect Parade", "ADBE Set Matte3", "ADBE Set Matte3-0001"], value: 1 }]));
  assert.deepEqual(r.updates.map((u) => [u.valueType, u.actualValue]), [["MASK_INDEX", 1], ["LAYER_INDEX", 1]]);
});

check("a 2D layer's Z is refused unless it stays what it is (AE would keep its own)", () => {
  const run = load([richLayer()]);
  refused(run.set(5, [{ path: POSITION, value: [10, 20, 7] }]), /the layer is 2D, and After Effects ignores the Z of Position .* pass 0 as the third number/);
  assert.equal(log.length, 0);
  // On a 3D layer the Z is a real value.
  const l3 = textLayer();
  l3.property("ADBE Transform Group").property("ADBE Position").transform = null;
  const r = ok(load([l3]).set(8, [{ path: POSITION, value: [10, 20, 7] }]));
  assert.deepEqual(r.updates[0].actualValue, [10, 20, 7]);
});

check("an ambient light's Transform is refused (canSetExpression lies there)", () => {
  const amb = lightLayer("AMBIENT");
  const r = load([amb]);
  refused(r.set(7, [{ path: ["ADBE Transform Group", "ADBE Rotate Z"], value: 10 }]), /ambient light/);
  assert.equal(log.length, 0);
});

// ---------------------------------------------------------------------------
// Readback and rollback
// ---------------------------------------------------------------------------

check("16. readback: a value AE stores differently (rounded) is a failure, not a success", () => {
  const layer = richLayer();
  const err = refused(load([layer]).set(5, [{ path: ["ADBE Effect Parade", "ADBE Fractal Noise", "ADBE Fractal Noise-0001"], value: 2.5 }]));
  assert.match(err, /the write did not land: requested 2\.5, After Effects reads 3/);
  assert.match(err, /Rolled back every write this call made .*restored\), so nothing changed/);
  assert.equal(prop(layer, ["ADBE Effect Parade", "ADBE Fractal Noise", "ADBE Fractal Noise-0001"])._value, 1, "restored");
});

check("17. a write that does not land at all is caught and rolled back", () => {
  const layer = richLayer();
  prop(layer, ["ADBE Effect Parade", 2, "ADBE Glo2-0003"]).ignore = true;
  const err = refused(load([layer]).set(5, [{ path: OPACITY, value: 10 }, { path: ["ADBE Effect Parade", 2, "ADBE Glo2-0003"], value: 77 }]));
  assert.match(err, /update 2 .*the write did not land: requested 77, After Effects reads 25/);
  assert.equal(prop(layer, OPACITY)._value, 100, "update 1 was rolled back");
});

check("18. rollback: a runtime refusal nothing predicts restores every earlier write, Shape feather included", () => {
  const layer = richLayer();
  const before = clone(prop(layer, MASK)._value);
  const err = refused(load([layer]).set(5, [
    { path: OPACITY, value: 20 },
    { path: MASK, value: { vertices: [[0, 0], [100, 0], [100, 100], [0, 100]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], closed: true, feather: { segLocs: [], relSegLocs: [], radii: [], types: [], interps: [], tensions: [], relCornerAngles: [] } } },
    { path: ["ADBE Layer Styles", "dropShadow/enabled", "dropShadow/mode2"], value: 3 },
  ]));
  assert.match(err, /update 3 .*After Effects refused the value: .*hidden/);
  assert.match(err, /ADBE Mask Shape restored; ADBE Transform Group > ADBE Opacity restored\), so nothing changed/);
  assert.equal(prop(layer, OPACITY)._value, 100);
  assert.deepEqual(prop(layer, MASK)._value, before, "the feather points came back with the path");
  assert.deepEqual(log.map((w) => w.matchName), ["ADBE Opacity", "ADBE Mask Shape", "dropShadow/mode2", "ADBE Mask Shape", "ADBE Opacity"], "restored newest first");
});

check("a restore that fails is reported as INCOMPLETE, never assumed", () => {
  const layer = richLayer();
  const op = prop(layer, OPACITY);
  let n = 0;
  const orig = op.setValue.bind(op);
  op.setValue = (v) => { if (++n === 2) throw new Error("boom on restore"); return orig(v); };
  const err = refused(load([layer]).set(5, [{ path: OPACITY, value: 20 }, { path: ["ADBE Layer Styles", "dropShadow/enabled", "dropShadow/mode2"], value: 3 }]));
  assert.match(err, /Rollback was INCOMPLETE: ADBE Transform Group > ADBE Opacity NOT restored \(boom on restore\); it was 100/);
  assert.match(err, /Edit > Undo reverts the whole call/);
});

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

check("19. duplicate effects: the index path reaches Glow 2 and Glow 1 is untouched", () => {
  const layer = richLayer();
  const run = load([layer]);
  const tree = ok(run.inspect({ layerId: 5, path: ["ADBE Effect Parade"], depth: 2 }));
  const radii = tree.nodes.filter((n) => n.matchName === "ADBE Glo2-0003");
  assert.deepEqual(radii.map((n) => n.path), [["ADBE Effect Parade", 1, "ADBE Glo2-0003"], ["ADBE Effect Parade", 2, "ADBE Glo2-0003"]]);
  ok(run.set(5, [{ path: radii[1].path, value: 42 }]));
  assert.equal(prop(layer, ["ADBE Effect Parade", 1, "ADBE Glo2-0003"])._value, 10);
  assert.equal(prop(layer, ["ADBE Effect Parade", 2, "ADBE Glo2-0003"])._value, 42);
  // A nested real group inside an effect.
  ok(run.set(5, [{ path: ["ADBE Effect Parade", 2, "ADBE Effect Built In Params", "ADBE Effect Mask Opacity"], value: 40 }]));
  assert.equal(prop(layer, ["ADBE Effect Parade", 1, "ADBE Effect Built In Params", "ADBE Effect Mask Opacity"])._value, 100);
});

check("20. Shape: a mask path keeps its feather points when `feather` is omitted, and checks them", () => {
  const layer = richLayer();
  const run = load([layer]);
  const r = ok(run.set(5, [{ path: MASK, value: { vertices: [[5, 5], [105, 5], [105, 105], [5, 105]], inTangents: [[0, 0], [1, 1], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], closed: true } }]));
  assert.deepEqual(r.updates[0].actualValue.vertices[0], [5, 5]);
  assert.deepEqual(r.updates[0].actualValue.feather.radii, [9], "kept");
  assert.deepEqual(prop(layer, MASK)._value.featherSegLocs, [2]);
  // A shorter path would strand the kept feather point on segment 2.
  refused(run.set(5, [{ path: MASK, value: { vertices: [[0, 0], [1, 1]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: false } }]), /existing feather point on segment 2 would sit past the end/);
  // Explicit feather replaces; empty arrays clear.
  const r2 = ok(run.set(5, [{ path: MASK, value: { vertices: [[0, 0], [1, 1]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: false, feather: { segLocs: [0], relSegLocs: [0.5], radii: [4], types: [0], interps: [0], tensions: [0], relCornerAngles: [0] } } }]));
  assert.deepEqual(r2.updates[0].actualValue.feather.segLocs, [0]);
  refused(run.set(5, [{ path: MASK, value: { vertices: [[0, 0], [1, 1]], inTangents: [[0, 0]], outTangents: [[0, 0], [0, 0]], closed: false } }]), /2 vertices but 1 inTangents/);
  refused(run.set(5, [{ path: MASK, value: { vertices: [[0, 0], [1, 1]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: false, feather: { segLocs: [3], relSegLocs: [0.5], radii: [4], types: [0], interps: [0], tensions: [0], relCornerAngles: [0] } } }]), /segLocs\[0\] = 3 is not a segment/);
  // A shape-layer path is a Shape too, and takes no feather.
  const vp = ["ADBE Root Vectors Group", "ADBE Vector Group", "ADBE Vectors Group", "ADBE Vector Shape - Group", "ADBE Vector Shape"];
  const r3 = ok(run.set(5, [{ path: vp, value: { vertices: [[0, 0], [30, 40], [60, 0]], inTangents: [[0, 0], [-5, 0], [0, 0]], outTangents: [[0, 0], [5, 0], [0, 0]], closed: false } }]));
  assert.deepEqual(r3.updates[0].actualValue, { closed: false, vertices: [[0, 0], [30, 40], [60, 0]], inTangents: [[0, 0], [-5, 0], [0, 0]], outTangents: [[0, 0], [5, 0], [0, 0]] });
  refused(run.set(5, [{ path: vp, value: { vertices: [[0, 0]], inTangents: [[0, 0]], outTangents: [[0, 0]], closed: false, feather: { segLocs: [], relSegLocs: [], radii: [], types: [], interps: [], tensions: [], relCornerAngles: [] } } }]), /not a mask's/);
});

check("21. TextDocument is refused with a pointer to set_text", () => {
  const run = load([richLayer()]);
  refused(run.set(5, [{ path: ["ADBE Text Properties", "ADBE Text Document"], value: 1 }]), /Source Text document; write text with set_text/);
  assert.equal(log.length, 0);
});

check("22. Marker is refused with a pointer to the marker tools", () => {
  const run = load([richLayer()]);
  refused(run.set(5, [{ path: ["ADBE Marker"], value: 1 }]), /markers are keys at times.*add_marker/);
  assert.equal(log.length, 0);
});

check("an unmeasured value type (variable-font axis) is refused, not guessed at", () => {
  const layer = makeLayer(9, "VF", [new Prop("VF Axis", "ADBE Text VF Axis 1", 1489342032, 0)]);
  refused(load([layer]).set(9, [{ path: ["ADBE Text VF Axis 1"], value: 1 }]), /UNKNOWN\(1489342032\)\) is a value type static writes have not been measured on/);
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

check("23. strict schema: unknown keys, empty or oversized updates, bad shapes, a time are refused — also in a batch", () => {
  const u = { path: OPACITY, value: 1 };
  for (const bad of [
    { compId: 1, layerId: 2, updates: [] },
    { compId: 1, layerId: 2, updates: Array.from({ length: 51 }, () => u) },
    { compId: 1, layerId: 2, updates: [u], time: 1 },
    { compId: 1, layerId: 2, updates: [{ ...u, time: 1 }] },
    { compId: 1, layerId: 2, updates: [{ ...u, keyframe: true }] },
    { compId: 1, layerId: 2, updates: [{ path: [], value: 1 }] },
    { compId: 1, layerId: 2, updates: [{ path: OPACITY }] },
    { compId: 1, layerId: 2, updates: [{ path: OPACITY, value: "50" }] },
    { compId: 1, layerId: 2, updates: [{ path: OPACITY, value: true }] },
    { compId: 1, layerId: 2, updates: [{ path: OPACITY, value: [1] }] },
    { compId: 1, layerId: 2, updates: [{ path: OPACITY, value: [1, 2, 3, 4, 5] }] },
    { compId: 1, layerId: 2, updates: [{ path: MASK, value: { vertices: [[0, 0]], inTangents: [[0, 0]], outTangents: [[0, 0]] } }] },
    { compId: 1, layerId: 2, updates: [{ path: MASK, value: { vertices: [[0, 0]], inTangents: [[0, 0]], outTangents: [[0, 0]], closed: true, extra: 1 } }] },
    { compId: 1, updates: [u] },
  ]) {
    assert.throws(() => parseOpArgs("set_property_values", bad), JSON.stringify(bad).slice(0, 120));
  }
  assert.equal(parseOpArgs("set_property_values", { compId: 1, layerId: 2, updates: Array.from({ length: 50 }, () => u) }).updates.length, 50);
  assert.throws(() => validateBatchOps([{ op: "set_property_values", args: { compId: 1, layerId: 2, updates: [{ ...u, time: 0 }] } }]), /step 0 \(set_property_values\)/);
});

check("24. classified write", () => {
  assert.equal(schemas.OpMutation.set_property_values, "write");
  assert.equal(schemas.SET_PROPERTY_VALUES_MAX, 50);
});

check("25. never saves the project", () => {
  const run = load([richLayer()]);
  ok(run.set(5, [{ path: OPACITY, value: 1 }]));
  refused(run.set(5, [{ path: OPACITY, value: 2 }, { path: ["ADBE Layer Styles", "dropShadow/enabled", "dropShadow/mode2"], value: 3 }]));
  assert.equal(saved, 0);
});

check("26. one undo group per call — success, preflight refusal and rollback alike", () => {
  const run = load([richLayer()]);
  ok(run.set(5, [{ path: OPACITY, value: 1 }, { path: SCALE, value: [2, 2, 100] }]));
  assert.deepEqual([undoOpened, undoClosed], [1, 1]);
  refused(run.set(5, [{ path: SCALE, value: [1] }]));
  assert.deepEqual([undoOpened, undoClosed], [2, 2]);
  refused(run.set(5, [{ path: OPACITY, value: 3 }, { path: ["ADBE Layer Styles", "dropShadow/enabled", "dropShadow/mode2"], value: 3 }]));
  assert.deepEqual([undoOpened, undoClosed], [3, 3], "the rollback stays inside the call's own group");
});

check("27. the result is read back, not echoed — float32 storage shows through", () => {
  const layer = richLayer();
  const glowColor = prop(layer, ["ADBE Effect Parade", 2, "ADBE Glo2-0012"]);
  glowColor.transform = (v) => v.map((n) => Math.fround(n));
  const r = ok(load([layer]).set(5, [{ path: ["ADBE Effect Parade", 2, "ADBE Glo2-0012"], value: [0.2, 0.4, 0.6, 1] }]));
  assert.deepEqual(r.updates[0].actualValue, [Math.fround(0.2), Math.fround(0.4), Math.fround(0.6), 1]);
  assert.notDeepEqual(r.updates[0].actualValue, [0.2, 0.4, 0.6, 1]);
  // Writing what is already there succeeds and says it changed nothing.
  const r2 = ok(load([richLayer()]).set(5, [{ path: OPACITY, value: 100 }]));
  assert.equal(r2.updates[0].changed, false);
});

check("28. a path straight from inspect_property_tree is accepted unchanged: camera, light, text animator", () => {
  const cam = cameraLayer(), light = lightLayer(), txt = textLayer();
  const run = load([cam, light, txt]);
  const pathOf = (layerId, start, m) => ok(run.inspect({ layerId, path: start, depth: 6 })).nodes.find((n) => n.matchName === m).path;
  const zoom = pathOf(6, ["ADBE Camera Options Group"], "ADBE Camera Zoom");
  const aperture = pathOf(6, ["ADBE Camera Options Group"], "ADBE Camera Aperture");
  const r = ok(run.set(6, [{ path: zoom, value: 500 }, { path: aperture, value: 30 }]));
  assert.deepEqual(r.updates.map((u) => u.actualValue), [500, 30]);
  const intensity = pathOf(7, ["ADBE Light Options Group"], "ADBE Light Intensity");
  const cone = pathOf(7, ["ADBE Light Options Group"], "ADBE Light Cone Angle");
  ok(run.set(7, [{ path: intensity, value: 150 }, { path: cone, value: 60 }]));
  assert.deepEqual([light.property("ADBE Light Options Group").property("ADBE Light Intensity")._value, light.property("ADBE Light Options Group").property("ADBE Light Cone Angle")._value], [150, 60]);
  const animPos = pathOf(8, ["ADBE Text Properties"], "ADBE Text Position 3D");
  assert.deepEqual(animPos, ["ADBE Text Properties", "ADBE Text Animators", "ADBE Text Animator", "ADBE Text Animator Properties", "ADBE Text Position 3D"]);
  const ra = ok(run.set(8, [{ path: animPos, value: [0, -40, 0] }]));
  assert.deepEqual(ra.updates[0].actualValue, [0, -40, 0]);
  // …and inspecting again shows the new value at the same path.
  const again = ok(run.inspect({ layerId: 8, path: animPos }));
  assert.deepEqual(again.nodes[0].value, [0, -40, 0]);
});

console.log(`set-property-values: ${passed} checks passed`);
