// The Effects stack's structure: get_effect_stack, add_effect, remove_effect,
// duplicate_effect, move_effect (packages/jsx/effectstack.jsx).
//
// The stub reproduces what After Effects 26.5x89 was measured to do
// (docs/fragile-areas-ae.md, "Effect stack"; recipe 57), including the parts
// that fail silently: an effect has no id; every held handle into the stack
// goes invalid after any add/remove/duplicate/move ("Object is invalid"); AE
// names a second Glow "Glow 2" but accepts a rename to an existing name;
// duplicate() lands directly below its source; a CUSTOM_VALUE parameter cannot
// be read; cameras and lights have no Effects; a script is NOT stopped by a
// locked layer; and removing an effect an expression names breaks that
// expression with no error anywhere else. So a guard that goes missing shows up
// as a wrong stub stack, the way it would in the user's comp. WRITES counts
// every mutating call.
//
//   node tests/unit/effect-stack.mjs

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
  catch (e) { console.error(`effect-stack FAILED: ${name}`); throw e; }
}

const STUB = String.raw`
function CompItem() {} function FolderItem() {}
function AVLayer() {} function TextLayer() {} function ShapeLayer() {} function CameraLayer() {} function LightLayer() {}
TextLayer.prototype = new AVLayer(); ShapeLayer.prototype = new AVLayer();
var PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
var PropertyValueType = { NO_VALUE: 6412, OneD: 6417, COLOR: 6424, LAYER_INDEX: 6421, CUSTOM_VALUE: 6419 };
var KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
var NEXT_ID = 100, ITEMS = [], WRITES = 0, UNDO = [];
var BREAK_MOVE = 0;   // the next N moveTo calls land one place off, as a move AE did not make
var BREAK_DUP = 0;    // the next N duplicates lose the copy's expressions
function W() { WRITES++; }
function invalid() { throw new Error("Object is invalid"); }

var FX = {
  "ADBE Gaussian Blur 2": { display: "Gaussian Blur", params: [["ADBE Gaussian Blur 2-0001", "Blurriness", 6417, 0], ["ADBE Gaussian Blur 2-0002", "Blur Dimensions", 6417, 1]] },
  "ADBE Glo2": { display: "Glow", params: [["ADBE Glo2-0002", "Glow Threshold", 6417, 60], ["ADBE Glo2-0003", "Glow Radius", 6417, 10], ["ADBE Glo2-0004", "Glow Intensity", 6417, 1]] },
  "ADBE Tint": { display: "Tint", params: [["ADBE Tint-0001", "Map Black To", 6424, [0, 0, 0, 1]], ["ADBE Tint-0002", "Map White To", 6424, [1, 1, 1, 1]], ["ADBE Tint-0003", "Amount to Tint", 6417, 100]] },
  "ADBE CurvesCustom": { display: "Curves", params: [["ADBE CurvesCustom-0002", "Channel", 6417, 1], ["ADBE CurvesCustom-0001", "Curves", 6419, null]] },
  "ADBE Displacement Map": { display: "Displacement Map", params: [["ADBE Displacement Map-0001", "Displacement Map Layer", 6421, 1]] },
  "ADBE Slider Control": { display: "Slider Control", params: [["ADBE Slider Control-0001", "Slider", 6417, 0]] },
};
function fxByAny(k) { if (FX[k]) return k; for (var m in FX) if (FX[m].display === k) return m; return null; }

// ---------- models ----------
function Leaf(mn, nm, vt, v) { this.mn = mn; this.nm = nm; this.vt = vt; this.v = v instanceof Array ? v.slice() : v; this.k = []; this.ex = ""; this.exOn = false; }
function cloneLeaf(a) { var b = new Leaf(a.mn, a.nm, a.vt, a.v); for (var i = 0; i < a.k.length; i++) b.k.push({ t: a.k[i].t, v: a.k[i].v, ii: a.k[i].ii, oi: a.k[i].oi }); b.ex = a.ex; b.exOn = a.exOn; return b; }
function Eff(mn) {
  this.mn = mn; this.nm = FX[mn].display; this.on = true; this.leaves = [];
  for (var i = 0; i < FX[mn].params.length; i++) { var p = FX[mn].params[i]; this.leaves.push(new Leaf(p[0], p[1], p[2], p[3])); }
  this.comp = new Leaf("ADBE Effect Mask Opacity", "Effect Opacity", 6417, 100);
}
function cloneEff(e) { var c = new Eff(e.mn); c.nm = e.nm; c.on = e.on; c.leaves = []; for (var i = 0; i < e.leaves.length; i++) c.leaves.push(cloneLeaf(e.leaves[i])); c.comp = cloneLeaf(e.comp); return c; }
// AE's naming, measured: strip a trailing " N" to get the base, then use the
// base itself when adding and it is free, otherwise "base (highest N + 1)" —
// duplicating "Glow 2" beside Glow/Glow 2/Glow 3 gives "Glow 4", "Glow 7"
// gives "Glow 8", "Bloom" gives "Bloom 2".
function uniqueName(par, name, adding) {
  var m = /^(.*) (\d+)$/.exec(name), base = m ? m[1] : name, hi = 0, plainFree = true;
  for (var i = 0; i < par.list.length; i++) {
    var nm = par.list[i].nm;
    if (nm === base) { plainFree = false; hi = Math.max(hi, 1); }
    var mm = /^(.*) (\d+)$/.exec(nm);
    if (mm && mm[1] === base) hi = Math.max(hi, Number(mm[2]));
  }
  if (adding && plainFree) return base;
  return base + " " + (hi + 1);
}

// ---------- expression evaluation (only what effect references need) ----------
function exprError(layer, text) {
  var re = /(?:layer\("([^"]*)"\)\.)?effect\((?:"([^"]*)"|(\d+))\)/g, m;
  while ((m = re.exec(text)) !== null) {
    var l = layer;
    if (m[1] !== undefined) { l = null; var ls = layer._comp._layers; for (var i = 0; i < ls.length; i++) if (ls[i]._name === m[1]) { l = ls[i]; break; } }
    if (!l || !l._fx) return "Error: layer or effect is missing";
    var list = l._fx.list;
    if (m[2] !== undefined) {
      var found = false; for (var j = 0; j < list.length; j++) if (list[j].nm === m[2] || list[j].mn === m[2]) found = true;
      if (!found) return "Error: effect named '" + m[2] + "' is missing or does not exist. It may have been renamed, moved, deleted, or the name may have been mistyped";
    } else if (Number(m[3]) > list.length) return "Error: effect index " + m[3] + " out of range";
  }
  return "";
}

// ---------- handles ----------
// A handle into a stack remembers the stack's generation when it was made;
// any structural change bumps it, and every later use throws — as AE does.
function LeafH(leaf, par, gen, layer) { this._l = leaf; this._p = par; this._g = gen; this._layer = layer; }
LeafH.prototype._ck = function () { if (this._p && this._p.gen !== this._g) invalid(); };
LeafH.prototype.__defineGetter__("name", function () { this._ck(); return this._l.nm; });
LeafH.prototype.__defineGetter__("matchName", function () { this._ck(); return this._l.mn; });
LeafH.prototype.__defineGetter__("propertyType", function () { this._ck(); return PropertyType.PROPERTY; });
LeafH.prototype.__defineGetter__("propertyValueType", function () { this._ck(); return this._l.vt; });
LeafH.prototype.__defineGetter__("value", function () { this._ck();
  if (this._l.vt === 6419) throw new Error("After Effects error: Can not get or set a value from this property (matchname is “" + this._l.mn + "”). This propertyValueType CUSTOM_VALUE has not been implemented.");
  return this._l.v instanceof Array ? this._l.v.slice() : this._l.v; });
LeafH.prototype.__defineGetter__("numKeys", function () { this._ck(); return this._l.k.length; });
LeafH.prototype.keyTime = function (i) { this._ck(); return this._l.k[i - 1].t; };
LeafH.prototype.keyValue = function (i) { this._ck(); return this._l.k[i - 1].v; };
LeafH.prototype.keyInInterpolationType = function (i) { this._ck(); return this._l.k[i - 1].ii; };
LeafH.prototype.keyOutInterpolationType = function (i) { this._ck(); return this._l.k[i - 1].oi; };
LeafH.prototype.__defineGetter__("canSetExpression", function () { this._ck(); return this._l.vt !== 6419; });
LeafH.prototype.__defineGetter__("expression", function () { this._ck(); return this._l.ex; });
LeafH.prototype.__defineSetter__("expression", function (v) { this._ck(); W(); this._l.ex = v; this._l.exOn = v !== ""; });
LeafH.prototype.__defineGetter__("expressionEnabled", function () { this._ck(); return this._l.exOn; });
LeafH.prototype.__defineGetter__("expressionError", function () { this._ck(); return this._l.ex ? exprError(this._layer, this._l.ex) : ""; });
LeafH.prototype.setValue = function (v) { this._ck(); W(); this._l.v = v; };
LeafH.prototype.setValueAtTime = function (t, v) { this._ck(); W(); this._l.k.push({ t: t, v: v, ii: 6612, oi: 6612 }); this._l.k.sort(function (a, b) { return a.t - b.t; }); };

function GroupH(mn, nm, leaves, par, gen, layer) { this.matchName = mn; this.name = nm; this._leaves = leaves; this._p = par; this._g = gen; this._layer = layer; }
GroupH.prototype._ck = function () { if (this._p && this._p.gen !== this._g) invalid(); };
GroupH.prototype.__defineGetter__("propertyType", function () { return PropertyType.NAMED_GROUP; });
GroupH.prototype.__defineGetter__("numProperties", function () { this._ck(); return this._leaves.length; });
GroupH.prototype.property = function (k) { this._ck();
  for (var i = 0; i < this._leaves.length; i++) if ((typeof k === "number" && k === i + 1) || this._leaves[i].mn === k || this._leaves[i].nm === k) return new LeafH(this._leaves[i], this._p, this._g, this._layer);
  return null; };

function EffH(par, e) { this._p = par; this._e = e; this._g = par.gen; }
EffH.prototype._ck = function () { if (this._p.gen !== this._g || this._p.list.indexOf(this._e) < 0) invalid(); };
EffH.prototype.__defineGetter__("name", function () { this._ck(); return this._e.nm; });
EffH.prototype.__defineSetter__("name", function (v) { this._ck(); W(); this._e.nm = v; });
EffH.prototype.__defineGetter__("matchName", function () { this._ck(); return this._e.mn; });
EffH.prototype.__defineGetter__("enabled", function () { this._ck(); return this._e.on; });
EffH.prototype.__defineSetter__("enabled", function (v) { this._ck(); W(); this._e.on = !!v; });
EffH.prototype.__defineGetter__("propertyIndex", function () { this._ck(); return this._p.list.indexOf(this._e) + 1; });
EffH.prototype.__defineGetter__("propertyType", function () { return PropertyType.INDEXED_GROUP; });
EffH.prototype.__defineGetter__("numProperties", function () { this._ck(); return this._e.leaves.length + 1; });
EffH.prototype.property = function (k) { this._ck();
  var e = this._e;
  if (k === e.leaves.length + 1 || k === "ADBE Effect Built In Params" || k === "Compositing Options") return new GroupH("ADBE Effect Built In Params", "Compositing Options", [e.comp], this._p, this._g, this._p.layer);
  for (var i = 0; i < e.leaves.length; i++) if ((typeof k === "number" && k === i + 1) || e.leaves[i].mn === k || e.leaves[i].nm === k) return new LeafH(e.leaves[i], this._p, this._g, this._p.layer);
  return null; };
EffH.prototype.duplicate = function () { this._ck(); W();
  var c = cloneEff(this._e); c.nm = uniqueName(this._p, this._e.nm);
  if (BREAK_DUP > 0) { BREAK_DUP--; for (var i = 0; i < c.leaves.length; i++) { c.leaves[i].ex = ""; c.leaves[i].exOn = false; } }
  var at = this._p.list.indexOf(this._e) + 1; this._p.list.splice(at, 0, c); this._p.gen++; return new EffH(this._p, c); };
EffH.prototype.moveTo = function (n) { this._ck(); var len = this._p.list.length;
  if (n < 1 || n > len) throw new Error("After Effects error: Can not move this property to index " + n + " because parent property has only " + len + " child properties.");
  W(); if (BREAK_MOVE > 0) { BREAK_MOVE--; n = n === len ? n - 1 : n + 1; }
  var from = this._p.list.indexOf(this._e); this._p.list.splice(from, 1); this._p.list.splice(n - 1, 0, this._e); this._p.gen++; };
EffH.prototype.remove = function () { this._ck(); W(); this._p.list.splice(this._p.list.indexOf(this._e), 1); this._p.gen++; };

function ParadeH(par) { this._p = par; this.name = "Effects"; this.matchName = "ADBE Effect Parade"; }
ParadeH.prototype.__defineGetter__("propertyType", function () { return PropertyType.NAMED_GROUP; });
ParadeH.prototype.__defineGetter__("numProperties", function () { return this._p.list.length; });
ParadeH.prototype.property = function (k) { var L = this._p.list;
  for (var i = 0; i < L.length; i++) if ((typeof k === "number" && k === i + 1) || L[i].mn === k || L[i].nm === k) return new EffH(this._p, L[i]);
  if (typeof k === "number") throw new Error("After Effects error: index out of range");
  return null; };
ParadeH.prototype.canAddProperty = function (k) { return fxByAny(k) !== null; };
ParadeH.prototype.addProperty = function (k) { var mn = fxByAny(k);
  if (!mn) throw new Error("After Effects error: Can not add a property with name “" + k + "” to this PropertyGroup.");
  W(); var e = new Eff(mn); e.nm = uniqueName(this._p, e.nm, true); this._p.list.push(e); this._p.gen++; return new EffH(this._p, e); };

// ---------- layers and comps ----------
function decorate(l, comp, name, kind) {
  l.id = ++NEXT_ID; l._comp = comp; l._name = name; l.locked = false; l._parent = null; l._st = 0; l.source = null;
  l._fx = (kind === "camera" || kind === "light") ? null : { list: [], gen: 0, layer: l };
  l._op = new Leaf("ADBE Opacity", "Opacity", 6417, 100);
  return l;
}
var LP = {
  get name() { return this._name; }, set name(v) { W(); this._name = v; },
  get index() { return this._comp._layers.indexOf(this) + 1; },
  get containingComp() { return this._comp; },
  get parent() { return this._parent; },
  get startTime() { return this._st; },
  get numProperties() { return this._fx ? 2 : 1; },
  property: function (k) {
    var tf = new GroupH("ADBE Transform Group", "Transform", [this._op], null, 0, this);
    if (k === "ADBE Effect Parade" || k === "Effects" || (k === 2 && this._fx)) return this._fx ? new ParadeH(this._fx) : null;
    if (k === "ADBE Transform Group" || k === "Transform" || k === 1) return tf;
    return null;
  },
};
function install(proto) { for (var k in LP) Object.defineProperty(proto, k, Object.getOwnPropertyDescriptor(LP, k)); }
install(AVLayer.prototype); install(CameraLayer.prototype); install(LightLayer.prototype);
var ROOT = new FolderItem(); ROOT.id = 0;
function mkComp(name) {
  var c = new CompItem(); c.id = ++NEXT_ID; c.name = name; c._layers = []; c.duration = 10; c.frameDuration = 1 / 30;
  c.__defineGetter__("numLayers", function () { return c._layers.length; });
  c.layer = function (i) { return c._layers[i - 1]; };
  ITEMS.push(c); return c;
}
function add(comp, kind, name) {
  var l = kind === "camera" ? new CameraLayer() : kind === "light" ? new LightLayer() : kind === "text" ? new TextLayer() : kind === "shape" ? new ShapeLayer() : new AVLayer();
  decorate(l, comp, name, kind); comp._layers.unshift(l); return l;
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
// Test helpers: a layer's stack as plain data.
function stackOf(l) { var o = []; for (var i = 0; i < l._fx.list.length; i++) { var e = l._fx.list[i]; o.push(e.mn + ":" + e.nm + (e.on ? "" : ":off")); } return o; }
function radii(l) { var o = []; for (var i = 0; i < l._fx.list.length; i++) { var e = l._fx.list[i]; o.push(e.mn === "ADBE Glo2" ? e.leaves[1].v : null); } return o; }
`;

function load() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(STUB, ctx, { filename: "stub" });
  for (const f of ["core.jsx", "ids.jsx", "effects.jsx", "effectstack.jsx"]) vm.runInContext(read(f), ctx, { filename: f });
  // Every call is bounded: a scanner or loop that stops terminating fails here, loudly, instead of hanging the suite.
  const run = (op, args) => JSON.parse(vm.runInContext(`JSON.stringify(dispatchValue(${JSON.stringify({ op, args })}))`, ctx, { timeout: 10000 }));
  const ok = (op, args) => { const r = run(op, args); assert.equal(r.ok, true, `${op} failed: ${r.error}`); return r.result; };
  const refused = (op, args, re) => {
    const w = ctx.WRITES;
    const r = run(op, args);
    assert.equal(r.ok, false, `${op} should have been refused`);
    if (re) assert.match(r.error, re);
    assert.equal(ctx.WRITES, w, `${op} wrote to the project before refusing`);
    return r.error;
  };
  const js = (src) => { const v = vm.runInContext(src, ctx, { timeout: 10000 }); return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v; };
  return { ctx, run, ok, refused, js };
}

// One comp: a solid S (the subject), a second solid, a text, a shape, a null-ish
// AV layer, a camera and a light; P parents S, M is S's matte source.
function rig() {
  const t = load();
  t.js(`var c = mkComp("Main");
    var cam = add(c, "camera", "cam"), light = add(c, "light", "light"), text = add(c, "text", "T"), shp = add(c, "shape", "Shape"),
        P = add(c, "av", "P"), M = add(c, "av", "M"), S = add(c, "av", "S"), S2 = add(c, "av", "S2");
    S._parent = P; S._matte = M; 0;`);
  const id = (n) => t.js(`${n}.id`);
  return { ...t, cid: t.js("c.id"), S: id("S"), S2: id("S2"), text: id("text"), shp: id("shp"), cam: id("cam"), light: id("light"), P: id("P") };
}
const loc = (e) => ({ effectIndex: e.effectIndex, matchName: e.matchName, effectName: e.name });
const stack = (t, layerId) => t.ok("get_effect_stack", { compId: t.cid, layerId: layerId ?? t.S });
// Three Glows with distinct radii (10, 20, 30) and a blur on top: Blur, Glow, Glow 2, Glow 3.
function glows(t) {
  t.ok("add_effect", { compId: t.cid, layerId: t.S, matchName: "ADBE Gaussian Blur 2" });
  for (let i = 0; i < 3; i++) t.ok("add_effect", { compId: t.cid, layerId: t.S, matchName: "ADBE Glo2" });
  t.js(`S._fx.list[1].leaves[1].v = 10; S._fx.list[2].leaves[1].v = 20; S._fx.list[3].leaves[1].v = 30;`);
  return stack(t).effects;
}

// ---------------------------------------------------------------------------

check("1. inspect an empty stack, and a camera/light that has none", () => {
  const t = rig();
  const s = stack(t);
  assert.equal(s.supportsEffects, true);
  assert.equal(s.numEffects, 0);
  assert.deepEqual(s.effects, []);
  const cam = stack(t, t.cam);
  assert.equal(cam.supportsEffects, false);
  assert.match(cam.reason, /camera/);
  assert.equal(stack(t, t.light).supportsEffects, false);
});

check("2. add an effect: exactly one, read back, the path is the one inspect_property_tree gives", () => {
  const t = rig();
  const r = t.ok("add_effect", { compId: t.cid, layerId: t.S, matchName: "ADBE Gaussian Blur 2" });
  assert.equal(r.added.effectIndex, 1);
  assert.equal(r.added.name, "Gaussian Blur");
  assert.equal(r.added.matchName, "ADBE Gaussian Blur 2");
  assert.deepEqual(r.added.path, ["ADBE Effect Parade", "ADBE Gaussian Blur 2"]);
  assert.equal(r.numEffects, 1);
  // A display name is accepted, and the result says what AE actually created.
  const d = t.ok("add_effect", { compId: t.cid, layerId: t.S, matchName: "Glow", name: "Bloom" });
  assert.equal(d.added.matchName, "ADBE Glo2");
  assert.equal(d.added.name, "Bloom");
  assert.equal(d.requested, "Glow");
  // A matchName AE does not know is refused before anything is written.
  t.refused("add_effect", { compId: t.cid, layerId: t.S, matchName: "ADBE Bogus" }, /cannot add "ADBE Bogus"[\s\S]*list_available_effects/);
  assert.deepEqual(t.js("stackOf(S)"), ["ADBE Gaussian Blur 2:Gaussian Blur", "ADBE Glo2:Bloom"]);
});

check("3. a second effect of one matchName: AE names it, occurrence and index paths tell them apart", () => {
  const t = rig();
  const e = glows(t);
  assert.deepEqual(e.map((x) => x.name), ["Gaussian Blur", "Glow", "Glow 2", "Glow 3"]);
  assert.deepEqual(e.map((x) => x.occurrence), [1, 1, 2, 3]);
  assert.deepEqual(e.map((x) => x.sameMatchNameCount), [1, 3, 3, 3]);
  assert.deepEqual(e[0].path, ["ADBE Effect Parade", "ADBE Gaussian Blur 2"]);
  assert.deepEqual(e[2].path, ["ADBE Effect Parade", 3], "a repeated matchName is addressed by index");
  assert.equal(t.js(`walkProperty(S, ${JSON.stringify(e[2].path.concat(["ADBE Glo2-0003"]))}).value`), 20);
});

check("4. duplicate display names: inspection still distinguishes them and a locator picks exactly one", () => {
  const t = rig();
  glows(t);
  t.js(`S._fx.list[1].nm = "Bloom"; S._fx.list[2].nm = "Bloom";`);   // a rename AE accepts
  const e = stack(t).effects;
  assert.deepEqual(e.map((x) => x.name), ["Gaussian Blur", "Bloom", "Bloom", "Glow 3"]);
  assert.deepEqual([e[1].effectIndex, e[2].effectIndex], [2, 3]);
  t.ok("remove_effect", { compId: t.cid, layerId: t.S, effect: loc(e[2]) });
  assert.deepEqual(t.js("radii(S)"), [null, 10, 30], "the second Bloom (radius 20) is the one that went");
});

check("5-6. remove exactly the named effect; every neighbour verified unchanged", () => {
  const t = rig();
  const e = glows(t);
  const r = t.ok("remove_effect", { compId: t.cid, layerId: t.S, effect: loc(e[2]) });
  assert.equal(r.removed.name, "Glow 2");
  assert.equal(r.previousIndex, 3);
  assert.equal(r.numEffects, 3);
  assert.deepEqual(r.effects.map((x) => x.name), ["Gaussian Blur", "Glow", "Glow 3"]);
  assert.deepEqual(t.js("radii(S)"), [null, 10, 30]);
});

check("7-10. duplicate: below its source, AE's name, values, keys, interpolation, expression and enabled state copied and verified", () => {
  const t = rig();
  const e = glows(t);
  t.js(`var g = S._fx.list[2]; g.on = false; g.comp.v = 40;
    g.leaves[2].k = [{ t: 0, v: 1, ii: 6612, oi: 6612 }, { t: 1, v: 3, ii: 6614, oi: 6614 }];
    g.leaves[0].ex = "50 + time*10"; g.leaves[0].exOn = true;`);
  const r = t.ok("duplicate_effect", { compId: t.cid, layerId: t.S, effect: loc(e[2]) });
  assert.equal(r.source.effectIndex, 3);
  assert.equal(r.duplicate.effectIndex, 4);
  assert.equal(r.duplicate.name, "Glow 4");
  assert.equal(r.duplicate.matchName, "ADBE Glo2");
  assert.equal(r.duplicate.enabled, false);
  assert.equal(r.duplicate.keyedProperties, 1);
  assert.equal(r.duplicate.expressions, 1);
  assert.equal(r.preserved.keyedProperties, 1);
  const d = t.js("S._fx.list[3]");
  assert.equal(d.leaves[1].v, 20);
  assert.equal(d.comp.v, 40, "Compositing Options copied");
  assert.deepEqual(d.leaves[2].k.map((k) => [k.t, k.v, k.oi]), [[0, 1, 6612], [1, 3, 6614]]);
  assert.equal(d.leaves[0].ex, "50 + time*10");
  assert.deepEqual(r.effects.map((x) => x.name), ["Gaussian Blur", "Glow", "Glow 2", "Glow 4", "Glow 3"]);
  // A name of our own, and a CUSTOM_VALUE that is copied but cannot be compared.
  t.ok("add_effect", { compId: t.cid, layerId: t.S, matchName: "ADBE CurvesCustom" });
  const curves = stack(t).effects[5];
  assert.equal(curves.unreadableProperties, 1);
  const c2 = t.ok("duplicate_effect", { compId: t.cid, layerId: t.S, effect: loc(curves), name: "Grade copy" });
  assert.equal(c2.duplicate.name, "Grade copy");
  assert.match(c2.preserved.notComparable, /CUSTOM_VALUE/);
});

check("duplicate readback: a copy that does not match its source is removed again and refused", () => {
  const t = rig();
  const e = glows(t);
  t.js(`S._fx.list[1].leaves[0].ex = "60"; S._fx.list[1].leaves[0].exOn = true; BREAK_DUP = 1;`);
  const before = t.js("stackOf(S)");
  const err = t.run("duplicate_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]) });
  assert.equal(err.ok, false);
  assert.match(err.error, /did not come out as a copy[\s\S]*removed again/);
  assert.deepEqual(t.js("stackOf(S)"), before);
});

check("11-14. move before, after, to the beginning and to the end, read back in order", () => {
  const t = rig();
  let e = glows(t);
  let r = t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[3]), before: loc(e[1]) });
  assert.deepEqual([r.previousIndex, r.actualIndex, r.changed], [4, 2, true]);
  assert.deepEqual(r.effects.map((x) => x.name), ["Gaussian Blur", "Glow 3", "Glow", "Glow 2"]);
  e = stack(t).effects;
  r = t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[0]), after: loc(e[2]) });
  assert.deepEqual([r.previousIndex, r.actualIndex], [1, 3]);
  assert.deepEqual(r.effects.map((x) => x.name), ["Glow 3", "Glow", "Gaussian Blur", "Glow 2"]);
  e = stack(t).effects;
  r = t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[3]), to: "beginning" });
  assert.deepEqual(r.effects.map((x) => x.name), ["Glow 2", "Glow 3", "Glow", "Gaussian Blur"]);
  e = stack(t).effects;
  r = t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[0]), to: "end" });
  assert.deepEqual(r.effects.map((x) => x.name), ["Glow 3", "Glow", "Gaussian Blur", "Glow 2"]);
  assert.deepEqual(t.js("radii(S)"), [30, 10, null, 20], "each effect kept its own values through every move");
});

check("15. a move to where it already is writes nothing", () => {
  const t = rig();
  const e = glows(t);
  const w = t.js("WRITES");
  const r = t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]), before: loc(e[2]) });
  assert.equal(r.changed, false);
  assert.equal(t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[0]), to: "beginning" }).changed, false);
  assert.equal(t.js("WRITES"), w);
});

check("16. moving relative to itself is refused", () => {
  const t = rig();
  const e = glows(t);
  t.refused("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]), after: loc(e[1]) }, /after itself/);
  t.refused("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]) }, /exactly one of to, before or after/);
});

check("17. a stale locator is refused with the live stack, never re-resolved", () => {
  const t = rig();
  const e = glows(t);
  t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[3]), to: "beginning" });
  // index 3 is still a Glow — only the name tells that it is now "Glow", not "Glow 2".
  t.refused("duplicate_effect", { compId: t.cid, layerId: t.S, effect: loc(e[2]) }, /named "Glow", not "Glow 2"[\s\S]*get_effect_stack/);
  t.refused("remove_effect", { compId: t.cid, layerId: t.S, effect: loc(e[0]) }, /is ADBE Glo2 "Glow 3", not ADBE Gaussian Blur 2/);
  t.refused("move_effect", { compId: t.cid, layerId: t.S, effect: { effectIndex: 9, matchName: "ADBE Glo2" }, to: "end" }, /past the end/);
  assert.deepEqual(t.js("radii(S)"), [30, null, 10, 20]);
});

check("17b. two effects with one matchName AND one name: only the fingerprint tells them apart after a reorder", () => {
  const t = rig();
  glows(t);
  t.js(`S._fx.list[1].nm = "Bloom"; S._fx.list[2].nm = "Bloom";`);          // radii 10 and 20, both "Bloom"
  const e = stack(t).effects;
  assert.notEqual(e[1].fingerprint, e[2].fingerprint, "different values, different fingerprints");
  assert.match(e[1].fingerprint, /^[0-9a-f]{8}$/);
  const first = { ...loc(e[1]), fingerprint: e[1].fingerprint };          // the radius-10 Bloom at index 2
  // Swap the two Blooms: index 2 is still ADBE Glo2 "Bloom" — but the other one.
  t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]), after: loc(e[2]) });
  assert.deepEqual(t.js("radii(S)"), [null, 20, 10, 30]);
  t.refused("remove_effect", { compId: t.cid, layerId: t.S, effect: first }, /has fingerprint [0-9a-f]{8}, not [0-9a-f]{8}: it is another effect with the same name/);
  // Without it the locator cannot tell — the documented limit; with the fresh one it removes exactly the radius-10 Bloom.
  const now = stack(t).effects.find((x) => x.fingerprint === e[1].fingerprint);
  assert.equal(now.effectIndex, 3);
  t.ok("remove_effect", { compId: t.cid, layerId: t.S, effect: { ...loc(now), fingerprint: now.fingerprint } });
  assert.deepEqual(t.js("radii(S)"), [null, 20, 30]);
  // An edit changes it, so a fingerprint read before a property write is stale after it.
  const before = stack(t).effects[1].fingerprint;
  t.js("S._fx.list[1].leaves[1].v = 21");
  assert.notEqual(stack(t).effects[1].fingerprint, before);
});

check("18. the returned path reaches the intended effect after a reorder; an old index path does not", () => {
  const t = rig();
  const e = glows(t);
  const oldPath = e[3].path.concat(["ADBE Glo2-0003"]);           // "Glow 3", radius 30, at index 4
  t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[3]), to: "beginning" });
  assert.equal(t.js(`walkProperty(S, ${JSON.stringify(oldPath)}).value`), 20, "index 4 is now another Glow");
  const fresh = stack(t).effects.find((x) => x.name === "Glow 3");
  assert.equal(t.js(`walkProperty(S, ${JSON.stringify(fresh.path.concat(["ADBE Glo2-0003"]))}).value`), 30);
  // The blur's path is by matchName, so it survives any reorder.
  assert.deepEqual(stack(t).effects.find((x) => x.name === "Gaussian Blur").path, ["ADBE Effect Parade", "ADBE Gaussian Blur 2"]);
});

check("19. a locked layer is refused by every structural write (AE itself would let them through); reading is fine", () => {
  const t = rig();
  const e = glows(t);
  t.js("S.locked = true");
  t.refused("add_effect", { compId: t.cid, layerId: t.S, matchName: "ADBE Tint" }, /locked[\s\S]*set_layer locked:false/);
  t.refused("remove_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]) }, /locked/);
  t.refused("duplicate_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]) }, /locked/);
  t.refused("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]), to: "end" }, /locked/);
  assert.equal(stack(t).locked, true);
  assert.equal(stack(t).numEffects, 4);
});

check("20. cameras and lights are refused; every other layer type takes effects", () => {
  const t = rig();
  t.refused("add_effect", { compId: t.cid, layerId: t.cam, matchName: "ADBE Gaussian Blur 2" }, /camera, and After Effects gives cameras and lights no Effects/);
  t.refused("add_effect", { compId: t.cid, layerId: t.light, matchName: "ADBE Gaussian Blur 2" }, /is a light/);
  t.refused("remove_effect", { compId: t.cid, layerId: t.cam, effect: { effectIndex: 1, matchName: "ADBE Glo2" } }, /camera/);
  for (const id of [t.text, t.shp, t.P, t.S2]) assert.equal(t.ok("add_effect", { compId: t.cid, layerId: id, matchName: "ADBE Tint" }).numEffects, 1);
});

check("expressions: naming the removed effect, or an index a change shifts, refuses — and nothing else does", () => {
  const t = rig();
  const e = glows(t);
  t.js(`S._op.ex = 'effect("Glow 2")("Glow Radius")'; S._op.exOn = true;`);
  t.refused("remove_effect", { compId: t.cid, layerId: t.S, effect: loc(e[2]) }, /names "Glow 2"[\s\S]*ignoreExpressionReferences/);
  // A name reference survives a move and a duplicate, so neither is refused.
  t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[2]), to: "end" });
  // An index reference does not: from the other layer, through thisComp.layer("S").
  t.js(`S2._op.ex = 'thisComp.layer("S").effect(2)("Glow Radius")'; S2._op.exOn = true;`);
  const now = stack(t).effects;
  t.refused("move_effect", { compId: t.cid, layerId: t.S, effect: loc(now[0]), to: "end" }, /layer \d+ \("S2"\)[\s\S]*effect\(2\)/);
  t.refused("duplicate_effect", { compId: t.cid, layerId: t.S, effect: loc(now[0]) }, /effect\(2\)/);
  // A reference to another layer's effects is not this stack's concern.
  t.js(`S2._op.ex = 'thisComp.layer("T").effect(1)(1)';`);
  t.ok("duplicate_effect", { compId: t.cid, layerId: t.S, effect: loc(now[0]) });
});

check("expressions: ignoreExpressionReferences proceeds and reports exactly what broke", () => {
  const t = rig();
  const e = glows(t);
  t.js(`S._op.ex = 'effect("Glow 2")("Glow Radius")'; S._op.exOn = true;`);
  const r = t.ok("remove_effect", { compId: t.cid, layerId: t.S, effect: loc(e[2]), ignoreExpressionReferences: true });
  assert.equal(r.expressionsBroken.length, 1);
  assert.match(r.expressionsBroken[0].error, /effect named 'Glow 2' is missing/);
  assert.match(r.warning, /broke 1 expression/);
  assert.equal(r.expressionReferencesIgnored.length, 1);
});

check("move readback: a move AE lands in the wrong place is moved back and refused", () => {
  const t = rig();
  const e = glows(t);
  t.js("BREAK_MOVE = 1");
  const before = t.js("stackOf(S)");
  const r = t.run("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[3]), to: "beginning" });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not come out in the expected order[\s\S]*moved back and the stack verified/);
  assert.deepEqual(t.js("stackOf(S)"), before);
});

check("24. structural locality: only the stack changes — ids, order, parent, matte and timing untouched", () => {
  const t = rig();
  const snap = () => t.js(`(function(){ var o=[]; for (var i=0;i<c._layers.length;i++){ var l=c._layers[i]; o.push([l.id,l._name,l._parent?l._parent.id:null,l._matte?l._matte.id:null,l._st,l.locked]); } return o; })()`);
  const before = snap();
  const e = glows(t);
  t.ok("duplicate_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]) });
  t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(stack(t).effects[0]), to: "end" });
  t.ok("remove_effect", { compId: t.cid, layerId: t.S, effect: loc(stack(t).effects[0]) });
  assert.deepEqual(snap(), before);
  assert.equal(t.js("S2._fx.list.length"), 0, "another layer's stack is untouched");
});

check("25. no project save, and one undo group per write call (none for the read)", () => {
  const t = rig();
  t.js("UNDO.length = 0");
  const e = glows(t);                                       // four add_effect + a get_effect_stack
  t.ok("move_effect", { compId: t.cid, layerId: t.S, effect: loc(e[1]), to: "end" });
  assert.equal(t.js("UNDO").filter((u) => u.startsWith("begin")).length, 5);
  assert.doesNotMatch(read("effectstack.jsx"), /\.save\(|saveWithDialog/);
});

// ---------------------------------------------------------------------------
// The expression scanner must terminate in ExtendScript
// ---------------------------------------------------------------------------
// The first scanner was one RegExp that V8 runs instantly and After Effects'
// ExtendScript never returns from (measured twice on 26.5x89; each froze AE
// until it was force-quit). Node cannot reproduce that engine, so two guards:
// the scanner's code may contain no regular expression at all, and it must
// terminate — under a hard timeout — on every input, adversarial ones included.

const SCAN_START = "// The effect() calls an expression makes, as written, with what each is";
const SCAN_END = "// Could this call be addressing an effect on layer l?";

check("the expression scanner contains no regular expression (ExtendScript hangs in exec)", () => {
  const src = read("effectstack.jsx");
  const a = src.indexOf(SCAN_START), b = src.indexOf(SCAN_END);
  assert.ok(a > 0 && b > a, "scanner section markers missing");
  const code = src.slice(a, b).split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.doesNotMatch(code, /\//, "a '/' in the scanner's code: a regex literal (or division) came back");
  assert.doesNotMatch(code, /RegExp|\.exec\s*\(|\.match\s*\(|\.test\s*\(|\.search\s*\(|\.replace\s*\(/, "a RegExp method came back into the scanner");
});

check("the expression scanner terminates on adversarial input, repeatedly, and classifies what it reads", () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(read("effectstack.jsx").replace(/^OPS\.[\s\S]*$/m, ""), ctx, { filename: "effectstack.jsx" });
  const calls = (text) => JSON.parse(vm.runInContext(`JSON.stringify(__esEffectCalls(${JSON.stringify(text)}))`, ctx, { timeout: 2000 }));
  const adversarial = [
    "", "effect", "effect(", "effect()", "effect((((", "))))((((", "effect(\"unclosed", "effect('a\\'", "layer(.effect(",
    ".effect(1)", "...effect(2)", "effect".repeat(20000), "effect(".repeat(20000), "layer(\"a\").".repeat(5000) + "effect(1)",
    "x".repeat(200000) + "effect(1)", "\"" + "\\".repeat(10001) + "\"", "effect(\"" + "\\\"".repeat(5000) + "\")",
  ];
  for (let pass = 0; pass < 3; pass++) for (const s of adversarial) calls(s);   // throws "Script execution timed out" on a hang
  const one = (text) => { const r = calls(text); assert.equal(r.length, 1, `${text} -> ${JSON.stringify(r)}`); return r[0]; };
  assert.deepEqual(one('effect("Drive")("Slider")'), { receiver: { kind: "self" }, arg: { kind: "name", value: "Drive" } });
  assert.deepEqual(one('thisLayer.effect(2)(1)'), { receiver: { kind: "self" }, arg: { kind: "index", value: 2 } });
  assert.deepEqual(one('thisComp.layer("S").effect("Glow 3")("Glow Radius")'),
    { receiver: { kind: "layer", ref: { kind: "name", value: "S" } }, arg: { kind: "name", value: "Glow 3" } });
  assert.deepEqual(one("thisComp.layer( 4 ) . effect ( 'x' )").receiver, { kind: "layer", ref: { kind: "index", value: 4 } });
  assert.deepEqual(one("L.effect(i)"), { receiver: { kind: "unknown", value: "L" }, arg: { kind: "dynamic", value: "i" } });
  assert.deepEqual(one("effect(n(1))").arg.kind, "dynamic", "a nested call is not a literal");
  assert.deepEqual(one("effect(\"a\\\\\")").arg, { kind: "name", value: "a\\\\" }, "an escaped backslash ends the literal");
  assert.equal(one("effect(\"a\\\")").arg.kind, "dynamic", "an escaped closing quote is not a literal");
  assert.equal(one("effect(\"a\"+b)").arg.kind, "dynamic");
  assert.equal(calls("sideeffect(1) + effectiveRate(2)").length, 0, "longer names are not effect()");
  assert.equal(calls('effect(1)(1) + thisComp.layer("A").effect("b")(1)').length, 2);
});

// ---------------------------------------------------------------------------
// Schemas, classification, run_batch
// ---------------------------------------------------------------------------
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { validateBatchOps, parseOpArgs } = await import(dist("tools", "batchSteps.js"));
const { schemas } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "index.js")).href);
const L = { effectIndex: 2, matchName: "ADBE Glo2", effectName: "Glow" };

check("21. strict schemas", () => {
  assert.throws(() => parseOpArgs("remove_effect", { compId: 1, layerId: 2, effectIndex: 1 }), /effect|unrecognized/i, "the bare index form is gone");
  assert.throws(() => parseOpArgs("remove_effect", { compId: 1, layerId: 2, effect: { effectIndex: 1 } }), /matchName/);
  assert.throws(() => parseOpArgs("remove_effect", { compId: 1, layerId: 2, effect: { ...L, bogus: 1 } }), /bogus|unrecognized/i);
  assert.throws(() => parseOpArgs("remove_effect", { compId: 1, layerId: 2, effect: { ...L, effectIndex: 0 } }));
  assert.throws(() => parseOpArgs("move_effect", { compId: 1, layerId: 2, effect: L }), /exactly one/i);
  assert.throws(() => parseOpArgs("move_effect", { compId: 1, layerId: 2, effect: L, to: "end", before: L }), /exactly one/i);
  assert.throws(() => parseOpArgs("move_effect", { compId: 1, layerId: 2, effect: L, to: "top" }));
  assert.throws(() => parseOpArgs("add_effect", { compId: 1, layerId: 2, matchName: "" }));
  assert.throws(() => parseOpArgs("get_effect_stack", { compId: 1, layerId: 2, include: [] }), /unrecognized/i);
  assert.equal(parseOpArgs("duplicate_effect", { compId: 1, layerId: 2, effect: L }).ignoreExpressionReferences, false);
  assert.throws(() => parseOpArgs("remove_effect", { compId: 1, layerId: 2, effect: { ...L, fingerprint: "XYZ" } }), /fingerprint|invalid/i);
  assert.equal(parseOpArgs("remove_effect", { compId: 1, layerId: 2, effect: { ...L, fingerprint: "0a1b2c3d" } }).effect.fingerprint, "0a1b2c3d");
});

check("22. mutation classification", () => {
  for (const op of ["add_effect", "remove_effect", "duplicate_effect", "move_effect"]) assert.equal(schemas.OpMutation[op], "write", op);
  assert.equal(schemas.OpMutation.get_effect_stack, "read");
});

check("23. run_batch: an invalid later effect step blocks the whole batch before any is sent", () => {
  const good = { op: "add_effect", args: { compId: 1, layerId: 2, matchName: "ADBE Glo2" } };
  const out = validateBatchOps([good, { op: "duplicate_effect", args: { compId: 1, layerId: 2, effect: L } }]);
  assert.equal(out[1].args.ignoreExpressionReferences, false, "defaults applied per step");
  assert.throws(() => validateBatchOps([good, { op: "move_effect", args: { compId: 1, layerId: 2, effect: L } }]), /Nothing was sent[\s\S]*step 1 /);
  assert.throws(() => validateBatchOps([good, { op: "remove_effect", args: { compId: 1, layerId: 2, effectIndex: 2 } }]), /Nothing was sent[\s\S]*step 1 /);
});

console.log(`effect-stack: ${passed} checks passed`);
