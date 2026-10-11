// inspect_property_tree — the generic, bounded, read-only property walker.
//
// The handler runs unmodified in a vm against a mock of the After Effects
// property model built from what AE 26.5x89 was measured to do
// (docs/fragile-areas-ae.md, "Property trees"): `.value` throws on NO_VALUE and
// CUSTOM_VALUE, `separationDimension` throws unless the property is a
// separation follower, `minValue`/`maxValue` throw without hasMin/hasMax,
// groups answer undefined for every value-ish field, a marker's value is a
// plain object. Every setter on the mock fails the test outright, which is how
// "read-only" is asserted rather than assumed.
//
//   node tests/unit/inspect-property-tree.mjs

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

// ---------------------------------------------------------------------------
// The mock property model
// ---------------------------------------------------------------------------

const PT = { PROPERTY: 6212, NAMED_GROUP: 6213, INDEXED_GROUP: 6214 };
const PVT = {
  NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417,
  COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424,
};
const KIT = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };

let writes = 0;
const forbidden = (what) => () => { writes++; throw new Error(`test: inspect_property_tree attempted ${what}`); };

class Node {
  get propertyIndex() { return this.parent ? this.parent.children.indexOf(this) + 1 : undefined; }
  get enabled() { return this._enabled ?? true; }
  set enabled(v) { forbidden("a write to enabled")(); }
  active = true;
  elided = false;
  isModified = false;
  isEffect = false;
  isMask = false;
  canSetEnabled = false;
  remove = forbidden("remove()");
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
  addProperty = forbidden("addProperty()");
}

class Prop extends Node {
  constructor(name, matchName, vt, value, o = {}) {
    super();
    this.name = name;
    this.matchName = matchName;
    this.propertyType = PT.PROPERTY;
    this.propertyValueType = vt;
    this._value = value;
    this.keys = o.keys ?? [];
    this.canSetExpression = o.canSetExpression ?? true;
    this.canVaryOverTime = o.canVaryOverTime ?? true;
    this._expression = o.expression ?? "";
    this.expressionEnabled = o.expressionEnabled ?? !!o.expression;
    this._expressionError = o.expressionError ?? "";
    this.isSpatial = !!o.isSpatial;
    this.dimensionsSeparated = !!o.dimensionsSeparated;
    this.isSeparationLeader = !!o.isSeparationLeader;
    this.isSeparationFollower = !!o.isSeparationFollower;
    this._dim = o.separationDimension;
    this.separationLeader = o.separationLeader ?? null;
    this.hasMin = o.min !== undefined;
    this.hasMax = o.max !== undefined;
    this._min = o.min;
    this._max = o.max;
    this.unitsText = o.unitsText ?? "";
    this.isDropdownEffect = !!o.dropdown;
    this.valueThrows = o.valueThrows;
    this.expressionThrows = o.expressionThrows;
    this.expressionErrorThrows = o.expressionErrorThrows;
  }
  get value() {
    if (this.propertyValueType === PVT.NO_VALUE) throw new Error(`Can not get or set a value from this property (matchname is "${this.matchName}"). This property's propertyValueType is PropertyValueType.NO_VALUE.`);
    if (this.propertyValueType === PVT.CUSTOM_VALUE) throw new Error("This propertyValueType CUSTOM_VALUE has not been implemented.");
    if (this.valueThrows) throw new Error(this.valueThrows);
    return this._value;
  }
  get expression() { if (this.expressionThrows) throw new Error(this.expressionThrows); return this._expression; }
  set expression(v) { forbidden("a write to expression")(); }
  get expressionError() { if (this.expressionErrorThrows) throw new Error("boom"); return this._expressionError; }
  get separationDimension() {
    if (!this.isSeparationFollower) throw new Error("internal verification failure, sorry! {stream isn't separated in AEGP_GetSeparationLeader}");
    return this._dim;
  }
  get minValue() { if (!this.hasMin) throw new Error("This property has no minimum value."); return this._min; }
  get maxValue() { if (!this.hasMax) throw new Error("This property has no maximum value."); return this._max; }
  get numKeys() { return this.keys.length; }
  get isTimeVarying() { return this.keys.length > 0 || !!this._expression; }
  keyTime(k) { return this.keys[k - 1].time; }
  keyValue(k) { return this.keys[k - 1].value; }
  keyInInterpolationType(k) { return this.keys[k - 1].inType ?? KIT.LINEAR; }
  keyOutInterpolationType(k) { return this.keys[k - 1].outType ?? KIT.LINEAR; }
  keyInTemporalEase(k) { return this.keys[k - 1].easeIn ?? [{ influence: 16.67, speed: 0 }]; }
  keyOutTemporalEase(k) { return this.keys[k - 1].easeOut ?? [{ influence: 16.67, speed: 0 }]; }
  keyTemporalContinuous(k) { return !!this.keys[k - 1].temporalContinuous; }
  keyTemporalAutoBezier(k) { return !!this.keys[k - 1].temporalAutoBezier; }
  keyInSpatialTangent(k) { return this.keys[k - 1].inTangent ?? [0, 0, 0]; }
  keyOutSpatialTangent(k) { return this.keys[k - 1].outTangent ?? [0, 0, 0]; }
  keySpatialContinuous(k) { return !!this.keys[k - 1].spatialContinuous; }
  keySpatialAutoBezier(k) { return !!this.keys[k - 1].spatialAutoBezier; }
  keyRoving(k) { return !!this.keys[k - 1].roving; }
  keyLabel(k) { return this.keys[k - 1].label ?? 0; }
  setValue = forbidden("setValue()");
  setValueAtTime = forbidden("setValueAtTime()");
  setValueAtKey = forbidden("setValueAtKey()");
  removeKey = forbidden("removeKey()");
  addKey = forbidden("addKey()");
  setInterpolationTypeAtKey = forbidden("setInterpolationTypeAtKey()");
  setTemporalEaseAtKey = forbidden("setTemporalEaseAtKey()");
}

/** A layer: the root group, with the measured AV-layer children. */
function makeLayer(id, name, children) {
  const layer = new Group(name, "ADBE AV Layer", children);
  layer.id = id;
  return layer;
}

function transform(extra = []) {
  return new Group("Transform", "ADBE Transform Group", [
    new Prop("Anchor Point", "ADBE Anchor Point", PVT.ThreeD_SPATIAL, [0, 0, 0], { isSpatial: true }),
    new Prop("Position", "ADBE Position", PVT.ThreeD_SPATIAL, [960, 540, 0], { isSpatial: true, isSeparationLeader: true }),
    new Prop("Scale", "ADBE Scale", PVT.ThreeD, [100, 100, 100], { unitsText: "percent" }),
    new Prop("Rotation", "ADBE Rotate Z", PVT.OneD, 0, { unitsText: "degrees" }),
    new Prop("Opacity", "ADBE Opacity", PVT.OneD, 100, { min: 0, max: 100, unitsText: "percent" }),
    ...extra,
  ]);
}

function load(layers) {
  writes = 0;
  const ctx = {
    app: {
      beginUndoGroup: forbidden("beginUndoGroup()"),
      endUndoGroup: forbidden("endUndoGroup()"),
      project: { itemByID: (id) => ctx.__items[id] ?? (() => { throw new Error("internal verification failure, sorry! {Item Not Found}"); })() },
    },
    __items: {},
    PropertyType: PT,
    PropertyValueType: PVT,
    KeyframeInterpolationType: KIT,
    MaskMode: { NONE: 6812, ADD: 6813, SUBTRACT: 6814 },
    ParagraphJustification: { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7415, RIGHT_JUSTIFY: 7414, FULL_JUSTIFY_LASTLINE_LEFT: 7416 },
  };
  vm.createContext(ctx);
  vm.runInContext("function CompItem(){}", ctx);
  for (const f of ["core.jsx", "ids.jsx", "comps.jsx", "keyframes.jsx", "text.jsx", "explore.jsx", "inspect.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const comp = vm.runInContext("new CompItem()", ctx);
  Object.assign(comp, { id: 1, name: "MCP Test", numLayers: layers.length, layer: (i) => layers[i - 1] });
  ctx.__items[1] = comp;
  const dispatch = vm.runInContext("dispatch", ctx);
  return (args) => plain(dispatch(JSON.stringify({ op: "inspect_property_tree", args: { compId: 1, ...args } })));
}

const byMatch = (res, m) => res.result.nodes.filter((n) => n.matchName === m);
const one = (res, m) => {
  const hits = byMatch(res, m);
  assert.equal(hits.length, 1, `expected one ${m}, found ${hits.length}`);
  return hits[0];
};

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
}

// A layer exercising most of the model at once.
function richLayer() {
  const glowParams = (n) => [
    new Prop("Glow Radius", "ADBE Glo2-0003", PVT.OneD, n, { min: 0, max: 1000 }),
    new Prop("Color A", "ADBE Glo2-0012", PVT.COLOR, [1, 1, 1, 1]),
    new Group("Compositing Options", "ADBE Effect Built In Params", [
      new Prop("Effect Opacity", "ADBE Effect Mask Opacity", PVT.OneD, 100),
    ]),
  ];
  const effects = new Group("Effects", "ADBE Effect Parade", [
    new Group("Glow", "ADBE Glo2", glowParams(10), { isEffect: true }),
    new Group("Glow 2", "ADBE Glo2", glowParams(25), { isEffect: true, _enabled: false, canSetEnabled: true }),
    new Group("Curves", "ADBE CurvesCustom", [
      new Prop("Channel", "ADBE CurvesCustom-0002", PVT.OneD, 1, { dropdown: true, min: 1, max: 5 }),
      new Prop("Curves", "ADBE CurvesCustom-0001", PVT.CUSTOM_VALUE, null),
    ], { isEffect: true }),
    new Group("Fractal Noise", "ADBE Fractal Noise", [
      new Prop("Transform", "ADBE Fractal Noise-0007", PVT.NO_VALUE, null),
      new Prop("Rotation", "ADBE Fractal Noise-0008", PVT.OneD, 0),
      new Prop("", "ADBE Fractal Noise-0014", PVT.NO_VALUE, null),
    ], { isEffect: true }),
  ], { indexed: true });
  const masks = new Group("Masks", "ADBE Mask Parade", [
    new Group("Mask 1", "ADBE Mask Atom", [
      new Prop("Mask Path", "ADBE Mask Shape", PVT.SHAPE, { vertices: [[0, 0], [10, 0], [10, 10]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]], closed: true, featherSegLocs: [] }),
      new Prop("Mask Feather", "ADBE Mask Feather", PVT.TwoD, [0, 0], { min: 0, max: 32000, unitsText: "pixels" }),
    ], { isMask: true, maskMode: 6814, inverted: true, locked: false }),
  ], { indexed: true });
  const marker = new Prop("Marker", "ADBE Marker", PVT.MARKER, { comment: "" }, {
    canSetExpression: false,
    keys: [{ time: 1, value: { comment: "cue", duration: 0, chapter: "", url: "", label: 2, protectedRegion: false } }],
  });
  const tr = transform([
    new Prop("X Position", "ADBE Position_0", PVT.OneD, 960, { isSeparationFollower: true, separationDimension: 0, separationLeader: { matchName: "ADBE Position" } }),
    new Prop("Orientation", "ADBE Orientation", PVT.ThreeD, [0, 0, 0], { canSetExpression: false }),
  ]);
  tr.property("ADBE Position").keys = [
    { time: 0, value: [0, 0, 0], easeIn: [{ influence: 33, speed: 0 }], easeOut: [{ influence: 50, speed: 10 }], inTangent: [1, 2, 0], outTangent: [3, 4, 0], spatialContinuous: true, roving: false },
    { time: 1, value: [100, 0, 0], inType: KIT.HOLD, outType: KIT.HOLD, roving: true, label: 3 },
  ];
  tr.property("ADBE Opacity")._expression = "wiggle(";
  tr.property("ADBE Opacity").expressionEnabled = false;
  tr.property("ADBE Opacity")._expressionError = "SyntaxError: Unexpected token";
  tr.property("ADBE Scale").keys = [{ time: 0, value: [100, 100, 100], easeIn: [{ influence: 10, speed: 0 }, { influence: 20, speed: 0 }, { influence: 30, speed: 0 }], easeOut: [{ influence: 40, speed: 1 }, { influence: 50, speed: 2 }, { influence: 60, speed: 3 }] }];
  const styles = new Group("Layer Styles", "ADBE Layer Styles", [new Prop("Blend Mode", "ADBE Blend Mode", PVT.OneD, 1)]);
  return makeLayer(5, "Rich", [marker, masks, effects, tr, styles]);
}

// ---------------------------------------------------------------------------
// Addressing and bounds
// ---------------------------------------------------------------------------

check("root inspection lists the layer and its tree in timeline order", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5 });
  assert.equal(r.ok, true, r.error);
  const nodes = r.result.nodes;
  assert.deepEqual(nodes[0].path, []);
  assert.equal(nodes[0].matchName, "ADBE AV Layer");
  assert.equal(nodes[0].index, undefined, "the layer root has no propertyIndex");
  assert.deepEqual(nodes.filter((n) => n.depth === 1).map((n) => n.matchName),
    ["ADBE Marker", "ADBE Mask Parade", "ADBE Effect Parade", "ADBE Transform Group", "ADBE Layer Styles"]);
  assert.equal(r.result.truncated, false);
  assert.equal(r.result.nodesReturned, nodes.length);
});

check("a subtree is inspected from `path`, and every returned path resolves with walkProperty", () => {
  const layer = richLayer();
  const run = load([layer]);
  const r = run({ layerId: 5, path: ["ADBE Effect Parade"], depth: 3 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result.nodes[0].path, ["ADBE Effect Parade"]);
  const resolve = (p) => p.reduce((g, seg) => g.property(seg), layer);
  for (const n of r.result.nodes) assert.equal(resolve(n.path).matchName, n.matchName, JSON.stringify(n.path));
});

check("duplicate match names are disambiguated by index, with occurrence", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5, path: ["ADBE Effect Parade"], depth: 1 });
  const glows = byMatch(r, "ADBE Glo2");
  assert.deepEqual(glows.map((g) => g.path), [["ADBE Effect Parade", 1], ["ADBE Effect Parade", 2]]);
  assert.deepEqual(glows.map((g) => g.occurrence), [1, 2]);
  assert.deepEqual(one(r, "ADBE CurvesCustom").path, ["ADBE Effect Parade", "ADBE CurvesCustom"], "a unique matchName stays a matchName");
  assert.equal(one(r, "ADBE CurvesCustom").occurrence, undefined);
  assert.deepEqual(glows.map((g) => g.effect), [{ enabled: true }, { enabled: false }]);
});

check("an invalid layer and an invalid path are errors, not empty trees", () => {
  const run = load([richLayer()]);
  const a = run({ layerId: 99 });
  assert.equal(a.ok, false);
  assert.match(a.error, /No layer with id 99/);
  const b = run({ layerId: 5, path: ["ADBE Effect Parade", "Nope"] });
  assert.equal(b.ok, false);
  assert.match(b.error, /segment returned null at \[1\]=Nope/);
});

check("depth bounds the walk and says which groups were not walked", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5, depth: 1 });
  assert.ok(r.result.nodes.every((n) => n.depth <= 1));
  const fx = one(r, "ADBE Effect Parade");
  assert.equal(fx.childrenNotWalked, true);
  assert.equal(fx.childCount, 4);
  assert.ok(r.result.depthLimitedGroups >= 3);
  const zero = run({ layerId: 5, depth: 0 });
  assert.equal(zero.result.nodes.length, 1);
});

check("maxNodes stops the walk and reports where", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5, maxNodes: 4 });
  assert.equal(r.result.nodesReturned, 4);
  assert.equal(r.result.truncated, true);
  assert.equal(r.result.truncation.reason, "maxNodes");
  assert.equal(r.result.truncation.limit, 4);
  assert.ok(Array.isArray(r.result.truncation.nextUnvisited));
});

check("default-collapsed groups are listed, not expanded, and named; collapse:[] expands them", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5 });
  const styles = one(r, "ADBE Layer Styles");
  assert.equal(styles.collapsed, true);
  assert.equal(styles.childCount, 1);
  assert.deepEqual(r.result.collapsed, [["ADBE Layer Styles"]]);
  assert.equal(byMatch(r, "ADBE Blend Mode").length, 0);
  const all = run({ layerId: 5, collapse: [] });
  assert.equal(byMatch(all, "ADBE Blend Mode").length, 1);
  // …and inspecting the collapsed group by path expands it.
  assert.equal(byMatch(run({ layerId: 5, path: ["ADBE Layer Styles"] }), "ADBE Blend Mode").length, 1);
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

check("scalar, vector and colour values, with min/max and units", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5, depth: 6 });
  const op = one(r, "ADBE Opacity");
  assert.equal(op.valueType, "OneD");
  assert.equal(op.value, 100);
  assert.equal(op.min, 0);
  assert.equal(op.max, 100);
  assert.equal(op.unitsText, "percent");
  assert.deepEqual(one(r, "ADBE Scale").value, [100, 100, 100]);
  assert.equal(one(r, "ADBE Scale").valueType, "ThreeD");
  assert.deepEqual(byMatch(r, "ADBE Glo2-0012")[0].value, [1, 1, 1, 1]);
  assert.equal(byMatch(r, "ADBE Glo2-0012")[0].valueType, "COLOR");
  assert.equal(one(r, "ADBE Rotate Z").min, undefined, "no min when hasMin is false — and its throw did not escape");
  assert.equal(one(r, "ADBE CurvesCustom-0002").dropdown, true);
  assert.equal(one(r, "ADBE CurvesCustom-0002").max, 5);
});

check("Shape values serialize as vertices/tangents/closed", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5, path: ["ADBE Mask Parade"] });
  const shape = one(r, "ADBE Mask Shape");
  assert.equal(shape.valueType, "SHAPE");
  assert.deepEqual(shape.value, { closed: true, vertices: [[0, 0], [10, 0], [10, 10]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]] });
  const mask = one(r, "ADBE Mask Atom");
  assert.deepEqual(mask.mask, { inverted: true, locked: false, mode: "SUBTRACT" });
});

check("TextDocument values serialize as plain fields, justification by name", () => {
  const doc = { text: "Hi", font: "Arial", fontSize: 72, tracking: 0, leading: 80, applyFill: true, fillColor: [1, 0, 0], applyStroke: false, justification: 7415, pointText: true, boxText: false };
  const layer = makeLayer(6, "T", [new Group("Text", "ADBE Text Properties", [new Prop("Source Text", "ADBE Text Document", PVT.TEXT_DOCUMENT, doc)])]);
  const run = load([layer]);
  const r = run({ layerId: 6 });
  const st = one(r, "ADBE Text Document");
  assert.equal(st.valueType, "TEXT_DOCUMENT");
  assert.equal(st.value.text, "Hi");
  assert.equal(st.value.fontSize, 72);
  assert.deepEqual(st.value.fillColor, [1, 0, 0]);
  assert.equal(st.value.strokeColor, undefined);
  assert.equal(st.value.justification, "center");
});

check("markers: the property is listed, and with includeKeys each marker's fields", () => {
  const run = load([richLayer()]);
  const plainRead = one(run({ layerId: 5, depth: 1 }), "ADBE Marker");
  assert.equal(plainRead.valueType, "MARKER");
  assert.equal(plainRead.value, undefined, "a marker property's own value is meaningless and not reported");
  assert.equal(plainRead.numKeys, 1);
  const k = one(run({ layerId: 5, depth: 1, includeKeys: true }), "ADBE Marker").keys;
  assert.deepEqual(k, [{ index: 1, time: 1, value: { comment: "cue", duration: 0, label: 2, protectedRegion: false } }]);
});

check("unreadable values are reported with a reason, never omitted", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5, path: ["ADBE Effect Parade"], depth: 3 });
  const curves = one(r, "ADBE CurvesCustom-0001");
  assert.equal(curves.valueReadable, false);
  assert.equal(curves.valueError.category, "CUSTOM_VALUE");
  assert.equal("value" in curves, false);
  const markers = byMatch(r, "ADBE Fractal Noise-0007").concat(byMatch(r, "ADBE Fractal Noise-0014"));
  assert.equal(markers.length, 2, "both effect section markers are listed");
  for (const m of markers) {
    assert.equal(m.valueType, "NO_VALUE");
    assert.equal(m.valueReadable, false);
    assert.equal(m.valueError.category, "NO_VALUE");
  }
});

check("a value getter that throws is THREW with AE's message, and the walk continues", () => {
  const layer = richLayer();
  layer.property("ADBE Transform Group").property("ADBE Scale").valueThrows = "weird failure";
  const run = load([layer]);
  const r = run({ layerId: 5, path: ["ADBE Transform Group"] });
  const sc = one(r, "ADBE Scale");
  assert.deepEqual(sc.valueError, { category: "THREW", message: "weird failure" });
  assert.equal(one(r, "ADBE Opacity").value, 100, "the next property was still read");
});

check("an unknown valueType number is UNKNOWN(n), still read", () => {
  const layer = makeLayer(7, "VF", [new Prop("VF Axis", "ADBE Text VF Axis 1", 1489342032, 0)]);
  const r = load([layer])({ layerId: 7 });
  const n = one(r, "ADBE Text VF Axis 1");
  assert.equal(n.valueType, "UNKNOWN(1489342032)");
  assert.equal(n.value, 0);
});

check("includeValues:false reads no values but still flags the unreadable kinds", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5, depth: 6, includeValues: false });
  assert.equal(one(r, "ADBE Opacity").value, undefined);
  assert.equal(one(r, "ADBE CurvesCustom-0001").valueReadable, false);
});

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

check("expression summary: text, enabled, AE's own error", () => {
  const run = load([richLayer()]);
  const op = one(run({ layerId: 5, path: ["ADBE Transform Group"] }), "ADBE Opacity");
  assert.equal(op.expression, "wiggle(");
  assert.equal(op.expressionEnabled, false);
  assert.equal(op.expressionError, "SyntaxError: Unexpected token");
  assert.equal(one(run({ layerId: 5, path: ["ADBE Transform Group"] }), "ADBE Scale").expression, undefined, "no expression, no field");
  const off = one(run({ layerId: 5, path: ["ADBE Transform Group"], includeExpressions: false }), "ADBE Opacity");
  assert.equal(off.expression, undefined);
});

check("a broken expression accessor does not break the tree", () => {
  const layer = richLayer();
  layer.property("ADBE Transform Group").property("ADBE Opacity").expressionThrows = "Object is invalid";
  const r = load([layer])({ layerId: 5, path: ["ADBE Transform Group"] });
  assert.equal(r.ok, true, r.error);
  assert.equal(one(r, "ADBE Opacity").expressionUnreadable, "Object is invalid");
  assert.ok(one(r, "ADBE Scale"));
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

check("key summary: time, value, interpolation names, per-dimension ease, flags, label", () => {
  const r = load([richLayer()])({ layerId: 5, path: ["ADBE Transform Group"], includeKeys: true });
  const pos = one(r, "ADBE Position");
  assert.equal(pos.numKeys, 2);
  assert.equal(pos.isSpatial, true);
  assert.deepEqual(pos.keys[0], {
    index: 1, time: 0, value: [0, 0, 0], in: "linear", out: "linear",
    easeIn: [{ influence: 33, speed: 0 }], easeOut: [{ influence: 50, speed: 10 }],
    temporalContinuous: false, temporalAutoBezier: false,
    inTangent: [1, 2, 0], outTangent: [3, 4, 0], spatialContinuous: true, spatialAutoBezier: false, roving: false,
  });
  assert.equal(pos.keys[1].in, "hold");
  assert.equal(pos.keys[1].roving, true);
  assert.equal(pos.keys[1].label, 3);
  const sc = one(r, "ADBE Scale");
  assert.equal(sc.keys[0].easeIn.length, 3, "every dimension's ease, not just the first");
  assert.deepEqual(sc.keys[0].easeOut.map((e) => e.influence), [40, 50, 60]);
  assert.equal(sc.keys[0].inTangent, undefined, "no spatial fields on a non-spatial property");
  assert.equal(load([richLayer()])({ layerId: 5, path: ["ADBE Transform Group"] }).result.nodes.find((n) => n.matchName === "ADBE Position").keys, undefined, "keys only on request");
});

check("maxKeysPerProperty keeps first and last and counts the rest", () => {
  const layer = richLayer();
  layer.property("ADBE Transform Group").property("ADBE Rotate Z").keys = Array.from({ length: 25 }, (_, i) => ({ time: i, value: i * 10 }));
  const r = load([layer])({ layerId: 5, path: ["ADBE Transform Group"], includeKeys: true, maxKeysPerProperty: 4 });
  const rot = one(r, "ADBE Rotate Z");
  assert.deepEqual(rot.keys.map((k) => k.index), [1, 2, 24, 25]);
  assert.equal(rot.keysOmitted, 21);
  assert.match(rot.keysTruncated, /raise maxKeysPerProperty/);
});

// ---------------------------------------------------------------------------
// Separation, hidden
// ---------------------------------------------------------------------------

check("separated dimensions: leader and follower metadata, and the follower's throw contained", () => {
  const r = load([richLayer()])({ layerId: 5, path: ["ADBE Transform Group"] });
  assert.deepEqual(one(r, "ADBE Position").separation, { role: "leader" });
  assert.deepEqual(one(r, "ADBE Position_0").separation, { role: "follower", dimension: 0, leader: "ADBE Position" });
  assert.deepEqual(one(r, "ADBE Position_0").path, ["ADBE Transform Group", "ADBE Position_0"]);
  assert.equal(one(r, "ADBE Opacity").separation, undefined);
});

check("hidden is flagged on canSetExpression:false + canVaryOverTime, and includeHidden:false omits and counts it", () => {
  const run = load([richLayer()]);
  const r = run({ layerId: 5, path: ["ADBE Transform Group"] });
  assert.equal(one(r, "ADBE Orientation").hidden, true);
  assert.equal(one(r, "ADBE Opacity").hidden, undefined);
  const lean = run({ layerId: 5, path: ["ADBE Transform Group"], includeHidden: false });
  assert.equal(byMatch(lean, "ADBE Orientation").length, 0);
  assert.equal(lean.result.hiddenOmitted, 1);
  assert.match(lean.result.hiddenNote, /includeHidden was false/);
});

check("hidden is never claimed outside the measured value types (a Marker is writable)", () => {
  const r = load([richLayer()])({ layerId: 5, depth: 1 });
  const m = one(r, "ADBE Marker");
  assert.equal(m.canSetExpression, false);
  assert.equal(m.hidden, undefined);
  const layer = makeLayer(11, "Odd", [
    new Prop("Mask Ref", "X Mask", PVT.MASK_INDEX, 0, { canSetExpression: false }),
    new Prop("Layer Ref", "X Layer", PVT.LAYER_INDEX, 0, { canSetExpression: false }),
    new Prop("Doc", "X Doc", PVT.TEXT_DOCUMENT, { text: "" }, { canSetExpression: false }),
  ]);
  const o = load([layer])({ layerId: 11 });
  for (const n of o.result.nodes.slice(1)) assert.equal(n.hidden, undefined, n.matchName);
});

// ---------------------------------------------------------------------------
// The structures A2 exists for
// ---------------------------------------------------------------------------

check("nested effect group (Compositing Options) is walked, not dropped", () => {
  const r = load([richLayer()])({ layerId: 5, path: ["ADBE Effect Parade"], depth: 3 });
  const opts = byMatch(r, "ADBE Effect Built In Params");
  assert.equal(opts.length, 2);
  assert.deepEqual(opts[1].path, ["ADBE Effect Parade", 2, "ADBE Effect Built In Params"]);
  assert.equal(byMatch(r, "ADBE Effect Mask Opacity").length, 2);
});

check("text animator subtree: Animators > Animator > Selectors / Properties", () => {
  const animator = new Group("Animator 1", "ADBE Text Animator", [
    new Group("Selectors", "ADBE Text Selectors", [
      new Group("Range Selector 1", "ADBE Text Selector", [
        new Prop("Start", "ADBE Text Percent Start", PVT.OneD, 10),
        new Prop("End", "ADBE Text Percent End", PVT.OneD, 60),
      ]),
    ], { indexed: true }),
    new Group("Properties", "ADBE Text Animator Properties", [
      new Prop("Position", "ADBE Text Position 3D", PVT.ThreeD, [0, -40, 0]),
      new Prop("Opacity", "ADBE Text Opacity", PVT.OneD, 100, { canSetExpression: false }),
    ]),
  ]);
  const layer = makeLayer(8, "Kinetic", [new Group("Text", "ADBE Text Properties", [new Group("Animators", "ADBE Text Animators", [animator], { indexed: true })])]);
  const r = load([layer])({ layerId: 8, depth: 6 });
  const start = one(r, "ADBE Text Percent Start");
  assert.deepEqual(start.path, ["ADBE Text Properties", "ADBE Text Animators", "ADBE Text Animator", "ADBE Text Selectors", "ADBE Text Selector", "ADBE Text Percent Start"]);
  assert.equal(start.value, 10);
  assert.equal(one(r, "ADBE Text Opacity").hidden, true, "an inert slot is flagged");
  assert.equal(one(r, "ADBE Text Position 3D").hidden, undefined);
});

check("camera options and light options subtrees are discovered generically", () => {
  const cam = makeLayer(9, "Cam", [transform(), new Group("Camera Options", "ADBE Camera Options Group", [
    new Prop("Zoom", "ADBE Camera Zoom", PVT.OneD, 888.89, { unitsText: "pixels" }),
    new Prop("Depth of Field", "ADBE Camera Depth of Field", PVT.OneD, 0),
    new Prop("Focus Distance", "ADBE Camera Focus Distance", PVT.OneD, 888.89),
    new Prop("Aperture", "ADBE Camera Aperture", PVT.OneD, 25.3),
  ])]);
  const light = makeLayer(10, "Light", [transform(), new Group("Light Options", "ADBE Light Options Group", [
    new Prop("Intensity", "ADBE Light Intensity", PVT.OneD, 100),
    new Prop("Color", "ADBE Light Color", PVT.COLOR, [1, 1, 1, 1]),
    new Prop("Cone Angle", "ADBE Light Cone Angle", PVT.OneD, 90),
    new Prop("Cone Feather", "ADBE Light Cone Feather 2", PVT.OneD, 50),
  ])]);
  const run = load([cam, light]);
  const c = run({ layerId: 9, path: ["ADBE Camera Options Group"] });
  assert.deepEqual(c.result.nodes.slice(1).map((n) => n.name), ["Zoom", "Depth of Field", "Focus Distance", "Aperture"]);
  assert.deepEqual(one(c, "ADBE Camera Zoom").path, ["ADBE Camera Options Group", "ADBE Camera Zoom"]);
  const l = run({ layerId: 10, path: ["ADBE Light Options Group"] });
  assert.deepEqual(one(l, "ADBE Light Color").value, [1, 1, 1, 1]);
  assert.equal(one(l, "ADBE Light Cone Feather 2").value, 50);
});

// ---------------------------------------------------------------------------
// Read-only, classification, input validation
// ---------------------------------------------------------------------------

check("zero mutation: no setter, no add, no undo group, across every option", () => {
  const run = load([richLayer()]);
  for (const extra of [{}, { includeKeys: true, depth: 8, collapse: [] }, { includeHidden: false }, { includeValues: false }]) {
    const r = run({ layerId: 5, ...extra });
    assert.equal(r.ok, true, r.error);
  }
  assert.equal(writes, 0, "the mock recorded a write");
});

check("classified read, and parsed with defaults applied", () => {
  assert.equal(schemas.OpMutation.inspect_property_tree, "read");
  const a = parseOpArgs("inspect_property_tree", { compId: 1, layerId: 2 });
  assert.deepEqual(
    { depth: a.depth, maxNodes: a.maxNodes, includeValues: a.includeValues, includeKeys: a.includeKeys, includeExpressions: a.includeExpressions, maxKeysPerProperty: a.maxKeysPerProperty, includeHidden: a.includeHidden },
    { depth: 4, maxNodes: 250, includeValues: true, includeKeys: false, includeExpressions: true, maxKeysPerProperty: 10, includeHidden: true }
  );
  assert.deepEqual(schemas.INSPECT_DEFAULT_COLLAPSE, ["ADBE Layer Styles", "ADBE Material Options Group", "ADBE Extrsn Options Group", "ADBE Plane Options Group", "ADBE Vector Materials Group"]);
});

check("strict input: unknown keys, out-of-range bounds and missing ids are refused, also inside a batch", () => {
  for (const bad of [
    { compId: 1, layerId: 2, dpeth: 3 },
    { compId: 1, layerId: 2, depth: 13 },
    { compId: 1, layerId: 2, maxNodes: 0 },
    { compId: 1, layerId: 2, maxNodes: 2001 },
    { compId: 1, layerId: 2, path: [] },
    { compId: 1 },
  ]) {
    assert.throws(() => parseOpArgs("inspect_property_tree", bad), JSON.stringify(bad));
  }
  assert.throws(() => validateBatchOps([{ op: "inspect_property_tree", args: { compId: 1, layerId: 2, dpeth: 3 } }]), /step 0 \(inspect_property_tree\)/);
});

console.log(`inspect-property-tree: ${passed} checks passed`);
