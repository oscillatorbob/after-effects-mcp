// Layer timing and Time Remap: set_layer_timing, set_time_remap, the timing
// record in get_layer_structure and set_layer's timing fields
// (packages/jsx/timing.jsx).
//
// The stub reproduces what After Effects 26.5x89 was measured to do
// (docs/fragile-areas-ae.md, "Layer timing and Time Remap"; recipe 56), including the parts
// that fail silently: a footage/precomp layer without Time Remap CLAMPS its
// trims to the source, setting inPoint DRAGS outPoint, outPoint accepts a value
// before inPoint, stretch under 1 becomes 0.999451, enabling Time Remap moves a
// trimmed layer's out point, disabling deletes every key and keeps the
// expression, and a camera "accepts" timeRemapEnabled as a plain property. So
// a guard that goes missing shows up as a wrong stub layer, the way it would
// in the user's comp. WRITES counts every mutating call.
//
//   node tests/unit/layer-timing.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`layer-timing FAILED: ${name}`); throw e; }
}

const STUB = String.raw`
function CompItem() {} function FolderItem() {} function FootageItem() {}
function AVLayer() {} function TextLayer() {} function ShapeLayer() {} function CameraLayer() {} function LightLayer() {}
function SolidSource() {} function FileSource() {} function PlaceholderSource() {}
TextLayer.prototype = new AVLayer(); ShapeLayer.prototype = new AVLayer();
var TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013 };
var KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
var PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
var PropertyValueType = { OneD: 6417 };
var NEXT_ID = 100, ITEMS = [], WRITES = 0, UNDO = [], FD = 1 / 30;
var BREAK_STRETCH = 0;              // the next N stretch writes land 3 points off, as a store AE did not keep
function W() { WRITES++; }
function locked(l, what) { if (l.locked) throw new Error("After Effects error: Can not set attribute “" + what + "” on Layer “" + l._name + "” because the Layer is locked."); }

// ---------- a keyed property (Time Remap, Opacity) ----------
function KProp(name) { this.name = name; this.matchName = name; this._k = []; this.expression = ""; this.expressionEnabled = false;
  this.propertyType = PropertyType.PROPERTY; this.propertyValueType = PropertyValueType.OneD; this.canSetExpression = true; }
KProp.prototype.__defineGetter__("numKeys", function () { return this._k.length; });
KProp.prototype.keyTime = function (i) { return this._k[i - 1].t; };
KProp.prototype.keyValue = function (i) { return this._k[i - 1].v; };
KProp.prototype.keyInInterpolationType = function (i) { return this._k[i - 1].ii; };
KProp.prototype.keyOutInterpolationType = function (i) { return this._k[i - 1].oi; };
KProp.prototype.keyTemporalContinuous = function () { return false; };
KProp.prototype.keyTemporalAutoBezier = function () { return false; };
KProp.prototype.keyLabel = function (i) { return this._k[i - 1].label || 0; };
KProp.prototype.setValueAtTime = function (t, v) { W();
  for (var i = 0; i < this._k.length; i++) if (Math.abs(this._k[i].t - t) < 1e-6) { this._k[i].v = v; return; }
  this._k.push({ t: t, v: v, ii: 6612, oi: 6612 }); this._k.sort(function (a, b) { return a.t - b.t; }); };
KProp.prototype._map = function (f) { for (var i = 0; i < this._k.length; i++) this._k[i].t = f(this._k[i].t); this._k.sort(function (a, b) { return a.t - b.t; }); };

// ---------- layers ----------
function decorate(l, comp, name, src) {
  l.id = ++NEXT_ID; l._comp = comp; l._name = name; l.source = src || null;
  l._st = 0; l._in = 0; l._out = src && src.duration > 0 && !(src.mainSource && src.mainSource.isStill) ? src.duration : comp.duration; l._sx = 100;
  l.locked = false; l.enabled = true; l.shy = false; l.solo = false; l.label = 0; l._parent = null; l._matte = null;
  l._tr = false; l._trProp = new KProp("ADBE Time Remapping"); l._op = new KProp("ADBE Opacity");
  if (!(l instanceof CameraLayer) && !(l instanceof LightLayer)) { l.threeDLayer = false; l.adjustmentLayer = false; l.guideLayer = false; l.nullLayer = false; }
  return l;
}
function srcDur(l) { var s = l.source; if (!s || !(s.duration > 0)) return null; if (s.mainSource && s.mainSource.isStill) return null; return s.duration; }
function bounded(l) { return srcDur(l) !== null && !l._tr; }
function hi(l) { return l._st + srcDur(l) * l._sx / 100; }
function clampIn(l, v) { if (!bounded(l)) return v; return Math.max(l._st, Math.min(v, hi(l))); }
function clampOut(l, v) { if (!bounded(l)) return v; return Math.max(l._st, Math.min(v, hi(l))); }
function allKeys(l, f) { l._trProp._map(f); l._op._map(f); }
var LP = {
  get name() { return this._name; }, set name(v) { locked(this, "name"); W(); this._name = v; },
  get index() { return this._comp._layers.indexOf(this) + 1; },
  get containingComp() { return this._comp; },
  get parent() { return this._parent; },
  get hasTrackMatte() { return !!this._matte; }, get trackMatteLayer() { return this._matte; }, get trackMatteType() { return this._matte ? 5013 : 5012; },
  get isTrackMatte() { return false; },
  get startTime() { return this._st; },
  set startTime(v) { locked(this, "startTime"); if (typeof v !== "number" || v !== v) throw new Error("After Effects error: Unable to set “startTime”. NaN is not a number."); W();
    var d = v - this._st; this._st = v; this._in += d; this._out += d; allKeys(this, function (t) { return t + d; }); },
  get inPoint() { return this._in; },
  set inPoint(v) { locked(this, "inPoint"); W(); var old = this._in; this._in = clampIn(this, v); this._out = clampOut(this, this._out + (this._in - old)); },
  get outPoint() { return this._out; },
  set outPoint(v) { locked(this, "outPoint"); W(); this._out = clampOut(this, v); },   // accepts out <= in, as AE does
  get stretch() { return this._sx; },
  set stretch(v) { locked(this, "stretch");
    if (Math.abs(v) > 9900) throw new Error("After Effects error: Unable to set “stretch”. Value " + v + " out of range -9900 to 9900.");
    W();
    if (Math.abs(v) < 1) v = v < 0 ? -0.999451 : 0.999451;
    if (BREAK_STRETCH > 0) { BREAK_STRETCH--; v = v + 3; }
    v = Math.fround(v / 100) * 100;                       // a float32 factor: 120 reads 120.000004768372
    var st = this._st, k = v / this._sx, flip = (v < 0) !== (this._sx < 0) ? FD / 100 : 0;
    var f = function (t) { return st + (t - st) * k - flip; };
    this._in = f(this._in); this._out = f(this._out); allKeys(this, f); this._sx = v; },
  get canSetTimeRemapEnabled() { return srcDur(this) !== null; },
  get timeRemapEnabled() { return this._tr; },
  set timeRemapEnabled(v) {
    if (srcDur(this) === null) throw new Error("After Effects error: Can not set timeRemapEnabled on Layer “" + this._name + "”. Check layer.canSetTimeRemapEnabled before setting.");
    locked(this, "timeRemapEnabled"); W();
    var d = srcDur(this);
    if (v && !this._tr) {
      var end = this._st + d * this._sx / 100;
      var atNaturalEnd = Math.abs(this._out - end) < 1e-6;
      this._tr = true;
      this._trProp._k = [{ t: this._st, v: 0, ii: 6612, oi: 6612 }, { t: end, v: d, ii: 6612, oi: 6612 }];
      if (atNaturalEnd && this._in > this._st + 1e-6) this._out = this._in + d * this._sx / 100;   // AE moves the out point
    } else if (!v && this._tr) {
      this._tr = false; this._trProp._k = [];                      // every key deleted; the expression stays stored
      this._in = clampIn(this, this._in); this._out = clampOut(this, this._out);
    }
  },
  get timeRemap() { return this._tr ? this._trProp : null; },
  property: function (k) { if (k === "ADBE Time Remapping" || k === "Time Remap") return this._trProp; return null; },
};
function install(proto) { for (var k in LP) Object.defineProperty(proto, k, Object.getOwnPropertyDescriptor(LP, k)); }
install(AVLayer.prototype);
// Cameras and lights have no Time Remap at all: a script assignment just makes
// a plain property, and AE does nothing (measured).
var CAMLP = {};
for (var key in LP) if (key !== "canSetTimeRemapEnabled" && key !== "timeRemapEnabled" && key !== "timeRemap") CAMLP[key] = Object.getOwnPropertyDescriptor(LP, key);
for (var key2 in CAMLP) { Object.defineProperty(CameraLayer.prototype, key2, CAMLP[key2]); Object.defineProperty(LightLayer.prototype, key2, CAMLP[key2]); }

// ---------- project ----------
var ROOT = new FolderItem(); ROOT.id = 0; ROOT.name = "Root";
function addItem(it) { it.id = ++NEXT_ID; it.parentFolder = ROOT; ITEMS.push(it); return it; }
function mkComp(name, dur, fd) {
  var c = new CompItem(); c.name = name; c._layers = []; c.width = 1920; c.height = 1080; c.duration = dur || 10; c.frameDuration = fd || FD; c.frameRate = 1 / c.frameDuration; c.time = 0;
  c.__defineGetter__("numLayers", function () { return c._layers.length; });
  c.layer = function (i) { return c._layers[i - 1]; };
  return addItem(c);
}
function mkFootage(name, dur, still) { var f = new FootageItem(); f.name = name; f.duration = dur; f.mainSource = new FileSource(); f.mainSource.isStill = !!still; return addItem(f); }
function mkSolid(name) { var f = new FootageItem(); f.name = name; f.duration = 0; f.mainSource = new SolidSource(); f.mainSource.isStill = true; return addItem(f); }
function add(comp, kind, name, src) {
  var l = kind === "camera" ? new CameraLayer() : kind === "light" ? new LightLayer() : kind === "text" ? new TextLayer() : kind === "shape" ? new ShapeLayer() : new AVLayer();
  decorate(l, comp, name, src);
  comp._layers.unshift(l);
  return l;
}
var app = {
  beginUndoGroup: function (n) { UNDO.push("begin:" + n); }, endUndoGroup: function () { UNDO.push("end"); },
  project: {
    rootFolder: ROOT, file: null,
    get numItems() { return ITEMS.length; }, item: function (i) { return ITEMS[i - 1]; },
    itemByID: function (id) { for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].id === id) return ITEMS[i];
      throw new Error("After Effects error: internal verification failure, sorry! {Item Not Found}"); },
    save: function () { throw new Error("project save must never be called"); },
    saveWithDialog: function () { throw new Error("project save must never be called"); },
  },
};
`;

function load() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(STUB, ctx, { filename: "stub" });
  for (const f of ["core.jsx", "ids.jsx", "comps.jsx", "layers.jsx", "explore.jsx", "footage.jsx", "project.jsx", "structure.jsx", "timing.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const run = (op, args) => JSON.parse(vm.runInContext(`JSON.stringify(dispatchValue(${JSON.stringify({ op, args })}))`, ctx));
  const ok = (op, args) => { const r = run(op, args); assert.equal(r.ok, true, `${op} failed: ${r.error}`); return r.result; };
  const refused = (op, args, re) => {
    const w = ctx.WRITES;
    const r = run(op, args);
    assert.equal(r.ok, false, `${op} should have been refused`);
    if (re) assert.match(r.error, re);
    assert.equal(ctx.WRITES, w, `${op} wrote to the project before refusing`);
    return r.error;
  };
  const js = (src) => { const v = vm.runInContext(src, ctx); return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v; };
  return { ctx, run, ok, refused, js };
}

// One comp, 10 s at 30 fps: a 4 s clip, a 3 s precomp, a still, a solid, a
// text layer, a camera.
function rig() {
  const t = load();
  t.js(`var c = mkComp("Main", 10); var inner = mkComp("Inner", 3);
    var clipItem = mkFootage("clip.mp4", 4), stillItem = mkFootage("still.png", 0, true);
    var clip = add(c, "av", "clip", clipItem), pre = add(c, "av", "pre", inner), still = add(c, "av", "still", stillItem),
        solid = add(c, "av", "solid", mkSolid("s")), text = add(c, "text", "text"), cam = add(c, "camera", "cam");`);
  const id = (n) => t.js(`${n}.id`);
  return { ...t, cid: t.js("c.id"), clip: id("clip"), pre: id("pre"), still: id("still"), solid: id("solid"), text: id("text"), cam: id("cam") };
}
const T = (t, v) => t.js(`(function(){var l=${v};return [l.startTime,l.inPoint,l.outPoint,l.stretch];})()`);
const near = (a, b, tol = 1e-6) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= tol, `${JSON.stringify(a)} vs ${JSON.stringify(b)} at ${i}`));

// ---------------------------------------------------------------------------
check("1. read timing state: get_layer_structure carries timing and Time Remap state", () => {
  const t = rig();
  const s = t.ok("get_layer_structure", { compId: t.cid });
  assert.ok(Math.abs(s.frameDuration - 1 / 30) < 1e-12);
  const by = Object.fromEntries(s.layers.map((l) => [l.layerId, l.timing]));
  assert.deepEqual([by[t.clip].inPoint, by[t.clip].outPoint, by[t.clip].sourceDuration, by[t.clip].timeRemap.state], [0, 4, 4, "off"]);
  assert.equal(by[t.pre].sourceDuration, 3);
  assert.equal(by[t.still].sourceDuration, null, "a still has no length to run out of");
  assert.equal(by[t.still].timeRemap.state, "unsupported");
  assert.equal(by[t.cam].timeRemap.state, "unsupported", "a camera is unsupported, not a false 'off'");
  t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  const s2 = t.ok("get_layer_structure", { compId: t.cid });
  assert.deepEqual(s2.layers.find((l) => l.layerId === t.clip).timing.timeRemap, { state: "default", numKeys: 2, hasExpression: false });
});

check("2. set startTime slides the whole layer and its keys", () => {
  const t = rig();
  t.js("clip._op.setValueAtTime(1, 10)");
  const r = t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, startTime: 1 });
  near(T(t, "clip"), [1, 1, 5, 100]);
  assert.deepEqual(r.changedFields, ["startTime", "inPoint", "outPoint"]);
  assert.equal(t.js("clip._op.keyTime(1)"), 2, "keys move with startTime");
});

check("3. set inPoint trims only: outPoint stays even though AE's inPoint drags it", () => {
  const t = rig();
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, outPoint: 3 });
  t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  const r = t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, inPoint: 1 });
  near(T(t, "clip"), [0, 1, 3, 100]);
  assert.deepEqual(r.changedFields, ["inPoint"]);
});

check("4. set outPoint", () => {
  const t = rig();
  const r = t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, outPoint: 2.5 });
  near(T(t, "clip"), [0, 0, 2.5, 100]);
  assert.equal(r.after.outFrame, 75);
});

check("5. set stretch scales trims and keys about startTime", () => {
  const t = rig();
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, startTime: 1, inPoint: 2, outPoint: 4 });
  t.js("clip._op.setValueAtTime(3, 50)");
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, stretch: 200 });
  near(T(t, "clip"), [1, 3, 7, 200]);
  assert.equal(t.js("clip._op.keyTime(1)"), 5);
});

check("stretch is float32 in AE: 120 reads back 120.0000048 and still counts as landed", () => {
  const t = rig();
  const r = t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, stretch: 120 });
  assert.notEqual(r.after.stretch, 120);
  assert.ok(Math.abs(r.after.stretch - 120) < 1e-4);
  assert.deepEqual(r.changedFields.includes("stretch"), true);
  const again = t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, stretch: 120 });
  assert.equal(again.changed, false, "the float32 neighbour is the same stretch");
});

check("6. multi-field update lands in one call, in the measured order", () => {
  const t = rig();
  const r = t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, stretch: 50, startTime: 2, inPoint: 2.5, outPoint: 3.5 });
  near(T(t, "clip"), [2, 2.5, 3.5, 50]);
  assert.deepEqual(r.changedFields.sort(), ["inPoint", "outPoint", "startTime", "stretch"]);
  near([r.before.startTime, r.before.inPoint, r.before.outPoint, r.before.stretch], [0, 0, 4, 100]);
});

check("7. out <= in is refused before anything is written, naming where each value came from", () => {
  const t = rig();
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.clip, inPoint: 2, outPoint: 2 }, /end at or before it starts/);
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.solid, inPoint: 12 }, /outPoint .*not passed: the layer's current outPoint\)/);
  t.refused("set_layer", { compId: t.cid, layerId: t.solid, outPoint: -1 }, /end at or before it starts/);
  near(T(t, "solid"), [0, 0, 10, 100]);
});

check("8. invalid stretch: negative, under 1, over 9900, and the source bound — nothing written", () => {
  const t = rig();
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.clip, stretch: -100 }, /negative[\s\S]*Time Remap/);
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.clip, stretch: 0.5 }, /between 1 and 9900[\s\S]*0\.999451/);
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.clip, stretch: 10000 }, /between 1 and 9900/);
  t.refused("set_layer", { compId: t.cid, layerId: t.clip, stretch: -50 }, /negative/);
  // AE would clamp these silently:
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.clip, outPoint: 8 }, /past the source's end \(4\)[\s\S]*clamp/);
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.clip, startTime: 1, inPoint: 0.5 }, /before the source starts \(1\)/);
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.pre, outPoint: 3.5 }, /source is 3 s long/);
  near(T(t, "clip"), [0, 0, 4, 100]);
});

check("9. rollback: a write that does not land restores every field and says so", () => {
  const t = rig();
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.solid, startTime: 1, inPoint: 2, outPoint: 6 });
  t.js("BREAK_STRETCH = 1");
  const r = t.run("set_layer_timing", { compId: t.cid, layerId: t.solid, stretch: 150, startTime: 2 });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not land[\s\S]*stretch: asked 150, After Effects reads 15[23][\s\S]*[Oo]riginal timing was restored and read back/);
  near(T(t, "solid"), [1, 2, 6, 100]);
  // A fault that persists through the restore is reported as such, never as restored.
  t.js("BREAK_STRETCH = 2");
  const r2 = t.run("set_layer_timing", { compId: t.cid, layerId: t.solid, stretch: 150 });
  assert.match(r2.error, /[Rr]estore did not land either[\s\S]*use Undo/);
});

check("10. 23.976: frames convert with the comp's own frameDuration and read back whole", () => {
  const t = load();
  t.js(`var c = mkComp("F", 30, 1/23.976); var item = mkFootage("long.mov", 25); var l = add(c, "av", "l", item);`);
  const cid = t.js("c.id"), lid = t.js("l.id"), fd = t.js("c.frameDuration");
  for (const F of [0, 1, 12, 99, 150, 240]) {
    const r = t.ok("set_layer_timing", { compId: cid, layerId: lid, startFrame: F, inFrame: F + 5, outFrame: F + 100 });
    assert.deepEqual([r.after.startFrame, r.after.inFrame, r.after.outFrame], [F, F + 5, F + 100], `frame ${F}`);
    assert.ok(Math.abs(r.after.startTime - F * fd) < 1e-12);
    assert.equal(r.frameDuration, fd);
  }
  t.refused("set_layer_timing", { compId: cid, layerId: lid, startFrame: 1.5 }, /whole number of frames/);
  t.refused("set_layer_timing", { compId: cid, layerId: lid, startFrame: 1, startTime: 0 }, /not both/);
});

check("11-12. enable Time Remap: the two default keys come back, read from AE", () => {
  const t = rig();
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, startTime: 1, stretch: 200 });
  const r = t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  assert.deepEqual([r.enabled, r.previousEnabled, r.changed], [true, false, true]);
  assert.equal(r.timeRemap.state, "default");
  assert.deepEqual(r.timeRemap.keys.map((k) => [k.time, k.value, k.interpolation.in, k.interpolation.out]), [[1, 0, "linear", "linear"], [9, 4, "linear", "linear"]]);
  assert.deepEqual(r.timeRemap.path, ["ADBE Time Remapping"]);
  const again = t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  assert.equal(again.changed, false);
});

check("enable puts back the trim After Effects moved, and reports it", () => {
  const t = rig();
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, inPoint: 1.5 });
  const r = t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  near(T(t, "clip"), [0, 1.5, 4, 100]);
  assert.equal(r.trimRestored, true);
  assert.equal(r.aeMovedTrim.outPoint.to, 5.5);
});

check("13. disable a default Time Remap without any flag; the clamp is reported", () => {
  const t = rig();
  t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, outPoint: 8 });     // legal with Time Remap on
  const r = t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: false });
  assert.deepEqual([r.enabled, r.changed, r.discarded], [false, true, undefined]);
  assert.deepEqual(r.trimClamped.outPoint, { from: 8, to: 4 });
  assert.equal(t.js("clip.timeRemapEnabled"), false);
});

check("14. custom keys: disabling is refused, the keys are listed, nothing changes", () => {
  const t = rig();
  t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  t.js("clip._trProp.setValueAtTime(2, 1)");
  const w = t.refused("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: false }, /customized[\s\S]*DELETES every Time Remap key — 3 here[\s\S]*discardTimeRemap:true/);
  assert.match(w, /2s=1/);
  assert.equal(t.js("clip._trProp.numKeys"), 3);
  // A moved default key is custom too: two keys is not proof of default.
  t.js("clip._trProp._k = [{t:0,v:0,ii:6612,oi:6612},{t:4,v:3.5,ii:6612,oi:6612}]");
  t.refused("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: false }, /key 2 is at 4 s with value 3\.5/);
  t.js("clip._trProp._k[1].v = 4; clip._trProp._k[1].oi = 6614");
  t.refused("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: false }, /not linear/);
});

check("15. an expression makes Time Remap custom: disabling is refused", () => {
  const t = rig();
  t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  t.js("clip._trProp.expression = 'time*2'; clip._trProp.expressionEnabled = true");
  t.refused("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: false }, /has an expression[\s\S]*"time\*2" stops rendering/);
});

check("16. discardTimeRemap disables a customized one and reports exactly what went", () => {
  const t = rig();
  t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  t.js("clip._trProp.setValueAtTime(2, 1); clip._trProp.expression = 'value'");
  const r = t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: false, discardTimeRemap: true });
  assert.equal(r.discarded.numKeys, 3);
  assert.deepEqual(r.discarded.keys.map((k) => k.value), [0, 1, 4]);
  assert.equal(r.discarded.expression, "value");
  // Re-enabling revives the stored expression, and says so.
  const re = t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  assert.equal(re.expressionReactivated, "value");
  assert.equal(re.timeRemap.state, "custom");
  t.refused("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true, discardTimeRemap: true }, /only applies when disabling/);
});

check("17. unsupported layer types are refused — the camera's silent 'success' included", () => {
  const t = rig();
  for (const k of ["still", "solid", "text", "cam"]) {
    t.refused("set_time_remap", { compId: t.cid, layerId: t[k], enabled: true }, /supports Time Remap only on footage/);
  }
  assert.equal(t.js("Object.prototype.hasOwnProperty.call(cam, 'timeRemapEnabled')"), false, "no junk property on the camera");
  // Timing itself works on every type, unbounded where there is no source length.
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.cam, inPoint: -2, outPoint: 15 });
  near(T(t, "cam"), [0, -2, 15, 100]);
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.still, outPoint: 20 });
});

check("18. stable layer ids", () => {
  const t = rig();
  const before = t.js("(function(){var o=[];for(var i=1;i<=c.numLayers;i++)o.push(c.layer(i).id);return o;})()");
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, startTime: 1, stretch: 150 });
  t.ok("set_time_remap", { compId: t.cid, layerId: t.pre, enabled: true });
  t.ok("set_time_remap", { compId: t.cid, layerId: t.pre, enabled: false });
  assert.deepEqual(t.js("(function(){var o=[];for(var i=1;i<=c.numLayers;i++)o.push(c.layer(i).id);return o;})()"), before);
});

check("19. locked layers are refused (as C3 does); set_layer may unlock and retime in one call", () => {
  const t = rig();
  t.js("clip.locked = true");
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.clip, startTime: 1 }, /locked[\s\S]*set_layer locked:false/);
  t.refused("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true }, /locked/);
  t.refused("set_layer", { compId: t.cid, layerId: t.clip, inPoint: 1 }, /locked/);
  const r = t.ok("set_layer", { compId: t.cid, layerId: t.clip, locked: false, inPoint: 1 });
  near(T(t, "clip"), [0, 1, 4, 100]);
  assert.equal(r.locked, false);
  t.ok("set_layer", { compId: t.cid, layerId: t.clip, outPoint: 3, locked: true });
  near(T(t, "clip"), [0, 1, 3, 100]);
  assert.equal(t.js("clip.locked"), true, "timing first, then the lock");
});

check("20. the Time Remap path B2 uses resolves to the property set_time_remap created", () => {
  const t = rig();
  const r = t.ok("set_time_remap", { compId: t.cid, layerId: t.pre, enabled: true });
  assert.deepEqual(r.timeRemap.path, ["ADBE Time Remapping"]);
  assert.equal(t.js(`pre.property("${r.timeRemap.path[0]}") === pre.timeRemap`), true);
  assert.match(r.next, /set_keyframes at path \["ADBE Time Remapping"\]/);
  assert.match(read("keywrite.jsx"), /turn it on first with set_time_remap/);
});

check("reversed layers: only a positive stretch alone is accepted, and the times come back", () => {
  const t = rig();
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, startTime: 1, inPoint: 1.5, outPoint: 3.5 });
  t.js("clip.stretch = -100");
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.clip, inPoint: 2 }, /reversed/);
  t.refused("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true }, /reversed/);
  const s = t.ok("get_layer_structure", { compId: t.cid });
  assert.ok(s.layers.find((l) => l.layerId === t.clip).timing.stretch < 0);
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, stretch: 100 });
  near(T(t, "clip"), [1, 1.5, 3.5, 100]);
});

check("a request that changes nothing writes nothing", () => {
  const t = rig();
  const w = t.ctx.WRITES;
  const r = t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, inPoint: 0, outPoint: 4 });
  assert.deepEqual([r.changed, r.changedFields], [false, []]);
  assert.equal(t.ctx.WRITES, w);
  t.refused("set_layer_timing", { compId: t.cid, layerId: t.clip }, /at least one/);
});

check("24. no project save, and one undo group per call", () => {
  const t = rig();
  t.js("UNDO.length = 0");
  t.ok("set_layer_timing", { compId: t.cid, layerId: t.clip, stretch: 120 });
  t.ok("set_time_remap", { compId: t.cid, layerId: t.clip, enabled: true });
  assert.deepEqual(t.js("UNDO").filter((u) => u.startsWith("begin")).length, 2);
  for (const f of ["timing.jsx"]) assert.doesNotMatch(read(f), /\.save\(|saveWithDialog/);
});

// ---------------------------------------------------------------------------
// Schemas, classification, run_batch
// ---------------------------------------------------------------------------
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { validateBatchOps, parseOpArgs } = await import(dist("tools", "batchSteps.js"));
const { schemas } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "index.js")).href);

check("21. strict schemas", () => {
  assert.throws(() => parseOpArgs("set_layer_timing", { compId: 1, layerId: 2, inPoint: 1, bogus: 1 }), /bogus|unrecognized/i);
  assert.throws(() => parseOpArgs("set_layer_timing", { compId: 1, layerId: 2, inPoint: 1, inFrame: 3 }), /not both|at most one/i);
  assert.throws(() => parseOpArgs("set_layer_timing", { compId: 1, layerId: 2, startFrame: 1.5 }));
  assert.throws(() => parseOpArgs("set_layer_timing", { compId: 1, layerId: 2, stretch: -100 }));
  assert.throws(() => parseOpArgs("set_layer_timing", { compId: 1, layerId: 2, stretch: 0.5 }));
  assert.throws(() => parseOpArgs("set_layer_timing", { compId: 1, layerId: 2, stretch: 9901 }));
  assert.deepEqual(parseOpArgs("set_layer_timing", { compId: 1, layerId: 2, inFrame: -3 }), { compId: 1, layerId: 2, inFrame: -3 });
  assert.equal(parseOpArgs("set_time_remap", { compId: 1, layerId: 2, enabled: false }).discardTimeRemap, false);
  assert.throws(() => parseOpArgs("set_time_remap", { compId: 1, layerId: 2 }));
  assert.throws(() => parseOpArgs("set_time_remap", { compId: 1, layerId: 2, enabled: true, force: true }));
});

check("22. mutation classification", () => {
  assert.equal(schemas.OpMutation.set_layer_timing, "write");
  assert.equal(schemas.OpMutation.set_time_remap, "write");
  assert.equal(schemas.OpMutation.get_layer_structure, "read");
});

check("23. run_batch: an invalid later timing step blocks the whole batch before any is sent", () => {
  const good = { op: "set_layer_timing", args: { compId: 1, layerId: 2, startFrame: 10 } };
  const out = validateBatchOps([good, { op: "set_time_remap", args: { compId: 1, layerId: 2, enabled: true } }]);
  assert.equal(out[1].args.discardTimeRemap, false, "defaults applied per step");
  assert.throws(() => validateBatchOps([good, { op: "set_layer_timing", args: { compId: 1, layerId: 2, stretch: -1 } }]), /Nothing was sent[\s\S]*step 1 /);
  assert.throws(() => validateBatchOps([good, { op: "set_time_remap", args: { compId: 1, layerId: 2, enabled: "yes" } }]), /Nothing was sent[\s\S]*step 1 /);
});

console.log(`layer-timing: ${passed} checks passed`);
