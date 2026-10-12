// The layer-structure tools in packages/jsx/structure.jsx — get_layer_structure,
// move_layer, set_layer_parent, set_track_matte, precompose_layers — plus the
// hardened duplicate_layer and parent_layer in layers.jsx.
//
// The stub below reproduces what After Effects was measured to do on 26.5x89
// (docs/fragile-areas-ae.md, "Layer structure"; recipes 54-56), including the
// damage: precompose drops a parent that was left behind, re-parents children
// to the precomp layer, copies a matte source into the precomp, re-points a
// matte at the precomp layer, and recreates every moved layer with a new id.
// So a guard that goes missing shows up here as a damaged stub comp, the way it
// would show up in the user's. Its own refusals (cycles, locked layers, moving
// a layer relative to itself, moveAll:false on several layers) use AE's text.
//
// Every op runs through the real dispatch() from core.jsx. WRITES counts every
// mutating call the stub sees, so "refused before anything changed" is a
// number, not a hope.
//
//   node tests/unit/layer-structure.mjs

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
  catch (e) { console.error(`layer-structure FAILED: ${name}`); throw e; }
}

const STUB = String.raw`
function CompItem() {} function FolderItem() {} function FootageItem() {}
function AVLayer() {} function TextLayer() {} function ShapeLayer() {} function CameraLayer() {} function LightLayer() {}
function SolidSource() {} function FileSource() {} function PlaceholderSource() {}
TextLayer.prototype = new AVLayer(); ShapeLayer.prototype = new AVLayer();
var TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016 };
var PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
var PropertyValueType = { LAYER_INDEX: 6420, OneD: 6417 };
var NEXT_ID = 100, ITEMS = [], WRITES = 0, UNDO = [];
function W() { WRITES++; }

// ---------- properties ----------
function Prop(name, v) { this.name = name; this.matchName = name; this.v = v; this.propertyType = PropertyType.PROPERTY;
  this.canSetExpression = true; this.expression = ""; this.expressionEnabled = false; this.numKeys = 0; this.propertyValueType = PropertyValueType.OneD; }
Prop.prototype.valueAtTime = function () { return this.v; };
Prop.prototype.setValue = function (x) { W(); this.v = x; };
Prop.prototype.__defineGetter__("value", function () { return this.v; });
function Group(name, props) { this.name = name; this.matchName = name; this.propertyType = PropertyType.NAMED_GROUP; this._p = props; }
Group.prototype.__defineGetter__("numProperties", function () { return this._p.length; });
Group.prototype.property = function (k) {
  if (typeof k === "number") return this._p[k - 1];
  for (var i = 0; i < this._p.length; i++) if (this._p[i].name === k || this._p[i].matchName === k) return this._p[i];
  return null;
};

// ---------- layers ----------
function guardLocked(l, what) { if (l.locked) throw new Error("After Effects error: Can not " + what + " on Layer “" + l.name + "” because the Layer is locked."); }
function alive(l) { return !!l && !!l._comp && l._comp._layers.indexOf(l) >= 0; }
function isAncestor(a, b) { for (var p = b; p; p = p._parent) if (p === a) return true; return false; }
function decorateLayer(l, comp, name) {
  l.id = ++NEXT_ID; l._comp = comp; l._name = name; l._parent = null; l._matte = null; l._matteType = 5012;
  l.locked = false; l.shy = false; l.enabled = true; l.solo = false; l.label = 0; l.blendingMode = 0;
  l.inPoint = 0; l.outPoint = 5; l.startTime = 0; l.stretch = 100;
  if (!(l instanceof CameraLayer) && !(l instanceof LightLayer)) { l.threeDLayer = false; l.adjustmentLayer = false; l.guideLayer = false; l.nullLayer = false; }
  l._tr = new Group("ADBE Transform Group", [new Prop("Anchor Point", [0, 0]), new Prop("Position", [0, 0]), new Prop("Scale", [100, 100]), new Prop("Rotation", 0), new Prop("Opacity", 100)]);
  l._fx = new Group("ADBE Effect Parade", []);
  return l;
}
function LayerProto() {}
var LP = {
  get name() { return this._name; }, set name(v) { guardLocked(this, "set attribute “name”"); W(); this._name = String(v); },
  get index() { if (!alive(this)) throw new Error("Object is invalid"); return this._comp._layers.indexOf(this) + 1; },
  get containingComp() { if (!alive(this)) throw new Error("Object is invalid"); return this._comp; },
  get parent() { return this._parent; },
  set parent(p) { setParentImpl(this, p, true); },
  setParentWithJump: function (p) { setParentImpl(this, p, false); },
  get hasTrackMatte() { return !!this._matte && alive(this._matte); },
  get trackMatteLayer() { return this.hasTrackMatte ? this._matte : null; },
  get trackMatteType() { return this._matteType; },
  get isTrackMatte() { var ls = this._comp._layers; for (var i = 0; i < ls.length; i++) if (ls[i]._matte === this) return true; return false; },
  setTrackMatte: function (src, type) {
    if (type === TrackMatteType.NO_TRACK_MATTE) throw new Error("After Effects error: NO_TRACK_MATTE is not allowed");
    if (!src) return;                                 // measured: a null source does nothing, no throw
    if (src === this) throw new Error("After Effects error: a layer cannot be its own track matte");
    W(); this._matte = src; this._matteType = type; src.enabled = false;
  },
  removeTrackMatte: function () { W(); this._matte = null; },   // _matteType stays stale, as in AE
  property: function (k) {
    if (k === "Transform" || k === "ADBE Transform Group") return this._tr;
    if (k === "Effects" || k === "ADBE Effect Parade") return this._fx;
    if (typeof k === "number") return [this._tr, this._fx][k - 1];
    return null;
  },
  get numProperties() { return 2; },
  get transform() { return { position: this._tr.property("Position"), opacity: this._tr.property("Opacity") }; },
  _move: function (to) { var ls = this._comp._layers; ls.splice(ls.indexOf(this), 1); ls.splice(to, 0, this); W(); },
  moveBefore: function (o) { guardLocked(this, "call method “moveBefore”"); if (o === this) throw new Error("After Effects error: Can not move a layer before or after itself.");
    var ls = this._comp._layers; ls.splice(ls.indexOf(this), 1); ls.splice(ls.indexOf(o), 0, this); W(); },
  moveAfter: function (o) { guardLocked(this, "call method “moveAfter”"); if (o === this) throw new Error("After Effects error: Can not move a layer before or after itself.");
    var ls = this._comp._layers; ls.splice(ls.indexOf(this), 1); ls.splice(ls.indexOf(o) + 1, 0, this); W(); },
  moveToBeginning: function () { guardLocked(this, "call method “moveToBeginning”"); this._move(0); },
  moveToEnd: function () { guardLocked(this, "call method “moveToEnd”"); this._move(this._comp._layers.length - 1); },
  moveTo: function () { throw new Error("After Effects error: parent is not an INDEXED_GROUP"); },
  duplicate: function () {
    W();
    var d = makeLayerLike(this, this._comp, this._name + " 2");
    d._parent = this._parent; d._matte = this._matte; d._matteType = this._matteType; d.locked = this.locked;
    d._tr.property("Position").v = this._tr.property("Position").v.slice();
    var ls = this._comp._layers; ls.splice(ls.indexOf(this), 0, d);   // directly above the original
    return d;
  },
  remove: function () { W(); var ls = this._comp._layers; ls.splice(ls.indexOf(this), 1); }
};
function setParentImpl(l, p, compensate) {
  guardLocked(l, "set attribute “parent”");
  if (p && (p === l || isAncestor(l, p))) throw new Error("After Effects error: the parent of a layer cannot be itself nor one of its children.");
  W();
  var pos = l._tr.property("Position");
  if (compensate) {        // translation-only world compensation (every test rig is unscaled, unrotated, anchor 0)
    var w = worldPos(l);
    l._parent = p || null;
    var pw = l._parent ? worldPos(l._parent) : [0, 0];
    pos.v = [w[0] - pw[0], w[1] - pw[1]];
  } else l._parent = p || null;
}
function worldPos(l) { var p = l._tr.property("Position").v; var up = l._parent ? worldPos(l._parent) : [0, 0]; return [p[0] + up[0], p[1] + up[1]]; }
function install(proto) { for (var k in LP) { var d = Object.getOwnPropertyDescriptor(LP, k); Object.defineProperty(proto, k, d); } }
install(AVLayer.prototype); install(CameraLayer.prototype); install(LightLayer.prototype);
CameraLayer.prototype.setTrackMatte = undefined; LightLayer.prototype.setTrackMatte = undefined;
function makeLayerLike(src, comp, name) {
  var l;
  if (src instanceof CameraLayer) l = new CameraLayer(); else if (src instanceof ShapeLayer) l = new ShapeLayer(); else if (src instanceof TextLayer) l = new TextLayer(); else l = new AVLayer();
  decorateLayer(l, comp, name);
  if (src instanceof AVLayer) { l.source = src.source; l.nullLayer = src.nullLayer; l.adjustmentLayer = src.adjustmentLayer; l.threeDLayer = src.threeDLayer; l.guideLayer = src.guideLayer; }
  l.shy = src.shy;
  return l;
}

// ---------- project ----------
var ROOT = new FolderItem(); ROOT.id = 0; ROOT.name = "Root"; ROOT.parentFolder = null;
function addItem(it, parent) { it.id = ++NEXT_ID; it.parentFolder = parent || ROOT; ITEMS.push(it); return it; }
function mkFolder(name) { var f = new FolderItem(); f.name = name; return addItem(f); }
function mkSolidItem(name) { var f = new FootageItem(); f.name = name; f.mainSource = new SolidSource(); f.mainSource.color = [1, 0, 0]; return addItem(f); }
function mkComp(name, parent) {
  var c = new CompItem(); c.name = name; c._layers = []; c.width = 1920; c.height = 1080; c.duration = 5; c.frameRate = 30; c.time = 0;
  c.__defineGetter__("numLayers", function () { return c._layers.length; });
  c.layer = function (i) { return c._layers[i - 1]; };
  c.layers = { precompose: function (idx, nm, moveAll) { return precompose(c, idx, nm, moveAll); } };
  return addItem(c, parent);
}
function add(comp, kind, name) {
  var l;
  if (kind === "camera") l = new CameraLayer(); else if (kind === "shape") l = new ShapeLayer(); else if (kind === "text") l = new TextLayer(); else l = new AVLayer();
  decorateLayer(l, comp, name);
  if (kind === "null" || kind === "solid") l.source = mkSolidItem(name);
  if (kind === "null") l.nullLayer = true;
  comp._layers.unshift(l);               // new layers land on top, as in AE
  return l;
}

// precompose, as measured (recipe 56). Damaging on purpose where AE is.
function precompose(c, idx, name, moveAll) {
  var n = c._layers.length;
  if (!idx.length || idx.length > n) throw new Error("After Effects error: Unable to call “precompose” because of parameter 1. Value array does not have between 1 and " + n + " elements.");
  for (var q = 0; q < idx.length; q++) if (idx[q] < 1 || idx[q] > n) throw new Error("After Effects error: Unable to call “precompose” because of parameter 1. Value “" + idx[q] + "” of element " + q + " in the array is not between 1 and " + n + ".");
  if (!moveAll && idx.length > 1) throw new Error("After Effects error: Can not set moveAllAttributes to false when calling precompose with more than one layer.");
  var picked = []; var seen = {};
  for (var i = 0; i < idx.length; i++) { var L = c._layers[idx[i] - 1]; if (!seen[L.id]) { seen[L.id] = 1; picked.push(L); } }
  picked.sort(function (a, b) { return a.index - b.index; });
  if (!moveAll) {
    var one = picked[0];
    if (one instanceof CameraLayer || one instanceof LightLayer) throw new Error("After Effects error: Can not set moveAllAttributes to false when calling precompose with a single light layer or camera layer.");
    if (!one.source) throw new Error("After Effects error: layer does not have a source.");
  }
  W();
  var nc = mkComp(name, c.parentFolder);
  if (!moveAll) {
    var keep = picked[0];
    var inner = makeLayerLike(keep, nc, keep._name); nc._layers.push(inner);
    keep.source = nc; keep._name = name;   // same id, attributes kept
    return nc;
  }
  var top = picked[0].index;
  var map = {};
  for (var k = 0; k < picked.length; k++) { var cp = makeLayerLike(picked[k], nc, picked[k]._name); cp._matteType = picked[k]._matteType; map[picked[k].id] = cp; nc._layers.push(cp); }
  for (k = 0; k < picked.length; k++) {
    var o = picked[k], cpy = map[o.id];
    cpy._parent = o._parent && map[o._parent.id] ? map[o._parent.id] : null;          // a parent left behind is dropped
    if (o._matte) {
      if (map[o._matte.id]) cpy._matte = map[o._matte.id];
      else { var extra = makeLayerLike(o._matte, nc, o._matte._name); nc._layers.push(extra); cpy._matte = extra; }   // the source is COPIED in
    }
  }
  var repl = new AVLayer(); decorateLayer(repl, c, name); repl.source = nc;
  var ls = c._layers;
  for (k = 0; k < picked.length; k++) ls.splice(ls.indexOf(picked[k]), 1);
  ls.splice(top - 1, 0, repl);
  for (k = 0; k < ls.length; k++) {
    if (ls[k]._parent && seen[ls[k]._parent.id]) ls[k]._parent = repl;                // children re-parented to the precomp layer
    if (ls[k]._matte && seen[ls[k]._matte.id]) ls[k]._matte = repl;                   // mattes re-pointed at it
  }
  for (k = 0; k < picked.length; k++) picked[k]._comp = null;                        // old handles go invalid
  return nc;
}

var app = {
  beginUndoGroup: function (n) { UNDO.push("begin:" + n); }, endUndoGroup: function () { UNDO.push("end"); },
  project: {
    rootFolder: ROOT, file: null,
    get numItems() { return ITEMS.length; },
    item: function (i) { return ITEMS[i - 1]; },
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
  const order = (compVar) => js(`(function(){var o=[];for(var i=1;i<=${compVar}.numLayers;i++)o.push(${compVar}.layer(i).id);return o;})()`);
  return { ctx, run, ok, refused, js, order };
}

// A five-layer comp: top->bottom E D C B A.
function five() {
  const t = load();
  t.js(`var c = mkComp("Main"); var A = add(c,"null","A"), B = add(c,"null","B"), C = add(c,"null","C"), D = add(c,"solid","D"), E = add(c,"shape","E");`);
  const id = (n) => t.js(`${n}.id`);
  return { ...t, cid: t.js("c.id"), A: id("A"), B: id("B"), C: id("C"), D: id("D"), E: id("E") };
}

// ---------------------------------------------------------------------------
// move_layer
// ---------------------------------------------------------------------------
check("1. move before another layer", () => {
  const t = five();
  const r = t.ok("move_layer", { compId: t.cid, layerId: t.A, beforeLayerId: t.D });
  assert.deepEqual(t.order("c"), [t.E, t.A, t.D, t.C, t.B]);
  assert.deepEqual([r.previousIndex, r.actualIndex, r.aboveLayerId, r.belowLayerId, r.changed], [5, 2, t.E, t.D, true]);
});
check("2. move after another layer", () => {
  const t = five();
  const r = t.ok("move_layer", { compId: t.cid, layerId: t.E, afterLayerId: t.B });
  assert.deepEqual(t.order("c"), [t.D, t.C, t.B, t.E, t.A]);
  assert.deepEqual([r.previousIndex, r.actualIndex, r.aboveLayerId, r.belowLayerId], [1, 4, t.B, t.A]);
});
check("3. move to beginning", () => {
  const t = five();
  const r = t.ok("move_layer", { compId: t.cid, layerId: t.B, to: "beginning" });
  assert.equal(t.order("c")[0], t.B);
  assert.deepEqual([r.actualIndex, r.aboveLayerId], [1, null]);
});
check("4. move to end, and a no-op is reported as unchanged with no AE call", () => {
  const t = five();
  const r = t.ok("move_layer", { compId: t.cid, layerId: t.D, to: "end" });
  assert.equal(t.order("c")[4], t.D);
  assert.deepEqual([r.actualIndex, r.belowLayerId], [5, null]);
  const w = t.ctx.WRITES;
  const again = t.ok("move_layer", { compId: t.cid, layerId: t.D, to: "end" });
  assert.equal(again.changed, false);
  assert.equal(t.ctx.WRITES, w, "an already-placed layer must not be moved again");
});
check("5. ids are stable across reorders", () => {
  const t = five();
  const before = new Set(t.order("c"));
  t.ok("move_layer", { compId: t.cid, layerId: t.A, to: "beginning" });
  t.ok("move_layer", { compId: t.cid, layerId: t.E, afterLayerId: t.A });
  t.ok("move_layer", { compId: t.cid, layerId: t.C, beforeLayerId: t.A });
  assert.deepEqual(new Set(t.order("c")), before);
  assert.deepEqual(t.order("c"), [t.C, t.A, t.E, t.D, t.B]);
});
check("move refusals: self, locked, missing destination — nothing moves", () => {
  const t = five();
  t.refused("move_layer", { compId: t.cid, layerId: t.A, beforeLayerId: t.A }, /cannot be moved before itself/);
  t.js("A.locked = true");
  t.refused("move_layer", { compId: t.cid, layerId: t.A, to: "beginning" }, /locked.*Unlock it with set_layer locked:false first/);
  t.refused("move_layer", { compId: t.cid, layerId: t.B, afterLayerId: 424242 }, /No layer with id 424242/);
  assert.deepEqual(t.order("c"), [t.E, t.D, t.C, t.B, t.A]);
});

// ---------------------------------------------------------------------------
// duplicate_layer
// ---------------------------------------------------------------------------
check("6-8. duplicate: a new id directly above, same source item, original untouched", () => {
  const t = five();
  const items = t.js("ITEMS.length");
  const r = t.ok("duplicate_layer", { compId: t.cid, layerId: t.C });
  const d = r.duplicates[0];
  assert.notEqual(d.layerId, t.C);
  assert.equal(r.sourceLayerId, t.C);
  assert.equal(d.sourceItemId, r.sourceItemId);
  assert.equal(d.sourceItemId, t.js("C.source.id"));
  assert.equal(t.js("ITEMS.length"), items, "duplicate must not add project items");
  assert.equal(d.index, r.sourceLayerIndex - 1, "the copy sits directly above the original");
  assert.equal(t.js("C.name"), "C");
  assert.deepEqual(t.order("c"), [t.E, t.D, d.layerId, t.C, t.B, t.A]);
});
check("duplicate: newName, count, locked refusal", () => {
  const t = five();
  const r = t.ok("duplicate_layer", { compId: t.cid, layerId: t.B, newName: "B", count: 2 });
  assert.equal(r.duplicates.length, 2);
  assert.notEqual(r.duplicates[0].layerId, r.duplicates[1].layerId);
  assert.ok(r.duplicates.every((d) => d.name === "B"));
  t.js("A.locked = true");
  t.refused("duplicate_layer", { compId: t.cid, layerId: t.A, newName: "x" }, /locked/);
});
check("18. duplicate names are addressed by id", () => {
  const t = five();
  const r = t.ok("duplicate_layer", { compId: t.cid, layerId: t.C, newName: "C" });
  const twin = r.duplicates[0].layerId;
  t.ok("move_layer", { compId: t.cid, layerId: twin, to: "end" });
  assert.equal(t.order("c").at(-1), twin);
  assert.equal(t.js("C.index"), 3, "the original 'C' did not move");
  const s = t.ok("get_layer_structure", { compId: t.cid });
  assert.deepEqual(s.layers.filter((l) => l.name === "C").map((l) => l.layerId).sort(), [t.C, twin].sort());
});

// ---------------------------------------------------------------------------
// set_layer_parent / parent_layer
// ---------------------------------------------------------------------------
check("9. parent a layer", () => {
  const t = five();
  const r = t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B });
  assert.deepEqual([r.previousParentLayerId, r.parentLayerId, r.changed], [null, t.B, true]);
  assert.equal(t.js("A.parent.id"), t.B);
});
check("10. unparent a layer", () => {
  const t = five();
  t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B });
  const r = t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: null });
  assert.deepEqual([r.previousParentLayerId, r.parentLayerId], [t.B, null]);
  assert.equal(t.js("A.parent"), null);
});
check("11. self-parent refused before mutation", () => {
  const t = five();
  t.refused("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.A }, /own parent/);
  t.refused("parent_layer", { compId: t.cid, layerId: t.A, parentLayerId: t.A }, /own parent/);
});
check("12. descendant cycle refused before mutation, hierarchy unchanged (A->B->C)", () => {
  const t = five();
  t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B });
  t.ok("set_layer_parent", { compId: t.cid, layerId: t.B, parentLayerId: t.C });
  const e = t.refused("set_layer_parent", { compId: t.cid, layerId: t.C, parentLayerId: t.A }, /cycle/);
  assert.match(e, new RegExp(`${t.A} -> ${t.B} -> ${t.C}`));
  t.refused("set_layer_parent", { compId: t.cid, layerId: t.B, parentLayerId: t.B }, /own parent/);
  t.refused("parent_layer", { compId: t.cid, layerId: t.C, parentLayerId: t.A }, /cycle/);
  assert.deepEqual(t.js("[A.parent.id, B.parent.id, C.parent]"), [t.B, t.C, null]);
});
check("13. world-transform policy: true keeps the world pose, false keeps the local values", () => {
  const t = five();
  t.js(`B._tr.property("Position").v = [500, 300]; A._tr.property("Position").v = [100, 100];`);
  const keep = t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B });
  assert.equal(keep.preserveWorldTransform, true);
  assert.deepEqual(t.js("worldPos(A)"), [100, 100], "default keeps the layer where it is");
  t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: null });
  const jump = t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B, preserveWorldTransform: false });
  assert.equal(jump.localTransformUnchanged, true);
  assert.deepEqual(t.js(`A._tr.property("Position").v`), [100, 100], "jump keeps the local value");
  assert.deepEqual(t.js("worldPos(A)"), [600, 400], "so the layer moves on screen");
  const legacy = t.ok("parent_layer", { compId: t.cid, layerId: t.C, parentLayerId: t.B, preserveTransform: false });
  assert.equal(legacy.localTransformUnchanged, true, "parent_layer preserveTransform:false is a real jump now");
});
check("14. invalid parent: missing, other comp, locked child — refused", () => {
  const t = five();
  t.refused("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: 777777 }, /No layer with id 777777/);
  t.js(`var c2 = mkComp("Other"); var Z = add(c2, "null", "Z");`);
  t.refused("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.js("Z.id") }, /No layer with id/);
  t.js("A.locked = true");
  t.refused("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B }, /locked/);
  t.js("A.locked = false; B.locked = true");
  t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B });   // a locked layer CAN be a parent
});

// ---------------------------------------------------------------------------
// set_track_matte
// ---------------------------------------------------------------------------
check("15. modern track matte from an exact source (below the target, no adjacency)", () => {
  const t = five();
  const r = t.ok("set_track_matte", { compId: t.cid, targetLayerId: t.E, matte: { sourceLayerId: t.A, type: "LUMA" } });
  assert.deepEqual(r.trackMatte, { sourceLayerId: t.A, type: "LUMA" });
  assert.equal(r.hasTrackMatte, true);
  assert.equal(r.sourceEnabled, false);
  assert.deepEqual(t.order("c"), [t.E, t.D, t.C, t.B, t.A], "nothing reordered");
  const s = t.ok("get_layer_structure", { compId: t.cid });
  const A = s.layers.find((l) => l.layerId === t.A);
  assert.deepEqual([A.isTrackMatte, A.matteForLayerIds], [true, [t.E]]);
});
check("16. clear track matte", () => {
  const t = five();
  t.ok("set_track_matte", { compId: t.cid, targetLayerId: t.E, matte: { sourceLayerId: t.A, type: "ALPHA" } });
  const r = t.ok("set_track_matte", { compId: t.cid, targetLayerId: t.E, matte: null });
  assert.deepEqual([r.trackMatte, r.hasTrackMatte, r.previous.sourceLayerId], [null, false, t.A]);
  assert.equal(r.previousSourceEnabled, false);
});
check("track matte refusals: self, camera source, camera target, locked target", () => {
  const t = five();
  t.refused("set_track_matte", { compId: t.cid, targetLayerId: t.E, matte: { sourceLayerId: t.E, type: "ALPHA" } }, /own matte/);
  t.js(`var cam = add(c, "camera", "Cam");`);
  const cam = t.js("cam.id");
  t.refused("set_track_matte", { compId: t.cid, targetLayerId: t.E, matte: { sourceLayerId: cam, type: "ALPHA" } }, /camera or light/);
  t.refused("set_track_matte", { compId: t.cid, targetLayerId: cam, matte: { sourceLayerId: t.A, type: "ALPHA" } }, /camera or light/);
  t.js("E.locked = true");
  t.refused("set_track_matte", { compId: t.cid, targetLayerId: t.E, matte: { sourceLayerId: t.A, type: "ALPHA" } }, /locked/);
});
check("17. matte survives reorder: same source id, no relinking", () => {
  const t = five();
  t.ok("set_track_matte", { compId: t.cid, targetLayerId: t.C, matte: { sourceLayerId: t.D, type: "ALPHA" } });
  const src = () => t.ok("get_layer_structure", { compId: t.cid }).layers.find((l) => l.layerId === t.C).trackMatte.sourceLayerId;
  t.ok("move_layer", { compId: t.cid, layerId: t.B, to: "beginning" });       // unrelated
  assert.equal(src(), t.D);
  t.ok("move_layer", { compId: t.cid, layerId: t.D, afterLayerId: t.C });     // source below target
  assert.equal(src(), t.D);
  t.ok("move_layer", { compId: t.cid, layerId: t.D, to: "end" });
  assert.equal(src(), t.D);
  t.ok("move_layer", { compId: t.cid, layerId: t.D, to: "beginning" });
  assert.equal(src(), t.D);
});

// ---------------------------------------------------------------------------
// get_layer_structure
// ---------------------------------------------------------------------------
check("structure read: relationships, nulls for camera flags, truncation", () => {
  const t = five();
  t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B });
  t.js(`var cam = add(c, "camera", "Cam");`);
  const s = t.ok("get_layer_structure", { compId: t.cid });
  const B = s.layers.find((l) => l.layerId === t.B);
  assert.deepEqual(B.childLayerIds, [t.A]);
  const cam = s.layers[0];
  assert.deepEqual([cam.sourceType, cam.threeDLayer, cam.adjustmentLayer, cam.sourceItemId], ["camera", null, null, null]);
  assert.equal(s.layers.find((l) => l.layerId === t.D).sourceItemType, "solid");
  const cut = t.ok("get_layer_structure", { compId: t.cid, maxLayers: 2 });
  assert.equal(cut.layers.length, 2);
  assert.deepEqual([cut.truncated, cut.truncation.omitted, cut.truncation.nextUnlistedIndex], [true, 4, 3]);
  const capped = cut.layers.length;
  assert.equal(capped, 2);
});

// ---------------------------------------------------------------------------
// precompose_layers
// ---------------------------------------------------------------------------
check("19. precompose one layer (moveAll true): new comp, new replacement, verified", () => {
  const t = five();
  const r = t.ok("precompose_layers", { compId: t.cid, layerIds: [t.C], name: "Pre C" });
  assert.equal(r.moveAllAttributes, true);
  assert.equal(r.layerIdsChanged, true);
  assert.equal(r.precompLayerIndex, 3);
  assert.equal(t.order("c")[2], r.precompLayerId);
  assert.ok(!t.order("c").includes(t.C), "the old id is gone");
  assert.equal(r.innerLayers.length, 1);
  assert.equal(r.innerLayers[0].fromLayerId, t.C);
  assert.notEqual(r.innerLayers[0].layerId, t.C);
  assert.equal(t.js(`app.project.itemByID(${r.newCompId}).name`), "Pre C");
});
check("20-21. precompose several non-contiguous layers: ids converted to indices at call time", () => {
  const t = five();
  t.ok("move_layer", { compId: t.cid, layerId: t.A, to: "beginning" });   // indices shift; ids do not
  const r = t.ok("precompose_layers", { compId: t.cid, layerIds: [t.B, t.A, t.D], name: "Group" });
  assert.deepEqual(r.sourceLayerIds, [t.A, t.D, t.B], "sorted front to back by current index");
  assert.deepEqual(r.innerLayers.map((l) => l.fromLayerId), [t.A, t.D, t.B]);
  assert.equal(r.precompLayerIndex, 1);
  assert.deepEqual(t.order("c"), [r.precompLayerId, t.E, t.C]);
});
check("22. a duplicated layerId is refused", () => {
  const t = five();
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.C, t.C], name: "x" }, /listed twice/);
});
check("23. a missing layer is refused", () => {
  const t = five();
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.C, 999999], name: "x" }, /No layer with id 999999/);
});
check("24. precompose readback fails loudly if AE leaves an old layer behind", () => {
  const t = five();
  // A precompose that forgets to remove what it moved — readback must notice.
  t.js(`var real = precompose; precompose = function (cc, i, n, m) { var keep = cc._layers.slice(); var nc = real(cc, i, n, m);
        for (var k = 0; k < keep.length; k++) if (cc._layers.indexOf(keep[k]) < 0) { keep[k]._comp = cc; cc._layers.push(keep[k]); } return nc; };`);
  const r = t.run("precompose_layers", { compId: t.cid, layerIds: [t.C], name: "x" });
  assert.equal(r.ok, false);
  assert.match(r.error, /still in comp/);
});
check("25. moveAllAttributes true keeps parent and matte when both ends are selected", () => {
  const t = five();
  t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B });
  t.ok("set_track_matte", { compId: t.cid, targetLayerId: t.D, matte: { sourceLayerId: t.C, type: "ALPHA" } });
  const r = t.ok("precompose_layers", { compId: t.cid, layerIds: [t.A, t.B, t.C, t.D], name: "Rig" });
  const nc = r.newCompId;
  const inner = t.ok("get_layer_structure", { compId: nc }).layers;
  const by = (from) => inner.find((l) => l.layerId === r.innerLayers.find((x) => x.fromLayerId === from).layerId);
  assert.equal(by(t.A).parentLayerId, by(t.B).layerId);
  assert.equal(by(t.D).trackMatte.sourceLayerId, by(t.C).layerId);
  assert.equal(inner.length, 4, "no copied matte source");
});
check("26. moveAllAttributes false: same id, kept parent and matte, renamed", () => {
  const t = five();
  t.ok("set_layer_parent", { compId: t.cid, layerId: t.D, parentLayerId: t.B });
  t.ok("set_track_matte", { compId: t.cid, targetLayerId: t.D, matte: { sourceLayerId: t.E, type: "ALPHA" } });
  const r = t.ok("precompose_layers", { compId: t.cid, layerIds: [t.D], name: "Keep D", moveAllAttributes: false });
  assert.deepEqual([r.precompLayerId, r.layerIdsChanged, r.precompLayerName], [t.D, false, "Keep D"]);
  const s = t.ok("get_layer_structure", { compId: t.cid }).layers.find((l) => l.layerId === t.D);
  assert.deepEqual([s.parentLayerId, s.trackMatte.sourceLayerId, s.sourceItemId], [t.B, t.E, r.newCompId]);
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.A, t.B], name: "x", moveAllAttributes: false }, /exactly one layer/);
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.E], name: "x", moveAllAttributes: false }, /no source item/);
});
check("27. unsafe matte boundary refused (both directions)", () => {
  const t = five();
  t.ok("set_track_matte", { compId: t.cid, targetLayerId: t.D, matte: { sourceLayerId: t.C, type: "ALPHA" } });
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.D], name: "x" }, /copies the source into the precomp/);
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.C], name: "x" }, /re-points the matte/);
  assert.equal(t.js("D.trackMatteLayer.id"), t.C);
});
check("28. unsafe parenting boundary refused (both directions)", () => {
  const t = five();
  t.ok("set_layer_parent", { compId: t.cid, layerId: t.A, parentLayerId: t.B });
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.A], name: "x" }, /drops the parent/);
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.B], name: "x" }, /re-parents it to the precomp layer/);
  assert.equal(t.js("A.parent.id"), t.B);
});
check("precompose hazards: locked, camera, 3D, adjustment above unselected, expressions, folder", () => {
  const t = five();
  t.js("C.locked = true");
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.C], name: "x" }, /locked/);
  t.js("C.locked = false; C.threeDLayer = true");
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.C], name: "x" }, /is 3D/);
  t.js("C.threeDLayer = false; C.adjustmentLayer = true");
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.C], name: "x" }, /adjustment layer/);
  t.ok("precompose_layers", { compId: t.cid, layerIds: [t.C, t.B, t.A], name: "adj ok" });   // nothing unselected below it
  t.js(`var cam = add(c, "camera", "Cam");`);
  t.refused("precompose_layers", { compId: t.cid, layerIds: [t.js("cam.id")], name: "x" }, /camera or light/);

  const u = five();
  u.js(`E._tr.property("Opacity").expression = 'thisComp.layer("D").transform.opacity';`);
  u.refused("precompose_layers", { compId: u.cid, layerIds: [u.D], name: "x" }, /moves into the precomp/);
  u.refused("precompose_layers", { compId: u.cid, layerIds: [u.E], name: "x" }, /stays in this comp/);
  u.ok("precompose_layers", { compId: u.cid, layerIds: [u.D, u.E], name: "both" });

  const v = five();
  v.js(`A._tr.property("Opacity").expression = 'thisComp.layer(2).transform.opacity';`);
  v.refused("precompose_layers", { compId: v.cid, layerIds: [v.D], name: "x" }, /by index/);
  v.js(`A._tr.property("Opacity").expression = 'thisComp.layer(index - 1).transform.opacity';`);
  v.refused("precompose_layers", { compId: v.cid, layerIds: [v.D], name: "x" }, /cannot be checked/);
  v.js(`A._tr.property("Opacity").expression = 'index * 10';`);
  v.refused("precompose_layers", { compId: v.cid, layerIds: [v.D, v.E], name: "x" }, /uses index or numLayers/);
  v.js(`A._tr.property("Opacity").expression = 'index * 10';`);
  v.ok("precompose_layers", { compId: v.cid, layerIds: [v.E], name: "A keeps its index" });

  const w = five();
  w.js(`var p = new Prop("Layer", 2); p.propertyValueType = PropertyValueType.LAYER_INDEX; p.canSetExpression = false; A._fx._p.push(new Group("Displace", [p]));`);
  w.refused("precompose_layers", { compId: w.cid, layerIds: [w.D], name: "x" }, /effect parameter/);

  const f = five();
  f.js(`var dest = mkFolder("Dest");`);
  const r = f.ok("precompose_layers", { compId: f.cid, layerIds: [f.C], name: "filed", parentFolderId: f.js("dest.id") });
  assert.equal(r.parentFolderId, f.js("dest.id"));
  f.refused("precompose_layers", { compId: f.cid, layerIds: [f.B], name: "x", parentFolderId: f.js("c.id") }, /not a project folder/);
});
check("32-33. every op is one undo group and never saves the project", () => {
  const t = five();
  t.ok("move_layer", { compId: t.cid, layerId: t.A, to: "beginning" });
  t.ok("precompose_layers", { compId: t.cid, layerIds: [t.C], name: "p" });
  const undo = t.js("UNDO");
  assert.deepEqual(undo, ["begin:AE MCP: move_layer", "end", "begin:AE MCP: precompose_layers", "end"]);
  t.ok("get_layer_structure", { compId: t.cid });
  assert.equal(t.js("UNDO.length"), 4, "the structural read opens no undo group");
});

// ---------------------------------------------------------------------------
// Server side: schemas, classification, run_batch
// ---------------------------------------------------------------------------
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { validateBatchOps, parseOpArgs } = await import(dist("tools", "batchSteps.js"));
const { schemas } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "index.js")).href);
const NEW = ["get_layer_structure", "move_layer", "set_layer_parent", "set_track_matte", "precompose_layers"];

check("29. strict schemas: unknown keys refused, exactly one move destination, matte shape", () => {
  for (const op of NEW) assert.ok(schemas.OpSchemas[op], `${op} has a schema`);
  assert.throws(() => parseOpArgs("move_layer", { compId: 1, layerId: 2, to: "end", toIndex: 1 }), /toIndex|unrecognized/i);
  assert.throws(() => parseOpArgs("move_layer", { compId: 1, layerId: 2 }), /exactly one/);
  assert.throws(() => parseOpArgs("move_layer", { compId: 1, layerId: 2, to: "end", beforeLayerId: 3 }), /exactly one/);
  assert.throws(() => parseOpArgs("move_layer", { compId: 1, layerId: 2, to: "top" }));
  assert.deepEqual(parseOpArgs("move_layer", { compId: 1, layerId: 2, afterLayerId: 3 }), { compId: 1, layerId: 2, afterLayerId: 3 });
  assert.throws(() => parseOpArgs("set_track_matte", { compId: 1, targetLayerId: 2, matte: { sourceLayerId: 3, type: "NO_TRACK_MATTE" } }));
  assert.throws(() => parseOpArgs("set_track_matte", { compId: 1, targetLayerId: 2, matte: { sourceLayerId: 3, type: "ALPHA", extra: 1 } }));
  assert.throws(() => parseOpArgs("set_track_matte", { compId: 1, targetLayerId: 2 }));
  assert.equal(parseOpArgs("set_track_matte", { compId: 1, targetLayerId: 2, matte: null }).matte, null);
  assert.equal(parseOpArgs("set_layer_parent", { compId: 1, layerId: 2, parentLayerId: null }).preserveWorldTransform, true);
  assert.throws(() => parseOpArgs("precompose_layers", { compId: 1, layerIds: [], name: "x" }));
  assert.throws(() => parseOpArgs("precompose_layers", { compId: 1, layerIds: [1], name: "   " }));
  assert.throws(() => parseOpArgs("precompose_layers", { compId: 1, layerIds: [1.5], name: "x" }));
  assert.equal(parseOpArgs("precompose_layers", { compId: 1, layerIds: [1], name: "x" }).moveAllAttributes, true);
  assert.throws(() => parseOpArgs("duplicate_layer", { compId: 1, layerId: 2, newName: "" }));
});
check("30. mutation classification", () => {
  assert.equal(schemas.OpMutation.get_layer_structure, "read");
  for (const op of ["move_layer", "set_layer_parent", "set_track_matte", "precompose_layers", "duplicate_layer", "parent_layer"]) {
    assert.equal(schemas.OpMutation[op], "write", op);
  }
});
check("31. run_batch: a later invalid structural step refuses the whole batch before any is sent", () => {
  const good = { op: "move_layer", args: { compId: 1, layerId: 2, to: "end" } };
  const out = validateBatchOps([good, { op: "set_layer_parent", args: { compId: 1, layerId: 2, parentLayerId: 3 } }]);
  assert.equal(out[1].args.preserveWorldTransform, true, "defaults applied per step");
  assert.throws(() => validateBatchOps([good, { op: "move_layer", args: { compId: 1, layerId: 2, to: "end", afterLayerId: 4 } }]), /Nothing was sent[\s\S]*step 1 /);
  assert.throws(() => validateBatchOps([good, { op: "precompose_layers", args: { compId: 1, layerIds: [], name: "x" } }]), /Nothing was sent[\s\S]*step 1 /);
  assert.throws(() => validateBatchOps([good, { op: "set_track_matte", args: { compId: 1, targetLayerId: 2, matte: { sourceLayerId: 3 } } }]), /Nothing was sent[\s\S]*step 1 /);
});

console.log(`layer-structure: ${passed} checks passed`);
