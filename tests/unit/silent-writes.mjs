// Write handlers that used to report success for work they did not do.
//
// Phase A1 of the production-completeness audit found four: an enum name After
// Effects does not define (blend mode, track matte type, mask mode) kept the old
// value and answered {ok:true}; set_transform skipped Orientation and X/Y/Z
// Rotation on a 2D layer without a word; add_text_animator swallowed a failed
// addProperty and returned an animator that animated nothing. Each is now
// refused — and refused *before* anything is written, so a refusal leaves the
// layer exactly as it was.
//
// The handlers run unmodified in a vm against a minimal mock of the AE DOM.
// Every assertion is about observable state on the mock, never about the
// source text.
//
//   node tests/unit/silent-writes.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
const { schemas } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "index.js")).href);

// ---------------------------------------------------------------------------
// Mock AE DOM
// ---------------------------------------------------------------------------

/** An enum object whose members are exactly `names`, valued 5000+i like AE's. */
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const enumOf = (names) => Object.fromEntries(names.map((n, i) => [n, 5000 + i]));

/**
 * A property as AE 26.5x89 was measured to behave: a hidden one accepts its own
 * current value back and throws on any other, so a trial write proves nothing;
 * `canSetExpression` tracks hidden-ness unless `lies` says otherwise (the
 * ambient-light case); a static setValue on a keyed property throws.
 */
class Prop {
  constructor(name, matchName, value) {
    this.name = name;
    this.matchName = matchName;
    this.value = value;
    this.numKeys = 0;
    this.keys = [];
    this.writes = [];
    this.hidden = false;
    this.lies = false;
    this.dimensionsSeparated = false;
  }
  get canSetExpression() { return this.lies ? true : !this.hidden; }
  setValue(v) {
    if (this.hidden && JSON.stringify(v) !== JSON.stringify(this.value)) {
      throw new Error("Can not “set value” with this property, because the property or a parent property is hidden.");
    }
    if (this.numKeys > 0) throw new Error("Can not “set value” with this property, because it has keyframes");
    this.value = v;
    this.writes.push(v);
  }
  setValueAtTime(t, v) {
    if (this.hidden) throw new Error("hidden");
    this.keys.push([t, v]);
    this.numKeys = this.keys.length;
    this.writes.push(v);
  }
}

class Group {
  constructor(name, matchName, children = [], factory = null) {
    this.name = name;
    this.matchName = matchName;
    this.children = children;
    this.factory = factory;
    this.parent = null;
    for (const ch of children) ch.parent = this;
  }
  get numProperties() { return this.children.length; }
  get propertyIndex() { return this.parent ? this.parent.children.indexOf(this) + 1 : 0; }
  property(k) {
    if (typeof k === "number") return this.children[k - 1] ?? null;
    return this.children.find((c) => c.name === k || c.matchName === k) ?? null;
  }
  addProperty(match) {
    const node = this.factory ? this.factory(match) : null;
    if (!node) throw new Error(`Can not add a property with name "${match}" to this group`);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

function load() {
  const BLENDS = enumOf(schemas.BLENDING_MODES);
  const ctx = {
    app: {
      beginUndoGroup() {},
      endUndoGroup() {},
      project: { itemByID: (id) => ctx.__items[id] ?? (() => { throw new Error("internal verification failure, sorry! {Item Not Found}"); })() },
    },
    __items: {},
    BlendingMode: BLENDS,
    TrackMatteType: enumOf(schemas.TRACK_MATTE_TYPES),
    MaskMode: enumOf(schemas.MASK_MODES),
    ParagraphJustification: { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7415, RIGHT_JUSTIFY: 7414, FULL_JUSTIFY_LASTLINE_LEFT: 7416 },
    PropertyType: { PROPERTY: 6212, NAMED_GROUP: 6213, INDEXED_GROUP: 6214 },
    Shape: class {},
    LightType: { PARALLEL: 4412, SPOT: 4413, POINT: 4414, AMBIENT: 4415 },
    KeyframeInterpolationType: { LINEAR: 1, BEZIER: 2, HOLD: 3 },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `function CompItem(){}; function TextLayer(){}; function ShapeLayer(){}; function CameraLayer(){}; function LightLayer(){}; function AVLayer(){};
     function FootageItem(){}; function FolderItem(){};`,
    ctx
  );
  for (const f of ["core.jsx", "ids.jsx", "comps.jsx", "layers.jsx", "masks.jsx", "transforms.jsx", "text.jsx", "effects.jsx", "shapes.jsx", "keyframes.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const dispatch = vm.runInContext("dispatch", ctx);
  // Results and stored values are built inside the vm, so they are cloned
  // out before deep comparison — a vm array is not this realm's Array.
  const call = (op, args) => plain(dispatch(JSON.stringify({ op, args })));
  return { ctx, call };
}

/** A comp in `ctx` holding the given layers. */
function addComp(ctx, id, layers) {
  const comp = vm.runInContext("new CompItem()", ctx);
  comp.id = id;
  comp.name = "MCP Test";
  comp.layers = layers;
  comp.layer = (i) => layers[i - 1];
  Object.defineProperty(comp, "numLayers", { get: () => layers.length });
  layers.forEach((l, i) => Object.defineProperty(l, "index", { get: () => layers.indexOf(l) + 1, configurable: true }));
  ctx.__items[id] = comp;
  return comp;
}

/**
 * Which Transform properties refuse a new value, per layer kind — the matrix
 * measured on 26.5x89 (docs/fragile-areas-ae.md). Every property exists on
 * every kind; these are the hidden ones.
 */
const HIDDEN = {
  "2d": ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y"],
  "3d": [],
  camera: ["ADBE Scale", "ADBE Opacity"],
  spot: ["ADBE Scale", "ADBE Opacity"],
  point: ["ADBE Anchor Point", "ADBE Scale", "ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z", "ADBE Opacity"],
  ambient: ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z", "ADBE Opacity"],
};

function transformGroup(kind = "2d") {
  const g = new Group("Transform", "ADBE Transform Group", [
    new Prop(kind === "camera" || kind === "spot" ? "Point of Interest" : "Anchor Point", "ADBE Anchor Point", [0, 0, 0]),
    new Prop("Position", "ADBE Position", [0, 0, 0]),
    new Prop("Scale", "ADBE Scale", [100, 100, 100]),
    new Prop("Orientation", "ADBE Orientation", [0, 0, 0]),
    new Prop("X Rotation", "ADBE Rotate X", 0),
    new Prop("Y Rotation", "ADBE Rotate Y", 0),
    new Prop(kind === "2d" ? "Rotation" : "Z Rotation", "ADBE Rotate Z", 0),
    new Prop("Opacity", "ADBE Opacity", 100),
  ]);
  for (const p of g.children) p.hidden = HIDDEN[kind].includes(p.matchName);
  // The measured mismatch: an ambient light says X/Y Rotation can take an
  // expression although nothing in its Transform group can be set.
  if (kind === "ambient") for (const m of ["ADBE Rotate X", "ADBE Rotate Y"]) g.property(m).lies = true;
  return g;
}

/** A plain AV layer with a Transform group and a Masks group. */
function avLayer(ctx, id, opts = {}) {
  const l = vm.runInContext("new AVLayer()", ctx);
  Object.assign(l, {
    id, name: opts.name ?? `L${id}`, enabled: true, locked: false, shy: false, solo: false,
    threeDLayer: !!opts.threeD, blendingMode: ctx.BlendingMode.NORMAL, label: 0,
    inPoint: 0, outPoint: 5, startTime: 0, stretch: 100, parent: null, source: null,
  });
  const tr = transformGroup(opts.threeD ? "3d" : "2d");
  const masks = new Group("Masks", "ADBE Mask Parade", [], (m) =>
    m === "ADBE Mask Atom"
      ? Object.assign(new Group("Mask 1", "ADBE Mask Atom", [
          new Prop("Mask Path", "ADBE Mask Shape", { vertices: [[0, 0], [1, 0], [1, 1]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]], closed: true }),
          new Prop("Mask Feather", "ADBE Mask Feather", [0, 0]),
          new Prop("Mask Opacity", "ADBE Mask Opacity", 100),
          new Prop("Mask Expansion", "ADBE Mask Offset", 0),
        ]), { maskMode: ctx.MaskMode.ADD, inverted: false })
      : null
  );
  l.__groups = { Transform: tr, Masks: masks };
  l.property = (k) => ({ Transform: tr, "ADBE Transform Group": tr, Masks: masks, "ADBE Mask Parade": masks }[k] ?? null);
  return l;
}

const snapshot = (l) => JSON.stringify({
  name: l.name, blend: l.blendingMode, threeD: l.threeDLayer,
  tr: l.__groups.Transform.children.map((p) => [p.name, p.value, p.writes.length]),
  masks: l.__groups.Masks.children.map((m) => [m.maskMode, m.children[0].value]),
});

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

check("every documented blend mode is accepted and lands on the layer", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 2);
  addComp(ctx, 1, [l]);
  for (const mode of schemas.BLENDING_MODES) {
    const r = call("set_layer", { compId: 1, layerId: 2, blendingMode: mode });
    assert.equal(r.ok, true, `${mode}: ${r.error}`);
    assert.equal(l.blendingMode, ctx.BlendingMode[mode], mode);
  }
});

check("an unknown blend mode is refused and nothing on the layer changes — not even an earlier field", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 2, { name: "keep" });
  addComp(ctx, 1, [l]);
  const before = snapshot(l);
  const r = call("set_layer", { compId: 1, layerId: 2, name: "renamed", blendingMode: "TOTALLY_FAKE_MODE" });
  assert.equal(r.ok, false);
  assert.match(r.error, /TOTALLY_FAKE_MODE/);
  assert.match(r.error, /Nothing was changed/);
  assert.equal(snapshot(l), before);
});

check("a blend mode the schema allows but this AE lacks is refused, not ignored", () => {
  const { ctx, call } = load();
  delete ctx.BlendingMode.HARD_MIX;
  const l = avLayer(ctx, 2);
  addComp(ctx, 1, [l]);
  const r = call("set_layer", { compId: 1, layerId: 2, blendingMode: "HARD_MIX" });
  assert.equal(r.ok, false);
  assert.equal(l.blendingMode, ctx.BlendingMode.NORMAL);
});

check("schema enums accept exactly the documented names and refuse others", () => {
  const set = schemas.SetLayer;
  for (const m of schemas.BLENDING_MODES) set.parse({ compId: 1, layerId: 2, blendingMode: m });
  assert.throws(() => set.parse({ compId: 1, layerId: 2, blendingMode: "TOTALLY_FAKE_MODE" }));
  for (const m of schemas.MASK_MODES) {
    schemas.AddMask.parse({ compId: 1, layerId: 2, vertices: [[0, 0]], mode: m });
    schemas.SetMask.parse({ compId: 1, layerId: 2, maskIndex: 1, mode: m });
  }
  assert.throws(() => schemas.AddMask.parse({ compId: 1, layerId: 2, vertices: [[0, 0]], mode: "ADDD" }));
  assert.throws(() => schemas.SetMask.parse({ compId: 1, layerId: 2, maskIndex: 1, mode: "ADDD" }));
});

check("every mask mode lands; an unknown one adds no mask and changes no mask", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 2);
  addComp(ctx, 1, [l]);
  for (const mode of schemas.MASK_MODES) {
    const r = call("add_mask", { compId: 1, layerId: 2, vertices: [[0, 0], [1, 0], [1, 1]], mode });
    assert.equal(r.ok, true, `${mode}: ${r.error}`);
    assert.equal(l.__groups.Masks.children.at(-1).maskMode, ctx.MaskMode[mode]);
  }
  const count = l.__groups.Masks.numProperties;
  const r = call("add_mask", { compId: 1, layerId: 2, vertices: [[0, 0]], mode: "BOGUS" });
  assert.equal(r.ok, false);
  assert.equal(l.__groups.Masks.numProperties, count, "no mask may be added");

  const before = snapshot(l);
  const s = call("set_mask", { compId: 1, layerId: 2, maskIndex: 1, vertices: [[9, 9]], mode: "BOGUS" });
  assert.equal(s.ok, false);
  assert.equal(snapshot(l), before, "set_mask must not write the path before refusing the mode");
  for (const mode of schemas.MASK_MODES) {
    assert.equal(call("set_mask", { compId: 1, layerId: 2, maskIndex: 1, mode }).ok, true);
    assert.equal(l.__groups.Masks.children[0].maskMode, ctx.MaskMode[mode]);
  }
});

// ---------------------------------------------------------------------------
// set_transform on 2D vs 3D layers
// ---------------------------------------------------------------------------

for (const key of ["orientation", "xRotation", "yRotation", "zRotation"]) {
  check(`set_transform refuses ${key} on a 2D layer, atomically`, () => {
    const { ctx, call } = load();
    const l = avLayer(ctx, 12);
    addComp(ctx, 1, [l]);
    const before = snapshot(l);
    const value = key === "orientation" ? [10, 20, 30] : 45;
    const r = call("set_transform", { compId: 1, layerId: 12, properties: { position: [5, 5], [key]: value } });
    assert.equal(r.ok, false);
    assert.match(r.error, /Layer 12 .* is 2D/);
    assert.match(r.error, /threeDLayer:true/);
    assert.equal(snapshot(l), before, "position must not have landed");
  });
}

check("the same transform works once the layer is 3D", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 12, { threeD: true });
  addComp(ctx, 1, [l]);
  const r = call("set_transform", { compId: 1, layerId: 12, properties: { position: [5, 5, 0], orientation: [10, 20, 30], xRotation: 15 } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result.applied, ["position", "orientation", "xRotation"]);
  assert.deepEqual(plain(l.__groups.Transform.property("Orientation").value), [10, 20, 30]);
  assert.equal(l.__groups.Transform.property("X Rotation").value, 15);
});

check("cameras and lights count as 3D even without a threeDLayer switch", () => {
  const { ctx, call } = load();
  const cam = vm.runInContext("new CameraLayer()", ctx);
  const tr = transformGroup("camera");
  Object.assign(cam, { id: 7, name: "Cam", property: (k) => (k === "Transform" || k === "ADBE Transform Group" ? tr : null) });
  addComp(ctx, 1, [cam]);
  const r = call("set_transform", { compId: 1, layerId: 7, properties: { orientation: [0, 90, 0] } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(plain(tr.property("Orientation").value), [0, 90, 0]);
});

check("valid 2D transforms are unaffected", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 12);
  addComp(ctx, 1, [l]);
  const r = call("set_transform", { compId: 1, layerId: 12, properties: { position: [5, 6], rotation: 30, opacity: 50, scale: [50, 50] } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(plain(l.__groups.Transform.property("Position").value), [5, 6]);
  assert.equal(l.__groups.Transform.property("Rotation").value, 30);
});

check("rotation and zRotation together on a 3D layer is refused, atomically", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 12, { threeD: true });
  addComp(ctx, 1, [l]);
  const before = snapshot(l);
  const r = call("set_transform", { compId: 1, layerId: 12, properties: { opacity: 1, rotation: 10, zRotation: 20 } });
  assert.equal(r.ok, false);
  assert.equal(snapshot(l), before);
});

check("separated Position is refused before anything is written", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 12);
  l.__groups.Transform.property("Position").dimensionsSeparated = true;
  l.__groups.Transform.property("Position").hidden = true;
  addComp(ctx, 1, [l]);
  const before = snapshot(l);
  const r = call("set_transform", { compId: 1, layerId: 12, properties: { opacity: 20, position: [1, 2] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /X Position/);
  assert.equal(snapshot(l), before);
});

// ---------------------------------------------------------------------------
// add_text_animator
// ---------------------------------------------------------------------------

/** A text layer whose animator tree can be told to fail at one step. */
function textLayer(ctx, id, fail = {}) {
  const l = vm.runInContext("new TextLayer()", ctx);
  Object.assign(l, { id, name: `T${id}` });
  const selectorFactory = (m) => {
    if (m !== "ADBE Text Selector" || fail.selector) return null;
    return new Group("Range Selector 1", "ADBE Text Selector", [
      new Prop("Start", "ADBE Text Percent Start", 0),
      new Prop("End", "ADBE Text Percent End", 100),
      new Prop("Offset", "ADBE Text Percent Offset", 0),
    ]);
  };
  const animatorFactory = (m) => {
    if (m !== "ADBE Text Animator" || fail.animator) return null;
    const props = new Group("Properties", "ADBE Text Animator Properties", [], (pm) =>
      fail.property ? null : new Prop(pm.replace("ADBE Text ", ""), pm, 0)
    );
    const sels = new Group("Selectors", "ADBE Text Selectors", [], selectorFactory);
    const a = new Group("Animator", "ADBE Text Animator", [sels, props]);
    return a;
  };
  const animators = new Group("Animators", "ADBE Text Animators", [], animatorFactory);
  const text = new Group("Text", "ADBE Text Properties", [animators]);
  l.__animators = animators;
  l.property = (k) => (k === "Text" || k === "ADBE Text Properties" ? text : null);
  return l;
}

check("a valid animator is created, verified and addressed", () => {
  const { ctx, call } = load();
  const l = textLayer(ctx, 3);
  addComp(ctx, 1, [l]);
  const r = call("add_text_animator", { compId: 1, layerId: 3, type: "opacity", range: { start: 10, end: 60, offset: 5 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(l.__animators.numProperties, 1);
  const anim = l.__animators.property(1);
  assert.ok(anim.property("ADBE Text Animator Properties").property("ADBE Text Opacity"));
  const sel = anim.property("ADBE Text Selectors").property(1);
  assert.equal(sel.property("ADBE Text Percent Start").value, 10);
  assert.equal(sel.property("ADBE Text Percent End").value, 60);
  assert.equal(sel.property("ADBE Text Percent Offset").value, 5);
  assert.equal(r.result.animatorIndex, 1);
  assert.equal(r.result.property.matchName, "ADBE Text Opacity");
  assert.deepEqual(r.result.propertyPath, ["ADBE Text Properties", "ADBE Text Animators", 1, "ADBE Text Animator Properties", "ADBE Text Opacity"]);
  assert.deepEqual(r.result.selector, { name: "Range Selector 1", index: 1, start: 10, end: 60, offset: 5 });
});

check("a failed animator-property add is an error and leaves no animator behind", () => {
  const { ctx, call } = load();
  const l = textLayer(ctx, 3, { property: true });
  addComp(ctx, 1, [l]);
  const r = call("add_text_animator", { compId: 1, layerId: 3, type: "position" });
  assert.equal(r.ok, false, "must not report success");
  assert.match(r.error, /animator property ADBE Text Position 3D/);
  assert.match(r.error, /removed, so nothing changed/);
  assert.equal(l.__animators.numProperties, 0);
});

check("a failed selector add is an error and leaves no animator behind", () => {
  const { ctx, call } = load();
  const l = textLayer(ctx, 3, { selector: true });
  addComp(ctx, 1, [l]);
  const r = call("add_text_animator", { compId: 1, layerId: 3, type: "scale", range: { start: 0, end: 50 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /range selector/);
  assert.equal(l.__animators.numProperties, 0);
});

check("a failed animator add is an error", () => {
  const { ctx, call } = load();
  const l = textLayer(ctx, 3, { animator: true });
  addComp(ctx, 1, [l]);
  const r = call("add_text_animator", { compId: 1, layerId: 3, type: "opacity" });
  assert.equal(r.ok, false);
  assert.equal(l.__animators.numProperties, 0);
});

check("an existing animator is untouched when a new one fails", () => {
  const { ctx, call } = load();
  const l = textLayer(ctx, 3);
  addComp(ctx, 1, [l]);
  assert.equal(call("add_text_animator", { compId: 1, layerId: 3, type: "opacity" }).ok, true);
  // Now make selectors fail and add a second one.
  const r2 = (() => {
    const anims = l.__animators;
    const orig = anims.factory;
    anims.factory = (m) => {
      const a = orig(m);
      a.property("ADBE Text Selectors").factory = () => null;
      return a;
    };
    return call("add_text_animator", { compId: 1, layerId: 3, type: "rotation", range: { start: 0 } });
  })();
  assert.equal(r2.ok, false);
  assert.equal(l.__animators.numProperties, 1, "only the new animator is removed");
  assert.ok(l.__animators.property(1).property("ADBE Text Animator Properties").property("ADBE Text Opacity"));
});

// ---------------------------------------------------------------------------
// Track mattes — the mock reproduces what AE 26.5x89 was measured to do:
// a null source is silently accepted, NO_TRACK_MATTE / self / other-comp
// throw, the source's video goes off, and removeTrackMatte leaves the type.
// ---------------------------------------------------------------------------

function matteable(ctx, l, comp) {
  l.hasTrackMatte = false;
  l.trackMatteLayer = null;
  l.trackMatteType = ctx.TrackMatteType.NO_TRACK_MATTE;
  l.isTrackMatte = false;
  l.setTrackMatte = (src, type) => {
    if (typeof type !== "number" || !Object.values(ctx.TrackMatteType).includes(type)) throw new Error("parameter 2");
    if (src === null) return; // measured: accepted, nothing happens
    if (type === ctx.TrackMatteType.NO_TRACK_MATTE || src === l || !comp.layers.includes(src)) {
      throw new Error("Invalid parameters passed to setTrackMatte()");
    }
    l.hasTrackMatte = true;
    l.trackMatteLayer = src;
    l.trackMatteType = type;
    src.isTrackMatte = true;
    src.enabled = false;
  };
  l.removeTrackMatte = () => {
    if (l.trackMatteLayer) l.trackMatteLayer.isTrackMatte = false;
    l.hasTrackMatte = false;
    l.trackMatteLayer = null; // trackMatteType deliberately left stale
  };
  // The legacy setter must never be used again: it silently used the layer above.
  let legacyType = l.trackMatteType;
  Object.defineProperty(l, "trackMatteType", {
    get: () => legacyType,
    set: (v) => {
      if (l.__allowTypeWrite) { legacyType = v; return; }
      throw new Error("test: legacy trackMatteType assignment used");
    },
    configurable: true,
  });
  const set = l.setTrackMatte;
  l.setTrackMatte = (src, type) => { l.__allowTypeWrite = true; try { set(src, type); } finally { l.__allowTypeWrite = false; } };
}

function matteComp() {
  const { ctx, call } = load();
  const above = avLayer(ctx, 20, { name: "Above" });
  const target = avLayer(ctx, 21, { name: "Target" });
  const below = avLayer(ctx, 22, { name: "Below" });
  const comp = addComp(ctx, 1, [above, target, below]);
  for (const l of [above, target, below]) matteable(ctx, l, comp);
  return { ctx, call, above, target, below, comp };
}

check("set_layer uses trackMatte.layerId as the source, reads it back, and does not reorder", () => {
  const { ctx, call, target, below, comp } = matteComp();
  const order = comp.layers.map((l) => l.id);
  const r = call("set_layer", { compId: 1, layerId: 21, trackMatte: { layerId: 22, type: "LUMA_INVERTED" } });
  assert.equal(r.ok, true, r.error);
  assert.equal(target.trackMatteLayer, below, "the named source, not the layer above");
  assert.equal(target.trackMatteType, ctx.TrackMatteType.LUMA_INVERTED);
  assert.deepEqual(r.result.trackMatte, { type: "LUMA_INVERTED", layerId: 22, layerName: "Below", sourceEnabled: false });
  assert.deepEqual(comp.layers.map((l) => l.id), order);
});

check("omitting layerId uses the layer directly above — explicitly, through setTrackMatte", () => {
  const { call, target, above } = matteComp();
  const r = call("set_layer", { compId: 1, layerId: 21, trackMatte: { type: "ALPHA" } });
  assert.equal(r.ok, true, r.error);
  assert.equal(target.trackMatteLayer, above);
  assert.equal(r.result.trackMatte.layerId, 20);
});

check("omitting layerId on the top layer is refused", () => {
  const { call, above } = matteComp();
  const r = call("set_layer", { compId: 1, layerId: 20, trackMatte: { type: "ALPHA" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /top layer/);
  assert.equal(above.hasTrackMatte, false);
});

check("trackMatte:null and NO_TRACK_MATTE clear it, and the reported type ignores AE's stale value", () => {
  for (const clear of [null, { type: "NO_TRACK_MATTE" }]) {
    const { call, target } = matteComp();
    assert.equal(call("set_layer", { compId: 1, layerId: 21, trackMatte: { layerId: 22, type: "ALPHA" } }).ok, true);
    const r = call("set_layer", { compId: 1, layerId: 21, trackMatte: clear });
    assert.equal(r.ok, true, r.error);
    assert.equal(target.hasTrackMatte, false);
    assert.deepEqual(r.result.trackMatte, { type: "NO_TRACK_MATTE", layerId: null });
  }
});

check("an invalid source, self, a camera, or NO_TRACK_MATTE with a layerId is refused before anything is written", () => {
  const cases = [
    [{ layerId: 999, type: "ALPHA" }, /No layer with id 999/],
    [{ layerId: 21, type: "ALPHA" }, /its own matte/],
    [{ layerId: 22, type: "NO_TRACK_MATTE" }, /takes no layerId/],
    [{ layerId: 22, type: "BOGUS" }, /BOGUS/],
  ];
  for (const [tm, re] of cases) {
    const { call, target } = matteComp();
    const r = call("set_layer", { compId: 1, layerId: 21, name: "renamed?", trackMatte: tm });
    assert.equal(r.ok, false, JSON.stringify(tm));
    assert.match(r.error, re);
    assert.equal(target.name, "Target", "no earlier field may land");
    assert.equal(target.hasTrackMatte, false);
  }
  const { ctx, call, comp, target } = matteComp();
  const cam = vm.runInContext("new CameraLayer()", ctx);
  Object.assign(cam, { id: 30, name: "Cam" });
  comp.layers.push(cam);
  const r = call("set_layer", { compId: 1, layerId: 21, trackMatte: { layerId: 30, type: "ALPHA" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /camera or light/);
  assert.equal(target.hasTrackMatte, false);
});

check("a matte that does not read back as requested is an error, not a success", () => {
  const { call, target } = matteComp();
  target.setTrackMatte = () => {}; // AE accepting and doing nothing, as it does for a null source
  const r = call("set_layer", { compId: 1, layerId: 21, trackMatte: { layerId: 22, type: "ALPHA" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not land/);
});

check("schema: trackMatte takes the closed type list and null", () => {
  schemas.SetLayer.parse({ compId: 1, layerId: 2, trackMatte: null });
  for (const t of schemas.TRACK_MATTE_TYPES) schemas.SetLayer.parse({ compId: 1, layerId: 2, trackMatte: { type: t } });
  assert.throws(() => schemas.SetLayer.parse({ compId: 1, layerId: 2, trackMatte: { type: "ALPHA_MATTE" } }));
});

// ---------------------------------------------------------------------------
// create_camera_layer oneNode
// ---------------------------------------------------------------------------

function cameraComp(autoOrientWorks) {
  const { ctx, call } = load();
  ctx.AutoOrientType = { NO_AUTO_ORIENT: 4212, CAMERA_OR_POINT_OF_INTEREST: 4214 };
  const comp = addComp(ctx, 1, []);
  comp.width = 640;
  comp.height = 360;
  comp.layers.addCamera = (name) => {
    const cam = vm.runInContext("new CameraLayer()", ctx);
    let orient = ctx.AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
    Object.assign(cam, { id: 40 + comp.layers.length, name, parent: null, source: null });
    Object.defineProperty(cam, "autoOrient", { get: () => orient, set: (v) => { if (autoOrientWorks) orient = v; } });
    cam.remove = () => comp.layers.splice(comp.layers.indexOf(cam), 1);
    comp.layers.unshift(cam);
    return cam;
  };
  return { ctx, call, comp };
}

check("create_camera_layer oneNode lands auto-orient off", () => {
  const { ctx, call, comp } = cameraComp(true);
  const r = call("create_camera_layer", { compId: 1, name: "Cam", oneNode: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(comp.layers[0].autoOrient, ctx.AutoOrientType.NO_AUTO_ORIENT);
});

check("create_camera_layer oneNode that does not land is an error and leaves no camera", () => {
  const { call, comp } = cameraComp(false);
  const r = call("create_camera_layer", { compId: 1, name: "Cam", oneNode: true });
  assert.equal(r.ok, false, "a two-node camera must not be reported as one-node");
  assert.match(r.error, /one-node camera/);
  assert.equal(comp.layers.length, 0);
});

// ---------------------------------------------------------------------------
// set_transform preflight — every requested property, every layer kind
// ---------------------------------------------------------------------------

/** A camera or light layer with the measured Transform for its kind. */
function rigLayer(ctx, cls, id, kind, extra = {}) {
  const l = vm.runInContext(`new ${cls}()`, ctx);
  const tr = transformGroup(kind);
  Object.assign(l, { id, name: `${kind}${id}`, parent: null, source: null, ...extra });
  l.__groups = { Transform: tr, Masks: new Group("Masks", "ADBE Mask Parade") };
  l.property = (k) => (k === "Transform" || k === "ADBE Transform Group" ? tr : null);
  return l;
}
const trState = (l) => JSON.stringify(l.__groups.Transform.children.map((p) => [p.matchName, p.value, p.keys]));

check("a camera call with one valid and one unsupported property changes nothing", () => {
  const { ctx, call } = load();
  const cam = rigLayer(ctx, "CameraLayer", 7, "camera");
  addComp(ctx, 1, [cam]);
  for (const bad of [{ scale: [50, 50, 50] }, { opacity: 40 }]) {
    const before = trState(cam);
    const r = call("set_transform", { compId: 1, layerId: 7, properties: { position: [20, 30, 40], ...bad } });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /camera 7/);
    assert.match(r.error, /not settable/);
    assert.match(r.error, /Nothing was changed/);
    assert.equal(trState(cam), before, "position must not have landed");
  }
});

check("a valid camera transform still works, Point of Interest included", () => {
  const { ctx, call } = load();
  const cam = rigLayer(ctx, "CameraLayer", 7, "camera");
  addComp(ctx, 1, [cam]);
  const r = call("set_transform", { compId: 1, layerId: 7, properties: { position: [20, 30, 40], anchorPoint: [1, 2, 3], orientation: [0, 90, 0], xRotation: 5 } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result.applied, ["position", "anchorPoint", "orientation", "xRotation"]);
  assert.deepEqual(plain(cam.__groups.Transform.property("ADBE Position").value), [20, 30, 40]);
});

check("lights: an ambient light refuses everything (despite canSetExpression), a spot light takes orientation", () => {
  const { ctx, call } = load();
  ctx.LightType = { PARALLEL: 1, SPOT: 2, POINT: 3, AMBIENT: 4 };
  const amb = rigLayer(ctx, "LightLayer", 8, "ambient", { lightType: 4 });
  const spot = rigLayer(ctx, "LightLayer", 9, "spot", { lightType: 2 });
  const point = rigLayer(ctx, "LightLayer", 10, "point", { lightType: 3 });
  addComp(ctx, 1, [amb, spot, point]);
  const before = trState(amb);
  const a = call("set_transform", { compId: 1, layerId: 8, properties: { xRotation: 10 } });
  assert.equal(a.ok, false);
  assert.match(a.error, /ambient light/);
  assert.equal(trState(amb), before);
  assert.equal(call("set_transform", { compId: 1, layerId: 9, properties: { orientation: [1, 2, 3], position: [4, 5, 6] } }).ok, true);
  const pb = trState(point);
  const p = call("set_transform", { compId: 1, layerId: 10, properties: { position: [1, 1, 1], orientation: [1, 2, 3] } });
  assert.equal(p.ok, false, "a point light has no settable orientation");
  assert.equal(trState(point), pb);
});

check("a static write to an animated property is refused before anything lands", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 12);
  l.__groups.Transform.property("ADBE Opacity").setValueAtTime(0, 0);
  addComp(ctx, 1, [l]);
  const before = trState(l);
  const r = call("set_transform", { compId: 1, layerId: 12, properties: { position: [5, 5], opacity: 50 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /opacity \(Opacity\) is animated \(1 keys\)/);
  assert.equal(trState(l), before);
  // …and keying it works.
  const k = call("set_transform", { compId: 1, layerId: 12, time: 1, keyframe: true, properties: { position: [5, 5], opacity: 50 } });
  assert.equal(k.ok, true, k.error);
  assert.equal(k.result.keyed, true);
  assert.deepEqual(plain(l.__groups.Transform.property("ADBE Opacity").keys.at(-1)), [1, 50]);
  assert.deepEqual(plain(l.__groups.Transform.property("ADBE Position").keys.at(-1)), [1, [5, 5]]);
});

check("a value of the wrong shape is refused before anything lands", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 12);
  addComp(ctx, 1, [l]);
  const before = trState(l);
  for (const props of [{ opacity: 10, position: 5 }, { opacity: 10, scale: [1, 2, 3, 4] }, { opacity: 10, rotation: [1, 2] }]) {
    const r = call("set_transform", { compId: 1, layerId: 12, properties: props });
    assert.equal(r.ok, false, JSON.stringify(props));
    assert.equal(trState(l), before);
  }
});

// ---------------------------------------------------------------------------
// time / keyframe — the JSX enforces it too, for calls that bypass the schema
// ---------------------------------------------------------------------------

check("time without keyframe, and keyframe without time, are refused by all three setters with no write", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 12);
  const blur = new Prop("Blurriness", "ADBE Gaussian Blur 2-0001", 0);
  const effect = new Group("Gaussian Blur", "ADBE Gaussian Blur 2", [blur]);
  const fx = new Group("Effects", "ADBE Effect Parade", [effect]);
  const fillColor = new Prop("Color", "ADBE Vector Fill Color", [1, 0, 0, 1]);
  const fill = new Group("Fill 1", "ADBE Vector Graphic - Fill", [fillColor]);
  const contents = new Group("Contents", "ADBE Root Vectors Group", [fill]);
  const base = l.property;
  l.property = (k) => ({ Effects: fx, "ADBE Effect Parade": fx, Contents: contents, "ADBE Root Vectors Group": contents }[k] ?? base(k));
  addComp(ctx, 1, [l]);
  const cases = [
    ["set_transform", { compId: 1, layerId: 12, properties: { opacity: 5 } }],
    ["set_effect_param", { compId: 1, layerId: 12, effectIndex: 1, paramName: "Blurriness", value: 9 }],
    ["set_shape_property", { compId: 1, layerId: 12, contentPath: ["Contents", "Fill 1"], property: "Color", value: [0, 1, 0, 1] }],
  ];
  for (const [op, args] of cases) {
    for (const bad of [{ time: 1 }, { time: 1, keyframe: false }, { keyframe: true }]) {
      const writesBefore = [opacityWrites(l), blur.writes.length, fillColor.writes.length].join();
      const r = call(op, { ...args, ...bad });
      assert.equal(r.ok, false, `${op} ${JSON.stringify(bad)}`);
      assert.match(r.error, /Nothing was changed/);
      assert.equal([opacityWrites(l), blur.writes.length, fillColor.writes.length].join(), writesBefore, `${op} wrote something`);
    }
    // Both → keyed; neither → static.
    const keyed = call(op, { ...args, time: 2, keyframe: true });
    assert.equal(keyed.ok, true, keyed.error);
    assert.equal(keyed.result.keyed, true);
  }
  assert.deepEqual(plain(blur.keys), [[2, 9]]);
  assert.deepEqual(plain(fillColor.keys), [[2, [0, 1, 0, 1]]]);
});
function opacityWrites(l) { return l.__groups.Transform.property("ADBE Opacity").writes.length; }

check("a static effect / shape write with neither time nor keyframe still works", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 12);
  const blur = new Prop("Blurriness", "ADBE Gaussian Blur 2-0001", 0);
  const fx = new Group("Effects", "ADBE Effect Parade", [new Group("Gaussian Blur", "ADBE Gaussian Blur 2", [blur])]);
  const base = l.property;
  l.property = (k) => (k === "Effects" ? fx : base(k));
  addComp(ctx, 1, [l]);
  const r = call("set_effect_param", { compId: 1, layerId: 12, effectIndex: 1, paramName: "Blurriness", value: 7 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.keyed, false);
  assert.equal(blur.value, 7);
});

// ---------------------------------------------------------------------------
// add_mask / set_mask atomicity
// ---------------------------------------------------------------------------

const maskList = (l) => JSON.stringify(l.__groups.Masks.children.map((m) => [m.name, m.maskMode, m.children[0].value]));

check("add_mask success leaves exactly one new mask with the path and mode", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 2);
  addComp(ctx, 1, [l]);
  const r = call("add_mask", { compId: 1, layerId: 2, vertices: [[0, 0], [5, 0], [5, 5]], mode: "SUBTRACT" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.maskIndex, 1);
  assert.equal(l.__groups.Masks.numProperties, 1);
  assert.equal(l.__groups.Masks.children[0].maskMode, ctx.MaskMode.SUBTRACT);
  assert.deepEqual(plain(l.__groups.Masks.children[0].children[0].value.vertices), [[0, 0], [5, 0], [5, 5]]);
});

/** A layer with two masks already on it, whose next new mask fails at `step`. */
function failingMaskLayer(ctx, step) {
  const l = avLayer(ctx, 2);
  addComp(ctx, 1, [l]);
  const masks = l.__groups.Masks;
  const make = masks.factory;
  masks.addProperty("ADBE Mask Atom");
  masks.addProperty("ADBE Mask Atom");
  masks.children[0].name = "Keep A";
  masks.children[1].name = "Keep B";
  masks.factory = (m) => {
    const node = make(m);
    if (step === "path") node.children[0].setValue = () => { throw new Error("path refused"); };
    if (step === "mode") Object.defineProperty(node, "maskMode", { get: () => 0, set: () => { throw new Error("mode refused"); } });
    return node;
  };
  return l;
}

for (const step of ["path", "mode"]) {
  check(`add_mask failing at the ${step} removes only its own mask; pre-existing masks are untouched`, () => {
    const { ctx, call } = load();
    const l = failingMaskLayer(ctx, step);
    const before = maskList(l);
    const r = call("add_mask", { compId: 1, layerId: 2, vertices: [[0, 0], [1, 1], [2, 0]], mode: "ADD" });
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(`failed setting the mask's ${step}`));
    assert.match(r.error, /removed, so nothing changed/);
    assert.equal(l.__groups.Masks.numProperties, 2, "mask count restored exactly");
    assert.equal(maskList(l), before);
  });
}

check("add_mask refuses mismatched tangents and an empty path before creating anything", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 2);
  addComp(ctx, 1, [l]);
  assert.equal(call("add_mask", { compId: 1, layerId: 2, vertices: [[0, 0], [1, 1]], inTangents: [[0, 0]] }).ok, false);
  assert.equal(call("add_mask", { compId: 1, layerId: 2, vertices: [] }).ok, false);
  assert.equal(l.__groups.Masks.numProperties, 0);
});

check("set_mask applies tangents and closed without vertices (they used to be ignored)", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 2);
  addComp(ctx, 1, [l]);
  call("add_mask", { compId: 1, layerId: 2, vertices: [[0, 0], [5, 0], [5, 5]] });
  const r = call("set_mask", { compId: 1, layerId: 2, maskIndex: 1, closed: false, inTangents: [[1, 1], [1, 1], [1, 1]] });
  assert.equal(r.ok, true, r.error);
  const v = l.__groups.Masks.children[0].children[0].value;
  assert.equal(v.closed, false);
  assert.deepEqual(plain(v.inTangents), [[1, 1], [1, 1], [1, 1]]);
});

check("set_mask refuses an animated property or a vertex-count change without tangents, with no write", () => {
  const { ctx, call } = load();
  const l = avLayer(ctx, 2);
  addComp(ctx, 1, [l]);
  call("add_mask", { compId: 1, layerId: 2, vertices: [[0, 0], [5, 0], [5, 5]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]] });
  const m = l.__groups.Masks.children[0];
  m.property("ADBE Mask Feather").setValueAtTime(0, [3, 3]);
  const before = maskList(l) + JSON.stringify(m.inverted);
  const a = call("set_mask", { compId: 1, layerId: 2, maskIndex: 1, mode: "DIFFERENCE", inverted: true, feather: [9, 9] });
  assert.equal(a.ok, false);
  assert.match(a.error, /animated feather/);
  const b = call("set_mask", { compId: 1, layerId: 2, maskIndex: 1, mode: "DIFFERENCE", vertices: [[0, 0], [1, 1]] });
  assert.equal(b.ok, false);
  assert.match(b.error, /pass inTangents and outTangents/);
  assert.equal(maskList(l) + JSON.stringify(m.inverted), before);
});

// ---------------------------------------------------------------------------
// add_keyframe: a key that cannot be found again is an error, not keyIndex -1
// ---------------------------------------------------------------------------

/** A property whose keys land `shift` seconds away from the time asked for. */
function keyedProp(shift) {
  const p = new Prop("Opacity", "ADBE Opacity", 100);
  p.setValueAtTime = (t, v) => { p.keys.push([t + shift, v]); p.keys.sort((a, b) => a[0] - b[0]); p.numKeys = p.keys.length; };
  p.keyTime = (i) => p.keys[i - 1][0];
  p.nearestKeyIndex = (t) => {
    let best = 1;
    p.keys.forEach((k, i) => { if (Math.abs(k[0] - t) < Math.abs(p.keys[best - 1][0] - t)) best = i + 1; });
    return best;
  };
  p.keyInInterpolationType = () => 1;
  p.keyOutInterpolationType = () => 1;
  p.interpCalls = 0;
  p.setInterpolationTypeAtKey = () => { p.interpCalls++; };
  return p;
}

for (const [label, shift, ok] of [["exact", 0, true], ["within half a frame", 0.01, true], ["far off", 0.5, false]]) {
  check(`add_keyframe re-finds its key (${label})`, () => {
    const { ctx, call } = load();
    const l = avLayer(ctx, 12);
    const prop = keyedProp(shift);
    const tr = l.__groups.Transform;
    tr.children[tr.children.findIndex((c) => c.matchName === "ADBE Opacity")] = prop;
    const comp = addComp(ctx, 1, [l]);
    comp.frameRate = 30;
    const r = call("add_keyframe", { compId: 1, layerId: 12, propertyPath: ["Transform", "Opacity"], time: 1, value: 50, interpolation: { in: "linear", out: "linear" } });
    assert.equal(r.ok, ok, r.error);
    if (ok) {
      assert.equal(r.result.keyIndex, 1);
      assert.equal(prop.interpCalls, 1);
    } else {
      assert.match(r.error, /interpolation was NOT applied/);
      assert.equal(prop.interpCalls, 0);
    }
  });
}

console.log(`silent-writes: ${passed} checks passed`);
