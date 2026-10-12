// set_keyframes — bulk keyframe animation at the paths inspect_property_tree
// returns, across properties and layers, all-or-nothing.
//
// The handler runs unmodified in a vm against a keyframe-capable mock of the
// After Effects property model, built from what AE 26.5x89 was measured to do
// (docs/fragile-areas-ae.md, "Keyframe writes"):
//   * a key time is stored the way recipe 61 measured — float32, then the
//     comp's key-time step (24576/s for the 24 family, 25600/s for 25, 30720/s
//     for 30, 23976/s for every NTSC rate), scaled by the layer's stretch; a
//     time stored on an existing key updates it; a new key copies its neighbour's
//     interpolation; setValueAtTime / setValuesAtTimes keep an existing key's
//     metadata;
//   * setting an ease turns both sides Bezier and auto-Bezier off; temporal
//     continuous turns both sides Bezier and copies the in speed out; temporal
//     auto-Bezier recomputes the ease and forces continuous; Linear resets
//     continuous; explicit spatial tangents turn spatial auto-Bezier off;
//   * ease arrays must have exactly the property's arity; KeyframeEase refuses
//     influence outside 0.1..100; spatial calls throw on non-spatial types;
//     Orientation tangents rewrite the value; first/last keys ignore roving;
//   * removing a Time Remap's last key turns Time Remap off (then hidden);
//   * a mask path written with keys of different vertex/feather counts raises
//     AE's modal "Preserve Constant Vertex and Feather Count" warning — here
//     recorded and thrown, so a test can see it was (not) reached.
// inspect_property_tree runs in the same context, so "a path it returns is
// accepted unchanged" is asserted on the real pair.
//
//   node tests/unit/set-keyframes.mjs

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
const { descriptions } = await import(pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "tools", "descriptions.js")).href);

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
const KIT = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
const SHAPE_FIELDS = ["vertices", "inTangents", "outTangents", "closed", "featherSegLocs", "featherRelSegLocs", "featherRadii", "featherTypes", "featherInterps", "featherTensions", "featherRelCornerAngles"];
// After Effects' key-time storage, as recipe 61 measured it: steps per second
// are the integer frame rate doubled while that stays at most 32768 (12, 24,
// 48 → 24576; 25, 50, 100 → 25600; 15, 30, 60, 120 → 30720; 1 → 32768; 10 →
// 20480), and 23976 for every NTSC rate (23.976, 29.97, 47.952, 59.94, 119.88,
// whose frameDurations AE makes 1/23.976, 1/29.97, …: 1000, 800, 500, 400, 200
// steps a frame). The
// time is rounded to float32 first, and the grid follows the layer's stretch
// (start time does not move it). Rates outside both families store exactly.
function keyStepFor(fd) {
  const F = 1 / fd;
  if (Math.abs(F - Math.round(F)) < 1e-9) { let S = Math.round(F); while (S * 2 <= 32768) S *= 2; return 1 / S; }
  const n = 23976 * fd;                       // whole steps a frame at NTSC rates
  if (Math.abs(n - Math.round(n)) < 1e-6) return 1 / 23976;
  return null;
}
// A write is recorded only on the user's comp: the key-time oracle's scratch
// comp is not user content, and "nothing was written" means to the user's
// properties. Every scratch comp is checked for removal separately.
function layerOf(node) { let l = node; while (l && !l.__kind) l = l.parent; return l; }
function logWrite(node, entry) { const l = layerOf(node); if (!(l && l.__comp && l.__comp.__scratch)) writes.push(entry); }
function storedTime(node, t) {
  const layer = layerOf(node);
  const fd = layer && layer.__comp ? layer.__comp.frameDuration : null;
  const q = fd ? keyStepFor(fd) : null;
  if (!q) return t;
  const sx = (layer.stretch ?? 100) / 100;
  const g = Math.round(Math.fround(t / sx) / q) * q;
  // On a stretched layer the mapped-back time is rounded again, which (like
  // After Effects on stretched layers far from 0, recipe 61) can move a stored
  // time when it is written a second time. Monotone, so it can be searched.
  return sx === 1 ? g : Math.fround(g * sx);
}
const SPATIAL = [PVT.TwoD_SPATIAL, PVT.ThreeD_SPATIAL];

let writes = [];   // every value-writing AE call, in order: [matchName, method]
let modals = [];   // modal warnings the mask model raised
let undoOpened = 0, undoClosed = 0, saved = 0;
let ShapeCtor = null;

class Node {
  get propertyIndex() { return this.parent ? this.parent.children.indexOf(this) + 1 : undefined; }
  get propertyDepth() { return this.parent ? this.parent.propertyDepth + 1 : 0; }
  get parentProperty() { return this.parent ?? null; }
  active = true; elided = false; isModified = false; isEffect = false; isMask = false; canSetEnabled = false; enabled = true;
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

const easeDims = (vt) => (vt === PVT.TwoD ? 2 : vt === PVT.ThreeD ? 3 : 1);
const zeroT = (vt) => (vt === PVT.ThreeD_SPATIAL ? [0, 0, 0] : [0, 0]);
const counts = (s) => [s.vertices.length, (s.featherSegLocs ?? []).length].join("/");

class Prop extends Node {
  constructor(name, matchName, vt, value, o = {}) {
    super();
    Object.assign(this, { name, matchName, propertyType: PT.PROPERTY, propertyValueType: vt });
    this._static = value;
    this.keys = [];
    this.canSetExpression = o.canSetExpression ?? true;
    this.canVaryOverTime = o.canVaryOverTime ?? true;
    this.expression = o.expression ?? "";
    this.expressionEnabled = o.expressionEnabled ?? !!o.expression;
    this.evaluate = o.evaluate ?? null;
    this.isSpatial = SPATIAL.includes(vt) || vt === PVT.COLOR || vt === PVT.SHAPE; // AE's own claim
    this.dimensionsSeparated = false; this.isSeparationLeader = false; this.isSeparationFollower = false;
    this.hasMin = o.min !== undefined; this.hasMax = o.max !== undefined; this.minValue = o.min; this.maxValue = o.max;
    this.isDropdownEffect = !!o.dropdown;
    this.flatZ = o.flatZ ?? null;    // a 2D layer: AE stores this Z in every key (0 on Position, 100 on Scale)
    this.fail = o.fail ?? {};        // { method: message } — a runtime refusal nothing predicts
    this.ignore = o.ignore ?? {};    // { method: true } — accepts the call and keeps nothing
    this.onRemoveLast = o.onRemoveLast ?? null;
  }
  get numKeys() { return this.keys.length; }
  _guard(method) {
    if (this.propertyValueType === PVT.NO_VALUE) throw new Error("Can not get or set a value from this property.");
    if (this.propertyValueType === PVT.CUSTOM_VALUE) throw new Error("This propertyValueType CUSTOM_VALUE has not been implemented.");
    if (!this.canVaryOverTime && method !== "setValue") throw new Error("Can not perform any keyframe operations on this property because canVaryOverTime is false.");
    if (!this.canSetExpression && this.canVaryOverTime) throw new Error("Can not “set value at time” with this property, because the property or a parent property is hidden.");
    if (this.fail[method]) throw new Error(this.fail[method]);
  }
  _k(k) { const key = this.keys[k - 1]; if (!key) throw new Error("Can not operations on keys for this property because it has no keyframes."); return key; }
  _copy(v) {
    if (this.propertyValueType !== PVT.SHAPE) return clone(v);
    const s = new ShapeCtor();
    for (const f of SHAPE_FIELDS) s[f] = clone(v[f] ?? (f === "closed" ? true : []));
    return s;
  }
  _store(v) {
    if (this.propertyValueType === PVT.SHAPE) return Object.fromEntries(SHAPE_FIELDS.map((f) => [f, clone(v[f] ?? (f === "closed" ? true : []))]));
    const vt = this.propertyValueType;
    const vector = [PVT.TwoD, PVT.TwoD_SPATIAL, PVT.ThreeD, PVT.ThreeD_SPATIAL, PVT.COLOR].includes(vt);
    if (vector && !Array.isArray(v)) throw new Error("Value is not an array.");
    if (!vector && typeof v !== "number") throw new Error("Array is not a number.");
    for (const n of Array.isArray(v) ? v : [v]) {
      if ((this.hasMin && n < this.minValue) || (this.hasMax && n > this.maxValue)) throw new Error(`Value ${n} out of range ${this.minValue} to ${this.maxValue}.`);
    }
    const out = clone(v);
    if (this.flatZ !== null) out[2] = this.flatZ;
    return out;
  }
  _freshKey(t, v, neighbour) {
    const d = easeDims(this.propertyValueType);
    const key = {
      time: t, value: v,
      inI: neighbour ? neighbour.inI : KIT.LINEAR, outI: neighbour ? neighbour.outI : KIT.LINEAR,   // a new key copies its neighbour
      easeIn: Array.from({ length: d }, () => ({ speed: 0, influence: 16.666666667 })),
      easeOut: Array.from({ length: d }, () => ({ speed: 0, influence: 16.666666667 })),
      tc: false, tab: false, label: 0,
    };
    if (SPATIAL.includes(this.propertyValueType)) Object.assign(key, { inT: zeroT(this.propertyValueType), outT: zeroT(this.propertyValueType), sc: true, sab: !!(neighbour && neighbour.sab), roving: false });
    return key;
  }
  _maskCheck() {
    if (this.matchName !== "ADBE Mask Shape" || this.keys.length < 2) return;
    const c0 = counts(this.keys[0].value);
    if (this.keys.some((k) => counts(k.value) !== c0)) {
      modals.push("Preserve Constant Vertex and Feather Count");
      throw new Error("MODAL: After Effects warning: deleting points or feathers from an animated mask path deletes them from all keyframes for that shape");
    }
  }
  // values
  get value() {
    const raw = this.keys.length ? this._copy(this.keys[0].value) : this._copy(this._static);
    return this.expression && this.expressionEnabled && this.evaluate ? this.evaluate(raw) : raw;
  }
  valueAtTime(t, pre) {
    let raw;
    if (!this.keys.length) raw = this._copy(this._static);
    else {
      let k = this.keys[0];
      for (const key of this.keys) if (key.time <= t + 1e-9) k = key;
      raw = this._copy(k.value);
    }
    return !pre && this.expression && this.expressionEnabled && this.evaluate ? this.evaluate(raw) : raw;
  }
  setValue(v) {
    logWrite(this, [this.matchName, "setValue"]);
    this._guard("setValue");
    if (this.keys.length) throw new Error("Can not call setValue() on a property with keyframes.");
    this._static = this._store(v);
  }
  setValueAtTime(t, v) {
    logWrite(this, [this.matchName, "setValueAtTime"]);
    this._guard("setValueAtTime");
    const stored = this._store(v);
    t = storedTime(this, t);
    const at = this.keys.findIndex((k) => k.time === t);
    if (at >= 0) this.keys[at].value = stored;
    else {
      let i = this.keys.findIndex((k) => k.time > t);
      if (i < 0) i = this.keys.length;
      const neighbour = this.keys[i - 1] ?? this.keys[i];
      this.keys.splice(i, 0, this._freshKey(t, stored, neighbour));
    }
    this._maskCheck();
  }
  setValuesAtTimes(times, values) {
    if (times.length !== values.length) throw new Error(`Value array does not have ${times.length} elements.`);
    for (let i = 0; i < times.length; i++) this.setValueAtTime(times[i], values[i]);
  }
  setValueAtKey(k, v) { logWrite(this, [this.matchName, "setValueAtKey"]); this._guard("setValueAtKey"); this._k(k).value = this._store(v); this._maskCheck(); }
  removeKey(k) {
    logWrite(this, [this.matchName, "removeKey"]);
    this._k(k);
    this.keys.splice(k - 1, 1);
    if (!this.keys.length && this.onRemoveLast) this.onRemoveLast(this);
  }
  keyTime(k) { return this._k(k).time; }
  keyValue(k) {
    const v = this._copy(this._k(k).value);
    // Measured (recipe 61): on a stretched layer After Effects can read a key's
    // value back a hair off — Rotation 2 at 599.37 s, stretch 61%, read
    // 1.99999986734146. Reproduced on scratch-comp layers, where the key-time
    // oracle reads its own marker values.
    const l = layerOf(this);
    if (typeof v === "number" && l && l.__comp && l.__comp.__scratch && (l.stretch ?? 100) !== 100) return v * (1 - 6.6e-8);
    return v;
  }
  nearestKeyIndex(t) {
    let best = 1, d = Infinity;
    this.keys.forEach((k, i) => { if (Math.abs(k.time - t) < d) { d = Math.abs(k.time - t); best = i + 1; } });
    return best;
  }
  // temporal
  keyInInterpolationType(k) { return this._k(k).inI; }
  keyOutInterpolationType(k) { return this._k(k).outI; }
  setInterpolationTypeAtKey(k, i, o = i) {
    logWrite(this, [this.matchName, "setInterpolationTypeAtKey"]);
    if (this.ignore.setInterpolationTypeAtKey) return;
    const key = this._k(k);
    key.inI = i; key.outI = o;
    if (i !== KIT.BEZIER || o !== KIT.BEZIER) { key.tc = false; key.tab = false; }   // Linear resets continuous
  }
  keyInTemporalEase(k) { return this._k(k).easeIn.map((e) => ({ ...e })); }
  keyOutTemporalEase(k) { return this._k(k).easeOut.map((e) => ({ ...e })); }
  setTemporalEaseAtKey(k, a, b) {
    logWrite(this, [this.matchName, "setTemporalEaseAtKey"]);
    if (this.fail.setTemporalEaseAtKey) throw new Error(this.fail.setTemporalEaseAtKey);
    const d = easeDims(this.propertyValueType);
    if (a.length !== d || b.length !== d) throw new Error(`Unable to call “setTemporalEaseAtKey” because of parameter 2. Value array does not have ${d} elements.`);
    const key = this._k(k);
    if (this.ignore.setTemporalEaseAtKey) return;
    key.easeIn = Array.from(a, (e) => ({ speed: e.speed, influence: e.influence }));
    key.easeOut = Array.from(b, (e) => ({ speed: e.speed, influence: e.influence }));
    key.inI = KIT.BEZIER; key.outI = KIT.BEZIER; key.tab = false;   // an ease makes the key Bezier and not auto
  }
  keyTemporalContinuous(k) { return this._k(k).tc; }
  keyTemporalAutoBezier(k) { return this._k(k).tab; }
  setTemporalContinuousAtKey(k, b) {
    logWrite(this, [this.matchName, "setTemporalContinuousAtKey"]);
    const key = this._k(k);
    key.tc = b;
    if (b) { key.inI = KIT.BEZIER; key.outI = KIT.BEZIER; key.easeOut = key.easeOut.map((e, i) => ({ speed: key.easeIn[i].speed, influence: e.influence })); }
  }
  setTemporalAutoBezierAtKey(k, b) {
    logWrite(this, [this.matchName, "setTemporalAutoBezierAtKey"]);
    const key = this._k(k);
    key.tab = b;
    if (b) { key.tc = true; key.inI = KIT.BEZIER; key.outI = KIT.BEZIER; key.easeIn = key.easeIn.map(() => ({ speed: 7, influence: 16.666666667 })); key.easeOut = key.easeOut.map(() => ({ speed: 7, influence: 16.666666667 })); }
  }
  // spatial
  _sp() { if (!SPATIAL.includes(this.propertyValueType)) throw new Error("This property does not have a spatial PropertyValueType (ThreeD_SPATIAL or TwoD_SPATIAL)."); }
  keyInSpatialTangent(k) { this._sp(); return clone(this._k(k).inT); }
  keyOutSpatialTangent(k) { this._sp(); return clone(this._k(k).outT); }
  keySpatialContinuous(k) { this._sp(); return this._k(k).sc; }
  keySpatialAutoBezier(k) { this._sp(); return this._k(k).sab; }
  keyRoving(k) { this._sp(); return this._k(k).roving; }
  setSpatialTangentsAtKey(k, a, b) {
    logWrite(this, [this.matchName, "setSpatialTangentsAtKey"]);
    this._sp();
    const n = this.propertyValueType === PVT.ThreeD_SPATIAL ? 3 : 2;
    if (a.length !== n || b.length !== n) throw new Error(`Value array does not have ${n} elements.`);
    const key = this._k(k);
    key.inT = clone(a); key.outT = clone(b); key.sab = false;
    if (this.matchName === "ADBE Orientation") key.value = [key.value[0], 350, 10];   // measured: the value is rewritten
  }
  setSpatialAutoBezierAtKey(k, b) { logWrite(this, [this.matchName, "setSpatialAutoBezierAtKey"]); this._sp(); const key = this._k(k); key.sab = b; if (b) { key.inT = [-33.3333320617676, 0, 0].slice(0, key.inT.length); key.outT = [33.3333320617676, 0, 0].slice(0, key.outT.length); } }
  setSpatialContinuousAtKey(k, b) { logWrite(this, [this.matchName, "setSpatialContinuousAtKey"]); this._sp(); this._k(k).sc = b; }
  setRovingAtKey(k, b) { logWrite(this, [this.matchName, "setRovingAtKey"]); this._sp(); if (k === 1 || k === this.keys.length) return; this._k(k).roving = b; }
  keyLabel(k) { return this._k(k).label; }
  setLabelAtKey(k, n) {
    logWrite(this, [this.matchName, "setLabelAtKey"]);
    if (n < 0 || n > 16) throw new Error(`Value ${n} out of range 0 to 16.`);
    if (this.ignore.setLabelAtKey) return;
    this._k(k).label = n;
  }
}

/** Keys straight into the model (a fixture's existing animation), no write logged. */
function seed(p, specs) {
  p.keys = specs.map((s) => {
    const key = p._freshKey(s.t, clone(s.v), null);
    return Object.assign(key, s.meta ?? {});
  });
}

function makeLayer(id, name, children, { threeD = false, kind = "av", lightType } = {}) {
  const layer = new Group(name, "ADBE AV Layer", children);
  Object.assign(layer, { id, threeDLayer: threeD, __kind: kind, lightType, startTime: 0, stretch: 100 });
  return layer;
}

function transform({ threeD = false } = {}) {
  return new Group("Transform", "ADBE Transform Group", [
    new Prop("Anchor Point", "ADBE Anchor Point", PVT.ThreeD_SPATIAL, [0, 0, 0], { flatZ: threeD ? null : 0 }),
    new Prop("Position", "ADBE Position", PVT.ThreeD_SPATIAL, [960, 540, 0], { flatZ: threeD ? null : 0 }),
    new Prop("Scale", "ADBE Scale", PVT.ThreeD, [100, 100, 100], { flatZ: threeD ? null : 100 }),
    new Prop("Orientation", "ADBE Orientation", PVT.ThreeD_SPATIAL, [0, 0, 0], { canSetExpression: threeD }),
    new Prop("X Rotation", "ADBE Rotate X", PVT.OneD, 0, { canSetExpression: threeD }),
    new Prop("Rotation", "ADBE Rotate Z", PVT.OneD, 0),
    new Prop("Opacity", "ADBE Opacity", PVT.OneD, 100, { min: 0, max: 100 }),
  ]);
}

function glow(radius) {
  return new Group("Glow", "ADBE Glo2", [
    new Prop("Glow Based On", "ADBE Glo2-0001", PVT.OneD, 2, { dropdown: true, min: 1, max: 2 }),
    new Prop("Glow Radius", "ADBE Glo2-0003", PVT.OneD, radius, { min: 0, max: 1000 }),
    new Prop("Color A", "ADBE Glo2-0012", PVT.COLOR, [1, 1, 1, 1]),
  ], { isEffect: true });
}

function square(o, feather) {
  const s = { vertices: [[o, o], [100 + o, o], [100 + o, 100 + o], [o, 100 + o]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], closed: true };
  if (feather) s.feather = { segLocs: [1], relSegLocs: [0.5], radii: [12], types: [0], interps: [0], tensions: [0], relCornerAngles: [0] };
  return s;
}

/** A 2D shape layer carrying most of what the tool has to handle. */
function richLayer() {
  const effects = new Group("Effects", "ADBE Effect Parade", [
    glow(10),
    glow(25),
    new Group("Curves", "ADBE CurvesCustom", [new Prop("Curves", "ADBE CurvesCustom-0001", PVT.CUSTOM_VALUE, null)], { isEffect: true }),
    new Group("Fractal Noise", "ADBE Fractal Noise", [new Prop("Transform", "ADBE Fractal Noise-0007", PVT.NO_VALUE, null, { canSetExpression: false, canVaryOverTime: false })], { isEffect: true }),
    new Group("Stroke", "ADBE Stroke", [new Prop("Path", "ADBE Stroke-0001", PVT.MASK_INDEX, 0, { canSetExpression: false, canVaryOverTime: false })], { isEffect: true }),
    new Group("Slider", "ADBE Slider Control", [new Prop("Slider", "ADBE Slider Control-0001", PVT.OneD, 0, { canVaryOverTime: false })], { isEffect: true }),
  ], { indexed: true });
  const masks = new Group("Masks", "ADBE Mask Parade", [
    new Group("Mask 1", "ADBE Mask Atom", [
      new Prop("Mask Path", "ADBE Mask Shape", PVT.SHAPE, { ...square(0), featherSegLocs: [], featherRelSegLocs: [], featherRadii: [], featherTypes: [], featherInterps: [], featherTensions: [], featherRelCornerAngles: [] }),
    ], { isMask: true }),
  ], { indexed: true });
  const contents = new Group("Contents", "ADBE Root Vectors Group", [
    new Group("Group 1", "ADBE Vector Group", [
      new Group("Contents", "ADBE Vectors Group", [
        new Group("Rectangle Path 1", "ADBE Vector Shape - Rect", [new Prop("Size", "ADBE Vector Rect Size", PVT.TwoD, [100, 100], { min: 0 })]),
        new Group("Path 1", "ADBE Vector Shape - Group", [new Prop("Path", "ADBE Vector Shape", PVT.SHAPE, square(0))]),
        new Group("Fill 1", "ADBE Vector Graphic - Fill", [new Prop("Color", "ADBE Vector Fill Color", PVT.COLOR, [1, 0, 0, 1])]),
      ]),
    ]),
  ]);
  const text = new Group("Text", "ADBE Text Properties", [new Prop("Source Text", "ADBE Text Document", PVT.TEXT_DOCUMENT, { text: "hi" })]);
  const marker = new Prop("Marker", "ADBE Marker", PVT.MARKER, {}, { canSetExpression: false });
  return makeLayer(5, "Rich", [marker, text, contents, masks, effects, transform()]);
}

function cameraLayer() {
  const tr = transform({ threeD: true });
  return makeLayer(6, "Cam", [tr, new Group("Camera Options", "ADBE Camera Options Group", [
    new Prop("Zoom", "ADBE Camera Zoom", PVT.OneD, 888.89, { min: 1 }),
    new Prop("Focus Distance", "ADBE Camera Focus Distance", PVT.OneD, 888.89, { min: 1 }),
  ])], { kind: "camera" });
}

function lightLayer() {
  return makeLayer(7, "Light", [transform({ threeD: true }), new Group("Light Options", "ADBE Light Options Group", [
    new Prop("Intensity", "ADBE Light Intensity", PVT.OneD, 100),
    new Prop("Color", "ADBE Light Color", PVT.COLOR, [1, 1, 1, 1]),
  ])], { kind: "light", lightType: "SPOT" });
}

function textLayer() {
  const animator = new Group("Animator 1", "ADBE Text Animator", [
    new Group("Properties", "ADBE Text Animator Properties", [
      new Prop("Position", "ADBE Text Position 3D", PVT.ThreeD_SPATIAL, [0, 0, 0]),
      new Prop("Opacity", "ADBE Text Opacity", PVT.OneD, 100, { canSetExpression: false, min: 0, max: 100 }),
    ]),
  ]);
  return makeLayer(8, "Kinetic", [new Group("Text", "ADBE Text Properties", [new Group("Animators", "ADBE Text Animators", [animator], { indexed: true })]), transform()]);
}

function precompLayer() {
  const remap = new Prop("Time Remap", "ADBE Time Remapping", PVT.OneD, 0, { min: 0, max: 5, onRemoveLast: (p) => { p.canSetExpression = false; } });
  seed(remap, [{ t: 0, v: 0 }, { t: 5, v: 5 }]);
  return makeLayer(9, "Pre", [remap, transform()]);
}

function load(layers, { fps = 24, frameDuration, duration = 20, displayStartTime = 0 } = {}) {
  writes = []; modals = []; undoOpened = 0; undoClosed = 0; saved = 0;
  const ctx = {
    app: {
      beginUndoGroup: () => { undoOpened++; },
      endUndoGroup: () => { undoClosed++; },
      project: {
        items: { addComp: (...a) => ctx.__addComp(...a) },
        itemByID: (id) => ctx.__items[id] ?? (() => { throw new Error("internal verification failure, sorry! {Item Not Found}"); })(),
        save: () => { saved++; },
      },
    },
    __items: {},
    PropertyType: PT,
    PropertyValueType: PVT,
    KeyframeInterpolationType: KIT,
    MaskMode: { NONE: 6812, ADD: 6813 },
    ParagraphJustification: { LEFT_JUSTIFY: 7413 },
    LightType: { PARALLEL: 4412, SPOT: 4413, POINT: 4414, AMBIENT: 4415 },
  };
  vm.createContext(ctx);
  vm.runInContext(
    "function CompItem(){} function Shape(){}" +
      "function KeyframeEase(speed, influence){ if (!(influence >= 0.1 && influence <= 100)) throw new Error('Unable to call “Constructor” because of parameter 2. Value ' + influence + ' out of range 0.1 to 100.'); this.speed = speed; this.influence = influence; }",
    ctx
  );
  ShapeCtor = vm.runInContext("Shape", ctx);
  ctx.__kind = (k) => ({ [Symbol.hasInstance]: (o) => !!o && o.__kind === k });
  vm.runInContext("var AVLayer = __kind('av'), CameraLayer = __kind('camera'), LightLayer = __kind('light');", ctx);
  for (const l of layers) if (l.__kind === "light") l.lightType = ctx.LightType[l.lightType];
  for (const f of ["core.jsx", "ids.jsx", "comps.jsx", "transforms.jsx", "keyframes.jsx", "expressions.jsx", "text.jsx", "explore.jsx", "inspect.jsx", "propwrite.jsx", "keywrite.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const comp = vm.runInContext("new CompItem()", ctx);
  Object.assign(comp, {
    id: 1, name: "MCP Test", time: 0, numLayers: layers.length, layer: (i) => layers[i - 1],
    frameRate: Math.fround(fps), frameDuration: frameDuration ?? 1 / fps, duration, displayStartTime,
  });
  ctx.__items[1] = comp;
  for (const l of layers) l.__comp = comp;
  // Scratch comps (the key-time oracle): every one is recorded, so a test can
  // see each was removed again.
  ctx.__scratch = [];
  // Faults to inject: scratchRemove "throw" (remove() raises) or "noop" (accepted,
  // item stays); scratchAddTextFails makes the oracle's set-up fail.
  ctx.__fault = { scratchRemove: null, scratchAddTextFails: false };
  ctx.__addComp = (name, w, h, par, dur, fps) => {
    const sc = vm.runInContext("new CompItem()", ctx);
    const own = [];
    Object.assign(sc, {
      id: 9000 + ctx.__scratch.length, name, duration: dur, frameDuration: 1 / fps, frameRate: fps, removed: false, __scratch: true,
      get numLayers() { return own.length; }, layer: (i) => own[i - 1],
      layers: { addText: (n) => {
        if (ctx.__fault.scratchAddTextFails) throw new Error("After Effects error: addText failed (stub)");
        const tl = makeLayer(9500 + own.length, n, [transform()], { kind: "text" }); tl.__comp = sc; own.push(tl); return tl;
      } },
      remove() {
        if (ctx.__fault.scratchRemove === "throw") throw new Error("After Effects error: remove refused (stub)");
        if (ctx.__fault.scratchRemove === "noop") return;
        this.removed = true; delete ctx.__items[this.id];
      },
    });
    ctx.__scratch.push(sc);
    ctx.__items[sc.id] = sc;
    return sc;
  };
  const dispatch = vm.runInContext("dispatch", ctx);
  const call = (op, args) => plain(dispatch(JSON.stringify({ op, args: { compId: 1, ...args } })));
  return {
    ctx,
    keys: (tracks) => call("set_keyframes", { tracks }),
    inspect: (args) => call("inspect_property_tree", args),
  };
}

const prop = (layer, p) => p.reduce((g, seg) => g.property(seg), layer);
const ok = (r) => { assert.equal(r.ok, true, r.error); return r.result; };
const refused = (r, re) => { assert.equal(r.ok, false, "expected a refusal"); if (re) assert.match(r.error, re); return r.error; };
const valueWrites = () => writes.filter(([, m]) => m !== "removeKey").length;
const keyView = (p) => p.keys.map((k) => ({ t: k.time, v: k.value, io: [k.inI, k.outI], tc: k.tc, tab: k.tab, label: k.label, easeIn: k.easeIn, easeOut: k.easeOut, ...(k.inT ? { inT: k.inT, outT: k.outT, sc: k.sc, sab: k.sab, roving: k.roving } : {}) }));

let passed = 0;
function check(name, fn) {
  // ONLY=<name prefix> runs just the matching checks (for bisecting a failure); unset, everything runs.
  if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return;
  try { fn(); passed++; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
}

const OPACITY = ["ADBE Transform Group", "ADBE Opacity"];
const POSITION = ["ADBE Transform Group", "ADBE Position"];
const SCALE = ["ADBE Transform Group", "ADBE Scale"];
const ROT = ["ADBE Transform Group", "ADBE Rotate Z"];
const ORIENT = ["ADBE Transform Group", "ADBE Orientation"];
const FILL = ["ADBE Root Vectors Group", "ADBE Vector Group", "ADBE Vectors Group", "ADBE Vector Graphic - Fill", "ADBE Vector Fill Color"];
const RECT = ["ADBE Root Vectors Group", "ADBE Vector Group", "ADBE Vectors Group", "ADBE Vector Shape - Rect", "ADBE Vector Rect Size"];
const VPATH = ["ADBE Root Vectors Group", "ADBE Vector Group", "ADBE Vectors Group", "ADBE Vector Shape - Group", "ADBE Vector Shape"];
const MASK = ["ADBE Mask Parade", "ADBE Mask Atom", "ADBE Mask Shape"];
const ZOOM = ["ADBE Camera Options Group", "ADBE Camera Zoom"];
const t = (layerId, p, mode, keys) => ({ layerId, path: p, mode, keys });

// ---------------------------------------------------------------------------
// Value types that land
// ---------------------------------------------------------------------------

check("1. OneD: several keys land, read back from AE, with explicit linear defaults", () => {
  const layer = richLayer();
  const r = ok(load([layer]).keys([t(5, OPACITY, "replace", [{ frame: 0, value: 0 }, { frame: 12, value: 50 }, { frame: 24, value: 100 }])]));
  const tr = r.tracks[0];
  assert.deepEqual([tr.previousKeyCount, tr.actualKeyCount, tr.keysAdded, tr.keysUpdated, tr.keysRemoved, tr.changed], [0, 3, 3, 0, 0, true]);
  assert.deepEqual(tr.first, { time: 0, value: 0, frame: 0 });
  assert.deepEqual(tr.last, { time: 1, value: 100, frame: 24 });
  const p = prop(layer, OPACITY);
  assert.deepEqual(p.keys.map((k) => [k.time, k.value, k.inI, k.outI, k.label]), [[0, 0, KIT.LINEAR, KIT.LINEAR, 0], [0.5, 50, KIT.LINEAR, KIT.LINEAR, 0], [1, 100, KIT.LINEAR, KIT.LINEAR, 0]]);
  assert.equal(r.timeBase, "frames");
  assert.equal(r.totalKeyCount, 3);
});

check("2. TwoD and ThreeD values land; ease arity 2 and 3", () => {
  const layer = richLayer();
  ok(load([layer]).keys([
    t(5, RECT, "replace", [{ frame: 0, value: [10, 20] }, { frame: 10, value: [30, 40], easeIn: [{ speed: 0, influence: 33 }, { speed: 1, influence: 66 }] }]),
    t(5, SCALE, "replace", [{ frame: 0, value: [100, 100, 100] }, { frame: 10, value: [50, 60, 100], easeOut: [{ speed: 0, influence: 10 }, { speed: 0, influence: 20 }, { speed: 0, influence: 30 }] }]),
  ]));
  assert.deepEqual(prop(layer, RECT).keys[1].easeIn, [{ speed: 0, influence: 33 }, { speed: 1, influence: 66 }]);
  assert.deepEqual(prop(layer, SCALE).keys[1].easeOut.map((e) => e.influence), [10, 20, 30]);
});

check("3. spatial Position: tangents, continuous, auto-Bezier land; defaults are zero tangents", () => {
  const cam = cameraLayer();
  ok(load([cam]).keys([t(6, POSITION, "replace", [
    { frame: 0, value: [0, 0, -500] },
    { frame: 10, value: [100, 50, -400], spatialTangents: { in: [-20, 5, 10], out: [20, -5, -10] }, spatialContinuous: false },
    { frame: 20, value: [200, 0, -300], spatialAutoBezier: true },
  ])]));
  const k = prop(cam, POSITION).keys;
  assert.deepEqual([k[0].inT, k[0].sab, k[0].sc], [[0, 0, 0], false, true]);
  assert.deepEqual([k[1].inT, k[1].outT, k[1].sc, k[1].sab], [[-20, 5, 10], [20, -5, -10], false, false]);
  assert.equal(k[2].sab, true);
});

check("4. COLOR as four numbers; three are refused (a key has no current alpha)", () => {
  const layer = richLayer();
  const run = load([layer]);
  ok(run.keys([t(5, FILL, "replace", [{ frame: 0, value: [1, 0, 0, 1] }, { frame: 5, value: [0, 0, 1, 0.5] }])]));
  assert.deepEqual(prop(layer, FILL).keys[1].value, [0, 0, 1, 0.5]);
  refused(run.keys([t(5, FILL, "merge", [{ frame: 9, value: [1, 0, 0] }])]), /takes \[r, g, b, a\] — four numbers/);
});

check("5. Shape: a shape-layer path animates, vertex count may change", () => {
  const layer = richLayer();
  ok(load([layer]).keys([t(5, VPATH, "replace", [
    { frame: 0, value: square(0) },
    { frame: 10, value: { vertices: [[0, 0], [150, 0], [100, 150]], inTangents: [[0, 0], [-10, 0], [0, 0]], outTangents: [[0, 0], [10, 0], [0, 0]], closed: true } },
  ])]));
  assert.deepEqual(prop(layer, VPATH).keys.map((k) => k.value.vertices.length), [4, 3]);
});

check("6. a mask path animates when every key keeps its counts; an omitted feather is kept", () => {
  const layer = richLayer();
  const m = prop(layer, MASK);
  Object.assign(m._static, { featherSegLocs: [1], featherRelSegLocs: [0.5], featherRadii: [12], featherTypes: [0], featherInterps: [0], featherTensions: [0], featherRelCornerAngles: [0] });
  ok(load([layer]).keys([t(5, MASK, "replace", [{ frame: 0, value: square(0) }, { frame: 10, value: square(20) }])]));
  assert.deepEqual(m.keys.map((k) => k.value.featherRadii), [[12], [12]]);
  assert.equal(modals.length, 0);
});

// ---------------------------------------------------------------------------
// The mask modal (measured 2026-10-11: it blocked the bridge for 10 minutes)
// ---------------------------------------------------------------------------

check("7. REGRESSION: mask keys with different feather counts are refused before any write — the modal is never reached", () => {
  const layer = richLayer();
  const run = load([layer]);
  // The exact request that raised the warning: a feather point on key 1, key 2 inheriting none.
  const err = refused(run.keys([t(5, MASK, "replace", [{ frame: 0, value: square(0, true) }, { frame: 24, value: square(20) }])]),
    /key 1 \(frame 0\): "Mask Path" .* has 4 vertices and 1 feather points, but its current path has 4 and 0\. .*Preserve Constant Vertex and Feather Count/);
  assert.match(err, /Nothing was changed\.$/);
  assert.equal(prop(layer, MASK).numKeys, 0);
  assert.equal(writes.length, 0, "no AE call reached the mask");
  assert.equal(modals.length, 0);
  // Vertex counts too, and in a merge into existing keys.
  seed(prop(layer, MASK), [{ t: 0, v: { ...square(0), featherSegLocs: [] } }, { t: 1, v: { ...square(5), featherSegLocs: [] } }]);
  refused(run.keys([t(5, MASK, "merge", [{ frame: 6, value: { vertices: [[0, 0], [1, 0], [1, 1]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]], closed: true } }])]),
    /has 3 vertices and 0 feather points, but its existing keys have 4 and 0/);
  assert.equal(modals.length, 0);
  // A mask whose existing keys already disagree is not written at all (a rollback could raise it).
  seed(prop(layer, MASK), [{ t: 0, v: { ...square(0), featherSegLocs: [] } }, { t: 1, v: { ...square(5), featherSegLocs: [1] } }]);
  refused(run.keys([t(5, MASK, "merge", [{ frame: 6, value: square(3) }])]), /existing keys already differ in vertex or feather-point count/);
  assert.equal(modals.length, 0);
});

check("8. the mock does raise the modal when counts differ — so test 7 is testing the guard, not the mock", () => {
  const p = new Prop("Mask Path", "ADBE Mask Shape", PVT.SHAPE, { ...square(0), featherSegLocs: [] });
  load([]);
  assert.throws(() => p.setValuesAtTimes([0, 1], [{ ...square(0), featherSegLocs: [1] }, { ...square(0), featherSegLocs: [] }]), /MODAL/);
  assert.equal(modals.length, 1);
});

// ---------------------------------------------------------------------------
// Preflight refusals: nothing written
// ---------------------------------------------------------------------------

check("9. invalid dimensions, path, group endpoint are refused with the track and key named", () => {
  const run = load([richLayer()]);
  refused(run.keys([t(5, SCALE, "merge", [{ frame: 0, value: [1, 2] }])]), /track 1 .*key 1 \(frame 0\): "Scale" .*takes exactly 3 numbers/);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 0, value: [1, 2] }])]), /takes a single number/);
  refused(run.keys([t(5, ["ADBE Transform Group", "Nope"], "merge", [{ frame: 0, value: 1 }])]), /segment returned null at \[1\]=Nope/);
  refused(run.keys([t(99, OPACITY, "merge", [{ frame: 0, value: 1 }])]), /No layer with id 99/);
  refused(run.keys([t(5, ["ADBE Effect Parade", 2], "merge", [{ frame: 0, value: 1 }])]), /is a group \("Glow", ADBE Glo2\)/);
  assert.equal(writes.length, 0);
});

check("10. NO_VALUE, CUSTOM_VALUE, TEXT_DOCUMENT, MARKER, MASK_INDEX and canVaryOverTime:false are refused", () => {
  const run = load([richLayer()]);
  refused(run.keys([t(5, ["ADBE Effect Parade", "ADBE Fractal Noise", "ADBE Fractal Noise-0007"], "merge", [{ frame: 0, value: 1 }])]), /NO_VALUE\) has no value/);
  refused(run.keys([t(5, ["ADBE Effect Parade", "ADBE CurvesCustom", "ADBE CurvesCustom-0001"], "merge", [{ frame: 0, value: 1 }])]), /CUSTOM_VALUE\) holds plugin-defined data/);
  refused(run.keys([t(5, ["ADBE Text Properties", "ADBE Text Document"], "merge", [{ frame: 0, value: 1 }])]), /Source Text document: its keys are HOLD-only .*use set_text/);
  refused(run.keys([t(5, ["ADBE Marker"], "merge", [{ frame: 0, value: 1 }])]), /marker track .*add_marker/);
  refused(run.keys([t(5, ["ADBE Effect Parade", "ADBE Stroke", "ADBE Stroke-0001"], "merge", [{ frame: 0, value: 1 }])]), /mask index.*set_property_values/);
  refused(run.keys([t(5, ["ADBE Effect Parade", "ADBE Slider Control", "ADBE Slider Control-0001"], "merge", [{ frame: 0, value: 1 }])]), /canVaryOverTime is false/);
  assert.equal(writes.length, 0);
});

check("11. hidden properties are refused with the reason; Time Remap off is named", () => {
  const pre = precompLayer();
  const remap = pre.property("ADBE Time Remapping");
  remap.keys = []; remap.canSetExpression = false;
  const run = load([richLayer(), textLayer(), pre]);
  refused(run.keys([t(5, ORIENT, "merge", [{ frame: 0, value: [1, 0, 0] }])]), /the layer is 2D — this property needs threeDLayer:true/);
  refused(run.keys([t(8, ["ADBE Text Properties", "ADBE Text Animators", "ADBE Text Animator", "ADBE Text Animator Properties", "ADBE Text Opacity"], "merge", [{ frame: 0, value: 1 }])]), /hidden/);
  refused(run.keys([t(9, ["ADBE Time Remapping"], "merge", [{ frame: 0, value: 1 }])]), /Time Remap is off on this layer — turn it on first/);
  assert.equal(writes.length, 0);
});

check("12. duplicate track targets are refused however the paths are spelled", () => {
  const run = load([richLayer()]);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 0, value: 1 }]), t(5, ["Transform", "Opacity"], "merge", [{ frame: 1, value: 2 }])]), /track 2 .*same property as track 1/);
  refused(run.keys([t(5, ["ADBE Effect Parade", 2, "ADBE Glo2-0003"], "merge", [{ frame: 0, value: 1 }]), t(5, ["Effects", 2, "Glow Radius"], "merge", [{ frame: 0, value: 1 }])]), /same property as track 1/);
  assert.equal(writes.length, 0);
  ok(run.keys([t(5, ["ADBE Effect Parade", 1, "ADBE Glo2-0003"], "merge", [{ frame: 0, value: 1 }]), t(5, ["ADBE Effect Parade", 2, "ADBE Glo2-0003"], "merge", [{ frame: 0, value: 2 }])]));
});

check("13. duplicate key times are refused after frame/time normalisation", () => {
  const run = load([richLayer()]);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 3, value: 1 }, { frame: 3, value: 2 }])]), /key [12] \(frame 3\) lands on the same After Effects key as key [12] \(frame 3\)/);
  // 0.5 and 0.50001 s are a quarter of a 24 fps storage step (1/24576 s) apart:
  // After Effects stores both at one time, so they are one key (recipe 61).
  refused(run.keys([t(5, OPACITY, "merge", [{ time: 0.5, value: 1 }, { time: 0.50001, value: 2 }])]), /lands on the same After Effects key/);
  assert.equal(writes.length, 0);
  // 0.50005 s is 1.23 steps from 0.5 s: two keys in After Effects. The old fixed
  // 1e-4 s took them for one and refused; they are written as two.
  const layer = richLayer();
  const run2 = load([layer]);
  const r = ok(run2.keys([t(5, OPACITY, "merge", [{ time: 0.5, value: 1 }, { time: 0.50005, value: 2 }])]));
  assert.equal(r.tracks[0].keysAdded, 2);
  assert.equal(prop(layer, OPACITY).keys.length, 2);
});

check("14. one time base per request: mixing frame and time, or a key with both/neither, is refused", () => {
  const run = load([richLayer()]);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 0, value: 1 }]), t(5, ROT, "merge", [{ time: 1, value: 2 }])]), /track 2 key 1 uses `time` while earlier keys use `frame`/);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 0, time: 0, value: 1 }])]), /exactly one of `frame` or `time` — it has both/);
  refused(run.keys([t(5, OPACITY, "merge", [{ value: 1 }])]), /exactly one of `frame` or `time`/);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 1.5, value: 1 }])]), /`frame` must be a whole number/);
  assert.equal(writes.length, 0);
});

check("15. times outside the comp, and out-of-range values, are refused", () => {
  const run = load([richLayer()], { duration: 10 });
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 241, value: 1 }])]), /outside the comp \(0 to 10s, frames 0 to 240\)/);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: -1, value: 1 }])]), /outside the comp/);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 1, value: 150 }])]), /150 is above this property's maximum 100/);
  refused(run.keys([t(5, ["ADBE Effect Parade", 1, "ADBE Glo2-0001"], "merge", [{ frame: 1, value: 1.5 }])]), /dropdown and takes a whole number/);
  assert.equal(writes.length, 0);
  ok(run.keys([t(5, OPACITY, "merge", [{ frame: 240, value: 1 }])]));
});

check("16. a 2D layer's Position/Anchor keys must have Z 0 and Scale keys Z 100 (what AE stores)", () => {
  const run = load([richLayer(), cameraLayer()]);
  refused(run.keys([t(5, SCALE, "merge", [{ frame: 0, value: [50, 50, 70] }])]), /stores every Scale key's Z as 100 on a 2D layer — pass 100/);
  refused(run.keys([t(5, POSITION, "merge", [{ frame: 0, value: [1, 2, 7] }])]), /the layer is 2D, and After Effects stores every Position key's Z as 0 on a 2D layer — pass 0/);
  refused(run.keys([t(5, POSITION, "merge", [{ frame: 0, value: [1, 2, 0], spatialTangents: { in: [0, 0, 3], out: [0, 0, 0] } }])]), /Z of 3 on a 2D layer/);
  ok(run.keys([t(6, POSITION, "merge", [{ frame: 0, value: [1, 2, 7] }])]));
});

check("17. a later invalid track means no earlier track is touched, and every problem is named", () => {
  const layer = richLayer(), cam = cameraLayer();
  const run = load([layer, cam]);
  const good = Array.from({ length: 81 }, (_, i) => ({ frame: i, value: i }));
  const bad = Array.from({ length: 82 }, (_, i) => ({ frame: i, value: i }));
  bad[81].value = [1, 2];
  const err = refused(run.keys([
    t(5, OPACITY, "replace", good.map((k) => ({ ...k, value: k.value % 100 }))),
    t(5, ROT, "replace", good), t(6, ZOOM, "replace", good.map((k) => ({ ...k, value: 100 + k.value }))),
    t(6, POSITION, "replace", [{ frame: 0, value: [0, 0, 0] }]), t(6, ["ADBE Camera Options Group", "ADBE Camera Focus Distance"], "replace", good.map((k) => ({ ...k, value: 100 + k.value }))),
    t(6, ["ADBE Transform Group", "ADBE Rotate X"], "replace", bad),
  ]));
  assert.match(err, /track 6 .*key 82 \(frame 81\): "X Rotation" .*takes a single number/);
  assert.equal(writes.length, 0);
  assert.equal(prop(layer, OPACITY).numKeys, 0);
  assert.equal(prop(cam, ZOOM).numKeys, 0);
});

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

check("18. frames use the comp's frameDuration: 23.976 lands on the frame; seconds land on After Effects' key-time grid", () => {
  const cam = cameraLayer();
  const fd = 1 / 23.976;                      // what After Effects makes a 23.976 comp's frameDuration
  const run = load([cam], { fps: 23.976, frameDuration: fd, duration: 60 });
  const frames = [0, 1, 12, 99, 150, 200, 240];
  const r = ok(run.keys([t(6, ZOOM, "replace", frames.map((f) => ({ frame: f, value: 100 + f })))]));
  const times = prop(cam, ZOOM).keys.map((k) => k.time);
  // Stored on the frame: frame × frameDuration, after After Effects' float32 and
  // grid rounding (1/23976 s at 23.976 — 1000 steps a frame), which at
  // these times moves nothing beyond the last digit (recipe 61).
  for (let i = 0; i < frames.length; i++) assert.ok(Math.abs(times[i] - frames[i] * fd) < 1e-12, `frame ${frames[i]} stored at ${times[i]}`);
  assert.equal(r.tracks[0].last.frame, 240);
  assert.equal(r.frameDuration, fd);
  // Seconds: a fractional frame stays fractional, but is stored where After
  // Effects stores it — on its key-time grid — and the result reports that time.
  const r2 = ok(run.keys([t(6, ["ADBE Camera Options Group", "ADBE Camera Focus Distance"], "replace", [{ time: 0.4379, value: 200 }])]));
  assert.equal(r2.timeBase, "seconds");
  const step = 1 / 23976;
  const stored = prop(cam, ["ADBE Camera Options Group", "ADBE Camera Focus Distance"]).keys[0].time;
  assert.equal(stored, Math.round(Math.fround(0.4379) / step) * step);
  assert.ok(Math.abs(stored - 0.4379) < step / 2 && stored !== 0.4379);
  assert.equal(r2.tracks[0].first.time, stored);
  assert.equal(r2.tracks[0].first.frame, undefined);
});

check("19. a comp whose timeline starts later reports it; frame 0 is still time 0", () => {
  const run = load([richLayer()], { displayStartTime: 1001 / 24 });
  const r = ok(run.keys([t(5, OPACITY, "merge", [{ frame: 0, value: 5 }])]));
  assert.equal(r.displayStartFrame, 1001);
  assert.match(r.displayStartNote, /counts from the comp's first frame \(time 0\)/);
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function seededRot(layer) {
  const p = prop(layer, ROT);
  seed(p, [
    { t: 0, v: 0, meta: { inI: KIT.BEZIER, outI: KIT.BEZIER, easeIn: [{ speed: 0, influence: 21 }], easeOut: [{ speed: 0, influence: 41 }], label: 1 } },
    { t: 1, v: 10, meta: { inI: KIT.HOLD, outI: KIT.HOLD, label: 2 } },
    { t: 2, v: 20, meta: { inI: KIT.BEZIER, outI: KIT.BEZIER, easeIn: [{ speed: 3, influence: 50 }], easeOut: [{ speed: 3, influence: 20 }], tc: true, label: 3 } },
  ]);
  return p;
}

check("20. merge: untouched keys keep everything; a matched key keeps what is not passed; a new key gets the defaults", () => {
  const layer = richLayer();
  const p = seededRot(layer);
  const before = keyView(p);
  const r = ok(load([layer]).keys([t(5, ROT, "merge", [{ frame: 24, value: 99 }, { frame: 36, value: 55 }])]));
  const tr = r.tracks[0];
  assert.deepEqual([tr.previousKeyCount, tr.actualKeyCount, tr.keysAdded, tr.keysUpdated, tr.keysRemoved, tr.changed], [3, 4, 1, 1, undefined, true]);
  const after = keyView(p);
  assert.deepEqual(after[0], before[0], "untouched key 1");
  assert.deepEqual(after[3], before[2], "untouched key 3, now fourth in time order");
  assert.deepEqual({ ...after[1], v: undefined }, { ...before[1], v: undefined }, "the matched key kept its hold and label");
  assert.equal(after[1].v, 99);
  assert.deepEqual([after[2].t, after[2].v, after[2].io, after[2].label, after[2].tc], [1.5, 55, [KIT.LINEAR, KIT.LINEAR], 0, false], "a new key: defaults, not its HOLD neighbour's interpolation");
});

check("21. merge: a matched key's passed fields change; a stored auto-Bezier that would fight a new ease is turned off on purpose", () => {
  const layer = richLayer();
  const p = seededRot(layer);
  p.keys[0].tab = true; p.keys[0].tc = true;
  ok(load([layer]).keys([t(5, ROT, "merge", [{ frame: 0, value: 1, easeOut: [{ speed: 2, influence: 60 }], label: 9 }])]));
  assert.deepEqual([p.keys[0].tab, p.keys[0].easeOut, p.keys[0].label, p.keys[0].inI], [false, [{ speed: 2, influence: 60 }], 9, KIT.BEZIER]);
});

check("22. replace: prior keys are removed, only the given keys remain, with defaults; the expression is untouched", () => {
  const layer = richLayer();
  const p = seededRot(layer);
  Object.assign(p, { expression: "value * 2", expressionEnabled: true, evaluate: (v) => v * 2 });
  const r = ok(load([layer]).keys([t(5, ROT, "replace", [{ frame: 24, value: 7 }, { frame: 60, value: 8 }])]));
  const tr = r.tracks[0];
  assert.deepEqual([tr.previousKeyCount, tr.actualKeyCount, tr.keysAdded, tr.keysUpdated, tr.keysRemoved, tr.expressionEnabled], [3, 2, 1, 1, 2, true]);
  assert.deepEqual(keyView(p).map((k) => [k.t, k.v, k.io, k.label, k.tc]), [[1, 7, [KIT.LINEAR, KIT.LINEAR], 0, false], [2.5, 8, [KIT.LINEAR, KIT.LINEAR], 0, false]]);
  assert.deepEqual([p.expression, p.expressionEnabled], ["value * 2", true]);
});

check("23. no mode deletes animation by omission: merge with one key leaves the rest; mode is required", () => {
  const layer = richLayer();
  const p = seededRot(layer);
  ok(load([layer]).keys([t(5, ROT, "merge", [{ frame: 12, value: 5 }])]));
  assert.equal(p.numKeys, 4);
  assert.throws(() => parseOpArgs("set_keyframes", { compId: 1, tracks: [{ layerId: 5, path: ROT, keys: [{ frame: 0, value: 1 }] }] }));
  assert.throws(() => parseOpArgs("set_keyframes", { compId: 1, tracks: [{ layerId: 5, path: ROT, mode: "replace", keys: [] }] }));
});

// ---------------------------------------------------------------------------
// Interpolation, ease, flags
// ---------------------------------------------------------------------------

check("24. interpolation: both sides explicit, each lands — hold, linear, bezier, mixed", () => {
  const layer = richLayer();
  ok(load([layer]).keys([t(5, ROT, "replace", [
    { frame: 0, value: 0, interpolation: { in: "linear", out: "hold" } },
    { frame: 10, value: 1, interpolation: { in: "hold", out: "bezier" } },
    { frame: 20, value: 2, interpolation: { in: "bezier", out: "linear" }, easeIn: [{ speed: 0, influence: 80 }] },
  ])]));
  const k = prop(layer, ROT).keys;
  assert.deepEqual(k.map((x) => [x.inI, x.outI]), [[KIT.LINEAR, KIT.HOLD], [KIT.HOLD, KIT.BEZIER], [KIT.BEZIER, KIT.LINEAR]]);
  assert.equal(k[2].easeIn[0].influence, 80, "the ease survives the interpolation set after it");
});

check("25. an omitted interpolation is bezier on a side given an ease, linear otherwise", () => {
  const layer = richLayer();
  ok(load([layer]).keys([t(5, ROT, "replace", [{ frame: 0, value: 0, easeOut: [{ speed: 0, influence: 75 }] }, { frame: 10, value: 1 }])]));
  assert.deepEqual(prop(layer, ROT).keys.map((x) => [x.inI, x.outI]), [[KIT.LINEAR, KIT.BEZIER], [KIT.LINEAR, KIT.LINEAR]]);
});

check("26. ease validation: dimension count, influence range, ease on a non-bezier side", () => {
  const run = load([richLayer()]);
  refused(run.keys([t(5, SCALE, "merge", [{ frame: 0, value: [1, 1, 100], easeIn: [{ speed: 0, influence: 50 }] }])]), /easeIn has 1 entry; this property's ease has 3/);
  refused(run.keys([t(5, POSITION, "merge", [{ frame: 0, value: [1, 1, 0], easeIn: [{ speed: 0, influence: 50 }, { speed: 0, influence: 50 }] }])]), /easeIn has 2 entries; this property's ease has 1/);
  refused(run.keys([t(5, ROT, "merge", [{ frame: 0, value: 1, easeIn: [{ speed: 0, influence: 0 }] }])]), /influence 0 is outside 0\.1\.\.100/);
  refused(run.keys([t(5, ROT, "merge", [{ frame: 0, value: 1, interpolation: { in: "linear", out: "linear" }, easeIn: [{ speed: 0, influence: 50 }] }])]), /easeIn shapes a Bezier in-side, but interpolation\.in is "linear"/);
  assert.equal(writes.length, 0);
});

check("27. temporal flags: auto-Bezier and continuous land; contradictions are refused", () => {
  const layer = richLayer();
  const run = load([layer]);
  ok(run.keys([t(5, ROT, "replace", [
    { frame: 0, value: 0 },
    { frame: 10, value: 1, temporalAutoBezier: true },
    { frame: 20, value: 2, temporalContinuous: true, easeIn: [{ speed: 4, influence: 30 }], easeOut: [{ speed: 4, influence: 70 }] },
    { frame: 30, value: 3 },
  ])]));
  const k = prop(layer, ROT).keys;
  assert.deepEqual([k[1].tab, k[1].tc, k[1].inI], [true, true, KIT.BEZIER]);
  assert.deepEqual([k[2].tc, k[2].easeIn[0], k[2].easeOut[0]], [true, { speed: 4, influence: 30 }, { speed: 4, influence: 70 }], "continuous set before the ease, so AE did not copy the in speed over a different out");
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 0, value: 1, temporalAutoBezier: true, easeIn: [{ speed: 0, influence: 50 }] }])]), /temporalAutoBezier:true makes After Effects compute the ease/);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 0, value: 1, temporalAutoBezier: true, temporalContinuous: false }])]), /always continuous/);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 0, value: 1, temporalContinuous: true, easeIn: [{ speed: 1, influence: 50 }], easeOut: [{ speed: 2, influence: 50 }] }])]), /one speed through it/);
  refused(run.keys([t(5, OPACITY, "merge", [{ frame: 0, value: 1, temporalContinuous: true, interpolation: { in: "linear", out: "bezier" } }])]), /needs Bezier on both sides/);
});

check("28. spatial options: only on spatial types, never Orientation, never with auto-Bezier, tangent arity checked", () => {
  const cam = cameraLayer();
  const run = load([richLayer(), cam]);
  refused(run.keys([t(5, FILL, "merge", [{ frame: 0, value: [1, 0, 0, 1], spatialContinuous: true }])]), /is not a spatial property .*COLOR and Shape report isSpatial/);
  refused(run.keys([t(6, ORIENT, "merge", [{ frame: 0, value: [1, 0, 0], spatialTangents: { in: [1, 0, 0], out: [0, 0, 0] } }])]), /spatial options are refused on Orientation .*\[90,350,10\]/);
  refused(run.keys([t(6, POSITION, "merge", [{ frame: 0, value: [1, 0, 0], spatialAutoBezier: true, spatialTangents: { in: [1, 0, 0], out: [0, 0, 0] } }])]), /spatialAutoBezier:true makes After Effects compute the tangents/);
  refused(run.keys([t(6, POSITION, "merge", [{ frame: 0, value: [1, 0, 0], spatialTangents: { in: [1, 0], out: [0, 0] } }])]), /takes 3 numbers on this property/);
  assert.equal(writes.length, 0);
  // Orientation keys themselves are fine — the tool never calls the tangent setter there.
  ok(run.keys([t(6, ORIENT, "replace", [{ frame: 0, value: [0, 0, 0] }, { frame: 10, value: [0, 30, 0] }])]));
  assert.equal(writes.filter(([m, w]) => m === "ADBE Orientation" && w === "setSpatialTangentsAtKey").length, 0);
  assert.deepEqual(prop(cam, ORIENT).keys[1].value, [0, 30, 0]);
});

check("29. roving: never set, and a track with roving keys is refused in both modes", () => {
  const cam = cameraLayer();
  seed(prop(cam, POSITION), [{ t: 0, v: [0, 0, 0] }, { t: 1, v: [1, 0, 0], meta: { roving: true } }, { t: 2, v: [2, 0, 0] }]);
  const run = load([cam]);
  refused(run.keys([t(6, POSITION, "merge", [{ frame: 5, value: [9, 9, 9] }])]), /has roving keys \(key 2\)/);
  refused(run.keys([t(6, POSITION, "replace", [{ frame: 5, value: [9, 9, 9] }])]), /has roving keys/);
  assert.equal(writes.length, 0);
  assert.throws(() => parseOpArgs("set_keyframes", { compId: 1, tracks: [t(6, POSITION, "merge", [{ frame: 0, value: [0, 0, 0], roving: true }])] }));
});

check("30. labels land, 0..16", () => {
  const layer = richLayer();
  ok(load([layer]).keys([t(5, ROT, "replace", [{ frame: 0, value: 0, label: 16 }, { frame: 1, value: 1, label: 3 }])]));
  assert.deepEqual(prop(layer, ROT).keys.map((k) => k.label), [16, 3]);
  assert.throws(() => parseOpArgs("set_keyframes", { compId: 1, tracks: [t(5, ROT, "merge", [{ frame: 0, value: 0, label: 17 }])] }));
});

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

check("31. expression policy: keys written under an enabled expression, verified by keyValue, the expression kept and reported", () => {
  const layer = richLayer();
  Object.assign(prop(layer, OPACITY), { expression: "value / 2", expressionEnabled: true, evaluate: (v) => v / 2 });
  const r = ok(load([layer]).keys([t(5, OPACITY, "replace", [{ frame: 0, value: 80 }, { frame: 10, value: 40 }])]));
  assert.equal(r.tracks[0].expressionEnabled, true);
  assert.match(r.tracks[0].expressionNote, /expression was left alone/);
  assert.deepEqual(r.tracks[0].first.value, 80, "the key, not the evaluated 40");
  assert.equal(prop(layer, OPACITY).expression, "value / 2");
});

// ---------------------------------------------------------------------------
// Readback and rollback
// ---------------------------------------------------------------------------

check("32. readback: a value AE stores differently is a failure, and the call is rolled back", () => {
  const layer = richLayer();
  const p = prop(layer, OPACITY);
  p._store = function (v) { return Math.round(v); };
  const err = refused(load([layer]).keys([t(5, OPACITY, "replace", [{ frame: 0, value: 2.5 }])]));
  assert.match(err, /track 1 .*failed — the keys did not land as asked: key 1 \(frame 0\): value reads 3, asked 2\.5/);
  assert.match(err, /Rolled back every track this call touched .*restored \(0 keys\)\), so no animation changed\./);
  assert.equal(p.numKeys, 0);
});

check("33. verification failure (metadata that did not land) rolls back every earlier track", () => {
  const layer = richLayer();
  const p1 = seededRot(layer);
  const before = keyView(p1);
  prop(layer, OPACITY).ignore = { setLabelAtKey: true };
  const err = refused(load([layer]).keys([
    t(5, ROT, "replace", [{ frame: 5, value: 1 }]),
    t(5, OPACITY, "replace", [{ frame: 0, value: 0, label: 4 }]),
  ]));
  assert.match(err, /track 2 .*label reads 0, asked 4/);
  assert.match(err, /track 2 \(.*\) restored \(0 keys\); track 1 \(.*\) restored \(3 keys\)\), so no animation changed/);
  assert.deepEqual(keyView(p1), before, "the replaced track is back exactly — times, values, holds, eases, continuous, labels");
  assert.equal(prop(layer, OPACITY).numKeys, 0);
  assert.equal(prop(layer, OPACITY)._static, 100, "and the static value");
});

check("34. a runtime refusal nothing predicts rolls back tracks on several layers, newest first", () => {
  const layer = richLayer(), cam = cameraLayer(), pre = precompLayer();
  const rot = seededRot(layer);
  const camBefore = keyView(prop(cam, POSITION));
  const remapBefore = keyView(pre.property("ADBE Time Remapping"));
  const rotBefore = keyView(rot);
  prop(cam, ZOOM).fail = { setValueAtTime: "After Effects error: something only AE knew" };
  const err = refused(load([layer, cam, pre]).keys([
    t(5, ROT, "replace", [{ frame: 1, value: 1 }]),
    t(9, ["ADBE Time Remapping"], "replace", [{ frame: 0, value: 2 }, { frame: 48, value: 0 }]),
    t(6, POSITION, "merge", [{ frame: 3, value: [1, 1, 1] }]),
    t(6, ZOOM, "replace", [{ frame: 0, value: 100 }]),
  ]));
  assert.match(err, /track 4 .*After Effects refused it: After Effects error: something only AE knew/);
  assert.match(err, /track 4 .*restored \(0 keys\); track 3 .*restored \(0 keys\); track 2 .*restored \(2 keys\); track 1 .*restored \(3 keys\)/);
  assert.deepEqual(keyView(rot), rotBefore);
  assert.deepEqual(keyView(pre.property("ADBE Time Remapping")), remapBefore, "Time Remap never passed through zero keys");
  assert.equal(pre.property("ADBE Time Remapping").canSetExpression, true, "so it is still on");
  assert.deepEqual(keyView(prop(cam, POSITION)), camBefore);
});

check("35. a restore that cannot rebuild a key (influence 0) is reported INCOMPLETE, never assumed", () => {
  const layer = richLayer();
  const p = prop(layer, ROT);
  seed(p, [{ t: 0, v: 0 }, { t: 1, v: 10, meta: { inI: KIT.BEZIER, outI: KIT.BEZIER, easeIn: [{ speed: 0, influence: 0 }], easeOut: [{ speed: 0, influence: 0 }] } }]);
  prop(layer, OPACITY).fail = { setValueAtTime: "boom" };
  const err = refused(load([layer]).keys([t(5, ROT, "replace", [{ frame: 3, value: 1 }]), t(5, OPACITY, "replace", [{ frame: 0, value: 1 }])]));
  assert.match(err, /Rollback was INCOMPLETE: .*track 1 .*NOT fully restored: key 2 .*easeIn reads .*was \[\{"speed":0,"influence":0\}\] \(it held an influence outside 0\.1\.\.100, which no After Effects setter accepts\)/);
  assert.match(err, /Edit > Undo reverts the whole call/);
});

check("36. a restore that throws is reported, and the other tracks are still restored", () => {
  const layer = richLayer();
  const rot = seededRot(layer);
  const before = keyView(rot);
  const op = prop(layer, OPACITY);
  op.fail = { setTemporalEaseAtKey: "ease setter broke" };
  seed(op, [{ t: 0, v: 5, meta: { inI: KIT.BEZIER, outI: KIT.BEZIER, easeIn: [{ speed: 0, influence: 40 }], easeOut: [{ speed: 0, influence: 40 }] } }]);
  prop(layer, SCALE).fail = { setValueAtTime: "boom" };
  const err = refused(load([layer]).keys([
    t(5, ROT, "replace", [{ frame: 3, value: 1 }]),
    t(5, OPACITY, "replace", [{ frame: 9, value: 1 }]),
    t(5, SCALE, "replace", [{ frame: 0, value: [1, 1, 100] }]),
  ]));
  assert.match(err, /Rollback was INCOMPLETE: .*track 2 .*NOT fully restored: key 1 .*ease setter broke/);
  assert.match(err, /track 1 .*restored \(3 keys\)/);
  assert.deepEqual(keyView(rot), before);
});

// ---------------------------------------------------------------------------
// Addressing: inspect → animate → inspect
// ---------------------------------------------------------------------------

check("37. duplicate effects: Glow 2's path from inspect_property_tree is animated, Glow 1 untouched", () => {
  const layer = richLayer();
  const run = load([layer]);
  const radii = ok(run.inspect({ layerId: 5, path: ["ADBE Effect Parade"], depth: 2 })).nodes.filter((n) => n.matchName === "ADBE Glo2-0003");
  assert.deepEqual(radii.map((n) => n.path), [["ADBE Effect Parade", 1, "ADBE Glo2-0003"], ["ADBE Effect Parade", 2, "ADBE Glo2-0003"]]);
  ok(run.keys([t(5, radii[1].path, "replace", [{ frame: 0, value: 10 }, { frame: 12, value: 60 }, { frame: 24, value: 30 }])]));
  assert.equal(prop(layer, ["ADBE Effect Parade", 1, "ADBE Glo2-0003"]).numKeys, 0);
  const again = ok(run.inspect({ layerId: 5, path: radii[1].path, includeKeys: true }));
  assert.deepEqual(again.nodes[0].keys.map((k) => [k.time, k.value]), [[0, 10], [0.5, 60], [1, 30]]);
});

check("38. camera, light and text animator paths from inspect_property_tree, in one call across three layers", () => {
  const cam = cameraLayer(), light = lightLayer(), txt = textLayer();
  const run = load([cam, light, txt]);
  const pathOf = (layerId, start, m) => ok(run.inspect({ layerId, path: start, depth: 6 })).nodes.find((n) => n.matchName === m).path;
  const zoom = pathOf(6, ["ADBE Camera Options Group"], "ADBE Camera Zoom");
  const intensity = pathOf(7, ["ADBE Light Options Group"], "ADBE Light Intensity");
  const animPos = pathOf(8, ["ADBE Text Properties"], "ADBE Text Position 3D");
  assert.deepEqual(animPos, ["ADBE Text Properties", "ADBE Text Animators", "ADBE Text Animator", "ADBE Text Animator Properties", "ADBE Text Position 3D"]);
  const camKeys = Array.from({ length: 91 }, (_, i) => ({ frame: 150 + i, value: [i, -i, -1000 + i] }));
  const r = ok(run.keys([
    t(6, POSITION, "replace", camKeys),
    t(6, ORIENT, "replace", camKeys.map((k) => ({ frame: k.frame, value: [0, k.frame - 150, 0] }))),
    t(6, ["ADBE Transform Group", "ADBE Rotate X"], "replace", camKeys.map((k) => ({ frame: k.frame, value: (k.frame - 150) / 9 }))),
    t(6, zoom, "replace", camKeys.map((k) => ({ frame: k.frame, value: 1000 + k.frame }))),
    t(7, intensity, "merge", [{ frame: 0, value: 50 }, { frame: 24, value: 150 }]),
    t(8, animPos, "replace", [{ frame: 0, value: [0, 0, 0] }, { frame: 12, value: [0, -40, 0] }]),
  ]));
  assert.deepEqual([r.trackCount, r.appliedTrackCount, r.totalKeyCount], [6, 6, 368]);
  assert.deepEqual(r.tracks.slice(0, 4).map((x) => [x.actualKeyCount, x.first.frame, x.last.frame]), [[91, 150, 240], [91, 150, 240], [91, 150, 240], [91, 150, 240]]);
  const back = ok(run.inspect({ layerId: 8, path: animPos, includeKeys: true }));
  assert.deepEqual(back.nodes[0].keys.map((k) => k.value), [[0, 0, 0], [0, -40, 0]]);
});

check("39. the result is read back from AE, not echoed, and stays compact", () => {
  const layer = richLayer();
  const p = prop(layer, FILL);
  p._store = function (v) { return v.map((n) => Math.fround(n)); };
  const r = ok(load([layer]).keys([t(5, FILL, "replace", [{ frame: 0, value: [0.2, 0.4, 0.6, 1] }])]));
  assert.deepEqual(r.tracks[0].first.value, [Math.fround(0.2), Math.fround(0.4), Math.fround(0.6), 1]);
  const many = ok(load([richLayer()], { duration: 30 }).keys([t(5, ROT, "replace", Array.from({ length: 500 }, (_, i) => ({ frame: i, value: i })))]));
  assert.ok(JSON.stringify(many).length < 2000, "500 keys answer in under 2 KB — no per-key echo");
  assert.ok(many.timing && typeof many.elapsedMs === "number");
});

check("40. rewriting what is already there succeeds and says it changed nothing", () => {
  const layer = richLayer();
  const p = prop(layer, ROT);
  seed(p, [{ t: 0, v: 0 }, { t: 1, v: 10 }]);
  const r = ok(load([layer]).keys([t(5, ROT, "replace", [{ frame: 0, value: 0 }, { frame: 24, value: 10 }])]));
  assert.equal(r.tracks[0].changed, false);
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

check("41. strict schema: unknown keys, both/neither time fields, bad enums and shapes are refused — also in a batch", () => {
  const k = { frame: 0, value: 1 };
  const tr = (keys, extra = {}) => ({ compId: 1, tracks: [{ layerId: 2, path: OPACITY, mode: "merge", keys, ...extra }] });
  for (const bad of [
    tr([{ ...k, time: 0 }]), tr([{ value: 1 }]), tr([{ ...k, frame: 1.5 }]), tr([{ ...k, roving: true }]), tr([{ ...k, extra: 1 }]),
    tr([{ ...k, interpolation: { in: "linear" } }]), tr([{ ...k, interpolation: { in: "smooth", out: "linear" } }]),
    tr([{ ...k, easeIn: [{ speed: 0, influence: 0 }] }]), tr([{ ...k, easeIn: [{ speed: 0 }] }]), tr([{ ...k, easeIn: [] }]),
    tr([{ ...k, spatialTangents: { in: [0, 0] } }]), tr([{ ...k, label: 17 }]), tr([{ ...k, value: "1" }]),
    tr([k], { extra: true }), { compId: 1, tracks: [] }, { compId: 1, tracks: [{ layerId: 2, path: [], mode: "merge", keys: [k] }] },
    tr(Array.from({ length: schemas.SET_KEYFRAMES_MAX_KEYS_PER_TRACK + 1 }, (_, i) => ({ frame: i, value: 1 }))),
  ]) {
    assert.throws(() => parseOpArgs("set_keyframes", bad), JSON.stringify(bad).slice(0, 140));
  }
  assert.equal(parseOpArgs("set_keyframes", tr([k, { frame: 1, value: 2, interpolation: { in: "hold", out: "bezier" }, easeOut: [{ speed: 0, influence: 50 }] }])).tracks[0].keys.length, 2);
  assert.throws(() => validateBatchOps([{ op: "set_keyframes", args: tr([{ value: 1 }]) }]), /step 0 \(set_keyframes\)/);
  validateBatchOps([{ op: "set_keyframes", args: tr([k]) }]);
});

check("42. classified write; the limits in the schema and in the JSX agree", () => {
  assert.equal(schemas.OpMutation.set_keyframes, "write");
  const src = read("keywrite.jsx");
  const num = (name) => Number(src.match(new RegExp(`var ${name} = (\\d+);`))[1]);
  assert.equal(num("__KW_MAX_TRACKS"), schemas.SET_KEYFRAMES_MAX_TRACKS);
  assert.equal(num("__KW_MAX_KEYS_PER_TRACK"), schemas.SET_KEYFRAMES_MAX_KEYS_PER_TRACK);
  assert.equal(num("__KW_MAX_TOTAL_KEYS"), schemas.SET_KEYFRAMES_MAX_TOTAL_KEYS);
  assert.ok(schemas.SET_KEYFRAMES_MAX_TOTAL_KEYS >= 2000, "hundreds of camera keys in one call is the point");
  assert.match(descriptions.set_keyframes, /exactly one of `frame`/);
});

check("43. the total-keys limit is enforced across tracks", () => {
  const run = load([richLayer()]);
  const keys = Array.from({ length: 5000 }, (_, i) => ({ frame: i, value: 1 }));
  refused(run.keys([t(5, OPACITY, "merge", keys), t(5, ROT, "merge", keys), t(5, ["ADBE Effect Parade", 1, "ADBE Glo2-0003"], "merge", keys)]), /15000 keys in total; the limit is 10000 per call/);
  assert.equal(writes.length, 0);
});

check("44. never saves; one undo group per call — success, preflight refusal and rollback alike", () => {
  const layer = richLayer();
  const run = load([layer]);
  ok(run.keys([t(5, OPACITY, "replace", [{ frame: 0, value: 1 }]), t(5, ROT, "replace", [{ frame: 0, value: 1 }])]));
  assert.deepEqual([undoOpened, undoClosed], [1, 1]);
  refused(run.keys([t(5, SCALE, "merge", [{ frame: 0, value: [1] }])]));
  assert.deepEqual([undoOpened, undoClosed], [2, 2]);
  prop(layer, SCALE).fail = { setValueAtTime: "boom" };
  refused(run.keys([t(5, OPACITY, "replace", [{ frame: 3, value: 2 }]), t(5, SCALE, "replace", [{ frame: 0, value: [1, 1, 100] }])]));
  assert.deepEqual([undoOpened, undoClosed], [3, 3], "the rollback stays inside the call's own group");
  assert.equal(saved, 0);
});

check("45. one setValuesAtTimes write per track, and setters only where a key differs", () => {
  const layer = richLayer();
  ok(load([layer]).keys([t(5, ROT, "replace", Array.from({ length: 200 }, (_, i) => ({ frame: i, value: i })))]));
  const calls = writes.filter(([m]) => m === "ADBE Rotate Z").map(([, w]) => w);
  assert.equal(calls.filter((w) => w === "setValueAtTime").length, 200, "one bulk call (the mock expands it per key)");
  assert.equal(calls.filter((w) => w === "setTemporalAutoBezierAtKey" || w === "setLabelAtKey" || w === "setInterpolationTypeAtKey").length, 0, "fresh keys already match the defaults");
});

// ---------------------------------------------------------------------------
// B2.1 — key identity follows After Effects' own key-time storage
// ---------------------------------------------------------------------------
// At 30 fps After Effects keeps 1 s and 1 + 2/30720 s (1.0000651 s) as two
// keys (recipe 61). The fixed 1e-4 s tolerance B2 shipped with took them for
// one: a merge overwrote the key at 1 s, and a replace kept the neighbour,
// then refused and rolled back (docs/fragile-areas-ae.md, open issue).
const NEAR = 1 + 2 / 30720;

check("B2.1-1. merge one storage step from an existing key makes a distinct key; the existing key keeps its value", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 10 });
  seed(prop(layer, OPACITY), [{ t: 1, v: 90 }]);
  const r = ok(run.keys([t(5, OPACITY, "merge", [{ time: NEAR, value: 70 }])]));
  assert.equal(r.tracks[0].keysAdded, 1, "a new key, not an update of the key at 1 s");
  assert.equal(r.tracks[0].keysUpdated, 0);
  const ks = prop(layer, OPACITY).keys;
  assert.equal(ks.length, 2);
  assert.deepEqual([ks[0].time, ks[0].value], [1, 90], "the key at 1 s still holds 90");
  assert.equal(ks[1].value, 70);
  assert.ok(ks[1].time > 1, "the new key is after 1 s");
});

check("B2.1-2. replace removes a neighbour one storage step from a written key, instead of refusing", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 10 });
  seed(prop(layer, OPACITY), [{ t: 1, v: 90 }, { t: NEAR, v: 70 }]);
  const r = ok(run.keys([t(5, OPACITY, "replace", [{ frame: 0, value: 40 }, { frame: 30, value: 80 }])]));
  assert.equal(r.tracks[0].keysRemoved, 1);
  assert.deepEqual(prop(layer, OPACITY).keys.map((k) => [k.time, k.value]), [[0, 40], [1, 80]]);
});

check("B2.1-3. repeated writes at one time update the one key; a time on the same storage step is that key too", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 10 });
  let r = ok(run.keys([t(5, OPACITY, "merge", [{ time: 1, value: 10 }])]));
  assert.equal(r.tracks[0].keysAdded, 1);
  r = ok(run.keys([t(5, OPACITY, "merge", [{ time: 1, value: 20 }])]));
  assert.deepEqual([r.tracks[0].keysAdded, r.tracks[0].keysUpdated], [0, 1]);
  // 0.4 of a step (1/30720 s at 30 fps) later: After Effects stores it at 1 s.
  r = ok(run.keys([t(5, OPACITY, "merge", [{ time: 1 + 0.4 / 30720, value: 30 }])]));
  assert.deepEqual([r.tracks[0].keysAdded, r.tracks[0].keysUpdated], [0, 1]);
  assert.deepEqual(prop(layer, OPACITY).keys.map((k) => [k.time, k.value]), [[1, 30]]);
});

check("B2.1-4. the 15-minute 30 fps workflow: frame keys across the comp, a frame stored one step off still matches its key", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 900 });
  const frames = [0, 30, 1799, 9000, 17981, 26999, 27000];
  ok(run.keys([t(5, ROT, "replace", frames.map((f) => ({ frame: f, value: f })))]));
  const ks = prop(layer, ROT).keys;
  assert.equal(ks.length, frames.length);
  // Frame 17981 (599.37 s) is stored one step early — After Effects' own rounding (recipe 61).
  assert.equal(ks[4].time, 599.3666341145833);
  // Updating each frame by number matches its key, wherever After Effects stored it.
  const r = ok(run.keys([t(5, ROT, "merge", frames.map((f) => ({ frame: f, value: f + 1 })))]));
  assert.deepEqual([r.tracks[0].keysAdded, r.tracks[0].keysUpdated], [0, frames.length]);
  assert.deepEqual(prop(layer, ROT).keys.map((k) => k.value), frames.map((f) => f + 1));
  // A replace keeping half of them removes exactly the other half.
  const keep = [0, 9000, 17981, 27000];
  const r2 = ok(run.keys([t(5, ROT, "replace", keep.map((f) => ({ frame: f, value: 1000 + f })))]));
  assert.equal(r2.tracks[0].keysRemoved, 3);
  assert.deepEqual(prop(layer, ROT).keys.map((k) => k.value), keep.map((f) => 1000 + f));
});

check("B2.1-5. untouched keys keep their time, value and metadata; the expression is left alone", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 10 });
  const p = prop(layer, OPACITY);
  seed(p, [{ t: 1, v: 90, meta: { label: 3 } }, { t: 2, v: 50, meta: { label: 5 } }]);
  p.expression = "value"; p.expressionEnabled = true;
  ok(run.keys([t(5, OPACITY, "merge", [{ time: NEAR, value: 70 }])]));
  assert.deepEqual(p.keys.map((k) => [k.time, k.value, k.label]), [[1, 90, 3], [p.keys[1].time, 70, 0], [2, 50, 5]]);
  assert.equal(p.expression, "value");
});

check("B2.1-6. rollback puts every key back at its exact stored time, also where rewriting that time would move it", () => {
  const layer = richLayer();
  layer.stretch = 61;
  const run = load([layer], { fps: 30, duration: 900 });
  // A stored time the stub's (and After Effects') rounding does not map onto itself: rewriting it
  // at its own time would land a step away, which is what __kwWriteTimeFor exists for.
  let shifty = null;
  for (let tt = 500; tt < 899 && shifty === null; tt += 0.0137) {
    const st = storedTime(prop(layer, OPACITY), tt);
    if (storedTime(prop(layer, OPACITY), st) !== st) shifty = st;
  }
  assert.ok(shifty !== null, "the model must have a non-idempotent stored time to test against");
  const p = prop(layer, OPACITY);
  // Existing keys sit where After Effects stores them on this stretched layer.
  const one = storedTime(p, 1);
  seed(p, [{ t: one, v: 10 }, { t: shifty, v: 20 }]);
  // A second track whose interpolation AE silently refuses: the readback fails, everything rolls back.
  const rot = prop(layer, ROT);
  rot.ignore = { setInterpolationTypeAtKey: true };
  const err = refused(run.keys([
    t(5, OPACITY, "replace", [{ time: 3, value: 99 }]),
    t(5, ROT, "merge", [{ time: 1, value: 5, interpolation: { in: "hold", out: "hold" } }]),
  ]), /Rolled back every track/);
  assert.doesNotMatch(err, /INCOMPLETE/);
  assert.deepEqual(p.keys.map((k) => [k.time, k.value]), [[one, 10], [shifty, 20]], "both keys back at their exact stored times");
});

check("B2.1-8. a merge writes at the requested time, never at the matched key's stored time (which can move it)", () => {
  const layer = richLayer();
  layer.stretch = 61;
  const run = load([layer], { fps: 30, duration: 900 });
  const p = prop(layer, OPACITY);
  let asked = null, at = null;
  for (let tt = 500; tt < 899 && asked === null; tt += 0.0137) {
    const st = storedTime(p, tt);
    if (storedTime(p, st) !== st) { asked = tt; at = st; }
  }
  assert.ok(asked !== null);
  ok(run.keys([t(5, OPACITY, "merge", [{ time: asked, value: 20 }])]));
  assert.deepEqual(p.keys.map((k) => k.time), [at]);
  // The same request again is the same key: an update. Writing at `at` instead would land a step away.
  const r = ok(run.keys([t(5, OPACITY, "merge", [{ time: asked, value: 30 }])]));
  assert.deepEqual([r.tracks[0].keysAdded, r.tracks[0].keysUpdated], [0, 1]);
  assert.deepEqual(p.keys.map((k) => [k.time, k.value]), [[at, 30]]);
});

check("B2.1-9. several keys at once on a stretched layer — where After Effects reads values back a hair off — are told apart", () => {
  // The live proof's case: frames 30, 9000, 17981 and 26000 at 30 fps, stretch 61%, start 0.123.
  const layer = richLayer();
  layer.stretch = 61;
  layer.startTime = 0.123;
  const run = load([layer], { fps: 30, duration: 900 });
  const frames = [30, 9000, 17981, 26000];
  const r = ok(run.keys([t(5, ROT, "replace", frames.map((f) => ({ frame: f, value: f })))]));
  assert.equal(r.tracks[0].actualKeyCount, 4);
  const r2 = ok(run.keys([t(5, ROT, "merge", frames.map((f) => ({ frame: f, value: f + 1 })))]));
  assert.deepEqual([r2.tracks[0].keysAdded, r2.tracks[0].keysUpdated], [0, 4]);
});

check("B2.1-7. the scratch comp is removed after a success, a refusal before writing, and a rollback", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 10 });
  ok(run.keys([t(5, OPACITY, "merge", [{ time: 1, value: 10 }])]));
  refused(run.keys([t(5, OPACITY, "merge", [{ time: 1, value: 1 }, { time: 1, value: 2 }])]), /same After Effects key/);
  prop(layer, ROT).ignore = { setInterpolationTypeAtKey: true };
  refused(run.keys([t(5, ROT, "merge", [{ time: 1, value: 5, interpolation: { in: "hold", out: "hold" } }])]), /Rolled back/);
  assert.ok(run.ctx.__scratch.length >= 3, "one scratch comp per call");
  assert.ok(run.ctx.__scratch.every((c) => c.removed), "every scratch comp was removed");
  assert.ok(run.ctx.__scratch.every((c) => c.frameDuration === 1 / 30), "each took the target comp's frameDuration");
});

// ---------------------------------------------------------------------------
// B2.1 — a scratch comp that will not go away is reported, never swallowed
// ---------------------------------------------------------------------------
// Reproduced by Codex: with remove() throwing, a successful write came back
// plain ok and a validation refusal said "Nothing was changed", each with the
// scratch comp still in the project.
const leftovers = (run) => run.ctx.__scratch.filter((c) => !c.removed);
const CLEANUP = /Cleanup FAILED: the scratch comp "__ae_mcp_key_time_probe__" \(project item id 9\d{3}\)[\s\S]*could not be removed \(After Effects error: remove refused \(stub\)\) and is still in the project\. It holds no animation of yours — delete it with delete_project_item\(\{itemId: 9\d{3}\}\)\. Do not re-send this set_keyframes request because of it\./;

check("B2.1-10. set-up failure: nothing written, and a scratch comp it could not remove is named", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 10 });
  run.ctx.__fault.scratchAddTextFails = true;
  // Removal works: the error says nothing was applied, and nothing is left.
  let err = refused(run.keys([t(5, OPACITY, "merge", [{ time: 1, value: 10 }])]), /key-time check could not be prepared \(After Effects error: addText failed \(stub\)\)\. The animation was not applied — nothing was written to any of your properties\./);
  assert.doesNotMatch(err, /Cleanup FAILED/);
  assert.equal(leftovers(run).length, 0);
  // Removal fails too: the same, plus the leftover named.
  run.ctx.__fault.scratchRemove = "throw";
  err = refused(run.keys([t(5, OPACITY, "merge", [{ time: 1, value: 10 }])]), /The animation was not applied — nothing was written to any of your properties\./);
  assert.match(err, CLEANUP);
  assert.equal(leftovers(run).length, 1);
  assert.equal(writes.length, 0);
  assert.equal(prop(layer, OPACITY).keys.length, 0);
});

check("B2.1-11. success: the animation is reported applied, with the leftover named and no call to retry", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 10 });
  run.ctx.__fault.scratchRemove = "throw";
  const r = ok(run.keys([t(5, OPACITY, "merge", [{ time: 1, value: 10 }])]));
  assert.equal(r.tracks[0].keysAdded, 1);
  assert.equal(r.scratchCompLeftover, true);
  assert.match(r.warning, /^The animation WAS applied, exactly as the tracks above report\. /);
  assert.match(r.warning, CLEANUP);
  assert.deepEqual(prop(layer, OPACITY).keys.map((k) => [k.time, k.value]), [[1, 10]]);
  assert.equal(leftovers(run).length, 1);
  // A remove() After Effects accepts but that leaves the item is caught by checking the project.
  run.ctx.__fault.scratchRemove = "noop";
  const r2 = ok(run.keys([t(5, OPACITY, "merge", [{ time: 2, value: 20 }])]));
  assert.match(r2.warning, /could not be removed \(After Effects accepted remove\(\) but the item is still in the project\)/);
  // And with removal working again, no warning at all.
  run.ctx.__fault.scratchRemove = null;
  const r3 = ok(run.keys([t(5, OPACITY, "merge", [{ time: 3, value: 30 }])]));
  assert.equal(r3.warning, undefined);
  assert.equal(r3.scratchCompLeftover, undefined);
});

check("B2.1-12. preflight refusal: the original refusal stays whole, says the animation is unchanged, and names the leftover", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 10 });
  run.ctx.__fault.scratchRemove = "throw";
  const err = refused(run.keys([t(5, OPACITY, "merge", [{ time: 1, value: 1 }, { time: 1, value: 2 }])]));
  assert.match(err, /^set_keyframes: track 1 \(layer 5, ADBE Transform Group > ADBE Opacity\): key [12] \(1s\) lands on the same After Effects key as key [12] \(1s\)[\s\S]*Nothing was changed\. None of your animation was changed: the request was refused before anything was written\. Cleanup FAILED/);
  assert.match(err, CLEANUP);
  assert.equal(writes.length, 0);
  assert.equal(prop(layer, OPACITY).keys.length, 0);
});

check("B2.1-13. rollback: the original failure and rollback report stay whole, the animation is stated restored, the leftover named", () => {
  const layer = richLayer();
  const run = load([layer], { fps: 30, duration: 10 });
  seed(prop(layer, OPACITY), [{ t: 1, v: 90 }]);
  prop(layer, ROT).ignore = { setInterpolationTypeAtKey: true };
  run.ctx.__fault.scratchRemove = "throw";
  const err = refused(run.keys([
    t(5, OPACITY, "replace", [{ time: 2, value: 5 }]),
    t(5, ROT, "merge", [{ time: 1, value: 5, interpolation: { in: "hold", out: "hold" } }]),
  ]));
  assert.match(err, /^set_keyframes: track 2 [\s\S]*failed — the keys did not land as asked[\s\S]*Rolled back every track this call touched [\s\S]*so no animation changed\. Your animation is as it was: what this call wrote was rolled back\. Cleanup FAILED/);
  assert.match(err, CLEANUP);
  assert.deepEqual(prop(layer, OPACITY).keys.map((k) => [k.time, k.value]), [[1, 90]]);
});

console.log(`set-keyframes: ${passed} checks passed`);
