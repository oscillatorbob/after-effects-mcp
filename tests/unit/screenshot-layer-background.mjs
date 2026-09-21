// screenshot_layer's `background` option, and a bug found while measuring it
// live: the solo-restore loop that predates this option threw on any comp
// containing a disabled layer, because AE refuses to touch `.solo` on one at
// all ("Solo flag can not be set on a layer if the layer is not enabled").
// Measured against a real disposable comp (issue class: the loop ran outside
// any try/finally, so the throw left whatever solo states it had already
// changed with nothing to restore).
//
// Two things are worth a dedicated check rather than trust:
//
//   - `background` must be genuinely temporary: a solid added only for the one
//     render, positioned behind the isolated layer (not in front, not
//     unordered), solo'd alongside it, and removed again — in every case,
//     including a `saveFrameToPng` that throws. No implementation of "create,
//     use, clean up" is trustworthy without a case that fails partway through.
//   - The pre-existing solo-restore loop must survive a disabled layer without
//     throwing, and without ever assigning `.solo` on one — the mock enforces
//     that assignment itself throws, the same way the real API does, so a
//     handler that still tries it fails the test rather than merely being
//     unverified.
//
// A third thing, found auditing the first two live: `addSolid()` creates not
// just the AVLayer but a backing Solid FootageItem in the Project panel too
// (`layer.source`). Removing only the layer left that item behind — measured
// against the real op on a disposable comp, project item count went 7 -> 8
// and stayed there. So the mock also models `app.project.items` and each
// solid's `.source`, distinct from the layer, with its own `.remove()`.
//
// There is no ExtendScript runtime on a runner, so After Effects is stubbed
// down to what the op touches: itemByID, a comp with layer()/numLayers,
// layers.addSolid (and the FootageItem it creates), and moveAfter/remove on
// the layer and source objects it returns.
//
//   node tests/unit/screenshot-layer-background.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };
const plain = (v) => JSON.parse(JSON.stringify(v));

// A fresh fake project per case, loading the real core.jsx/ids.jsx/vision.jsx —
// not a stub of screenshot_layer itself.
function load() {
  const ctx = { app: {} };
  vm.createContext(ctx);
  vm.runInContext(
    `
    function CompItem() {}

    // .solo assignment on a disabled layer throws, exactly as measured
    // against real After Effects: "Solo flag can not be set on a layer if
    // the layer is not enabled." A handler that still tries this on a
    // disabled layer fails here the same way it failed live.
    function mkLayer(spec) {
      var enabled = spec.enabled === undefined ? true : spec.enabled;
      var soloVal = spec.solo === undefined ? false : spec.solo;
      var obj = {
        id: spec.id,
        name: spec.name === undefined ? ("Layer " + spec.id) : spec.name,
        enabled: enabled,
        get solo() { return soloVal; },
        set solo(v) {
          if (!enabled) throw new Error("Solo flag can not be set on a layer if the layer is not enabled.");
          soloVal = v;
        },
        moveAfter: function (other) {
          var idx = comp._layers.indexOf(obj);
          comp._layers.splice(idx, 1);
          var otherIdx = comp._layers.indexOf(other);
          comp._layers.splice(otherIdx + 1, 0, obj);
        },
        remove: function () {
          var idx = comp._layers.indexOf(obj);
          if (idx >= 0) comp._layers.splice(idx, 1);
          obj.removed = true;
        }
      };
      return obj;
    }

    // Every project item that exists before mkComp runs, so a test can assert
    // none of THESE were ever touched — distinct from anything addSolid creates.
    var PROJECT_ITEMS = [];
    function mkPreexistingItem(id, name) {
      var it = { id: id, name: name, removed: false, remove: function () {
        var idx = PROJECT_ITEMS.indexOf(it);
        if (idx >= 0) PROJECT_ITEMS.splice(idx, 1);
        it.removed = true;
      } };
      PROJECT_ITEMS.push(it);
      return it;
    }

    var comp; // set inside mkComp, referenced by moveAfter/remove closures above
    function mkComp(spec) {
      var c = new CompItem();
      comp = c;
      c.id = spec.id === undefined ? 1 : spec.id;
      c.width = spec.width === undefined ? 1920 : spec.width;
      c.height = spec.height === undefined ? 1080 : spec.height;
      c.pixelAspect = spec.pixelAspect === undefined ? 1 : spec.pixelAspect;
      c.duration = spec.duration === undefined ? 10 : spec.duration;
      c.resolutionFactor = [1, 1];
      c._layers = [];
      c.addedSolids = [];
      c.savedFrames = [];
      for (var i = 0; i < spec.layers.length; i++) c._layers.push(mkLayer(spec.layers[i]));

      Object.defineProperty(c, "numLayers", { get: function () { return c._layers.length; } });
      c.layer = function (idx) { return c._layers[idx - 1]; };

      c.layers = {
        addSolid: function (color, name, width, height, pixelAspect, duration) {
          var id = 9000 + c.addedSolids.length;
          var l = mkLayer({ id: id, name: name, enabled: true });
          // The backing FootageItem addSolid() creates alongside the layer —
          // a brand-new project item every call, never one that pre-existed.
          var srcId = 8000 + c.addedSolids.length;
          var src = { id: srcId, name: name, removed: false, remove: function () {
            if (spec.throwOnSourceRemove) throw new Error(spec.throwOnSourceRemove);
            var idx = PROJECT_ITEMS.indexOf(src);
            if (idx >= 0) PROJECT_ITEMS.splice(idx, 1);
            src.removed = true;
          } };
          PROJECT_ITEMS.push(src);
          l.source = src;
          c.addedSolids.push({ id: id, color: color, name: name, width: width, height: height, pixelAspect: pixelAspect, duration: duration, source: src });
          c._layers.unshift(l); // AE inserts a new layer at the front
          return l;
        }
      };

      c.saveFrameToPng = function (time, file) {
        if (spec.throwOnSave) throw new Error(spec.throwOnSave);
        c.savedFrames.push({
          time: time,
          order: c._layers.map(function (l) { return l.id; }),
          soloed: c._layers.filter(function (l) { return l.solo; }).map(function (l) { return l.id; }),
          resolutionFactor: c.resolutionFactor.slice()
        });
      };

      app.project = {
        itemByID: function (id) { return id === c.id ? c : null; },
        get items() { return PROJECT_ITEMS.slice(); }
      };
      return c;
    }

    function Folder(p) { this.fsName = p; }
    Folder.temp = new Folder("/tmp");
    function File(p) { this.fsName = p; }
    `,
    ctx,
  );
  vm.runInContext(read("core.jsx"), ctx, { filename: "core.jsx" });
  vm.runInContext(read("ids.jsx"), ctx, { filename: "ids.jsx" });
  vm.runInContext(read("vision.jsx"), ctx, { filename: "vision.jsx" });
  const run = (args) => vm.runInContext("OPS.screenshot_layer", ctx)(args);
  return { ctx, run, get: (expr) => vm.runInContext(expr, ctx) };
}

// ---------- default behaviour is unchanged: no background, no solid ----------
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 1 }, { id: 2 }, { id: 3 }] });`);
  const res = run({ compId: get("comp.id"), layerId: 2, time: 0, downsample: 1 });
  eq(res.layerId, 2);
  eq(plain(get("comp.addedSolids")), [], "no background requested, so no solid was ever created");
  eq(plain(get("comp.savedFrames[0].soloed")), [2], "only the target layer is solo'd");
  eq(get("comp._layers.length"), 3, "no layer left behind");
  eq(get("comp.layer(1).solo"), false, "every layer ends de-solo'd, including the target");
  eq(get("PROJECT_ITEMS.length"), 0, "no background requested, so no project item was ever created either");
}

// ---------- background option parsing / black shorthand ----------
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 1 }, { id: 2 }] });`);
  const res = run({ compId: get("comp.id"), layerId: 2, time: 0, downsample: 1, background: "black" });
  eq(res.layerId, 2, "the op's own return shape is unaffected by background");
  const solids = get("comp.addedSolids");
  eq(solids.length, 1, "exactly one solid was created for the one render");
  eq(plain(solids[0].color), [0, 0, 0], '"black" resolves to [0,0,0]');
  eq(solids[0].width, get("comp.width"));
  eq(solids[0].height, get("comp.height"));
}

// ---------- custom RGB background ----------
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 1 }] });`);
  run({ compId: get("comp.id"), layerId: 1, time: 0, downsample: 1, background: [0.2, 0.4, 0.9] });
  const solids = get("comp.addedSolids");
  eq(plain(solids[0].color), [0.2, 0.4, 0.9], "a custom [r,g,b] is passed through to addSolid untouched");
}

// ---------- background is positioned behind the target, and both are solo'd together ----------
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 5 }, { id: 6 }, { id: 7 }] });`);
  run({ compId: get("comp.id"), layerId: 6, time: 0, downsample: 1, background: "black" });
  const frame = plain(get("comp.savedFrames[0]"));
  const bgId = get("comp.addedSolids[0].id");
  eq(frame.soloed.sort(), [6, bgId].sort(), "exactly the target and the background solid are solo'd — nothing else");
  const order = frame.order;
  const targetPos = order.indexOf(6);
  const bgPos = order.indexOf(bgId);
  eq(bgPos, targetPos + 1, "the background solid sits directly behind (after, in AE's front-to-back order) the target layer");
}

// ---------- temp-layer AND backing project item cleanup on success ----------
// Found auditing the layer-only cleanup against the real op: addSolid()
// creates the AVLayer and a backing Solid FootageItem, and layer.remove()
// only ever removes the layer. Project item count went 7 -> 8 on a real comp
// and stayed there. Both halves have to be checked, not just the layer.
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 1 }, { id: 2 }] });`);
  const before = get("PROJECT_ITEMS.length");
  run({ compId: get("comp.id"), layerId: 1, time: 0, downsample: 1, background: "black" });
  eq(get("comp._layers.length"), 2, "the background solid layer was removed after a successful render");
  const ids = get("comp._layers.map(function(l){return l.id;})");
  ok(!ids.includes(9000), "the solid's id is not among the surviving layers");
  eq(get("PROJECT_ITEMS.length"), before, "the backing project item count returns to its baseline");
  eq(get("comp.addedSolids[0].source.removed"), true, "the exact source this call created was removed");
}

// ---------- temp-layer cleanup on failure, and the throw still propagates ----------
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 1 }, { id: 2 }], throwOnSave: "saveFrameToPng exploded" });`);
  const before = get("PROJECT_ITEMS.length");
  assert.throws(
    () => run({ compId: get("comp.id"), layerId: 1, time: 0, downsample: 1, background: "black" }),
    /saveFrameToPng exploded/,
    "the original failure must still reach the caller",
  );
  passed++;
  eq(get("comp._layers.length"), 2, "no temp layer survives a failed render");
  eq(get("comp.layer(1).solo"), false, "solo states are still restored after a failed render");
  eq(get("PROJECT_ITEMS.length"), before, "no backing project item survives a failed render either");
}

// ---------- no pre-existing project item is ever touched ----------
{
  const { run, get } = load();
  get(`
    mkComp({ layers: [{ id: 1 }, { id: 2 }] });
    mkPreexistingItem(500, "Black Solid 1");
    mkPreexistingItem(501, "Null 1");
  `);
  run({ compId: get("comp.id"), layerId: 1, time: 0, downsample: 1, background: "black" });
  const remaining = get("PROJECT_ITEMS.map(function(it){return it.id;})");
  ok(remaining.includes(500) && remaining.includes(501), "both pre-existing items survive the call");
  eq(remaining.length, 2, "only the two pre-existing items remain — the temporary source was cleaned up");
}

// ---------- source-cleanup failure must not block solo restoration ----------
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 1, solo: false }, { id: 2 }], throwOnSourceRemove: "source.remove() exploded" });`);
  const res = run({ compId: get("comp.id"), layerId: 2, time: 0, downsample: 1, background: "black" });
  eq(res.layerId, 2, "the call still succeeds even though removing the backing source failed internally");
  eq(get("comp._layers.length"), 2, "the background LAYER is still removed even though its source could not be");
  eq(get("comp.layer(1).solo"), false, "solo restoration still happens despite the source-cleanup failure");
  eq(get("comp.layer(2).solo"), false, "the target is still de-solo'd too");
}

// ---------- a disabled layer no longer crashes the solo-restore loop ----------
// This is the bug found while measuring screenshot_layer live: the loop that
// forces every other layer's solo to false ran outside any try/finally and
// unconditionally touched a disabled layer's .solo, which AE refuses. This
// comp has no background requested at all — the fix has to hold for the
// plain case just as much as the new feature.
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 1, solo: true }, { id: 2, enabled: false }, { id: 3 }] });`);
  const res = run({ compId: get("comp.id"), layerId: 3, time: 0, downsample: 1 });
  eq(res.layerId, 3, "the call succeeds even though the comp has a disabled layer");
  eq(get("comp.layer(1).solo"), true, "an unrelated enabled layer's prior solo state is restored");
  eq(get("comp.layer(2).enabled"), false, "the disabled layer itself is untouched");
  eq(plain(get("comp.savedFrames[0].soloed")), [3], "only the target was solo'd during the render");
}

// ---------- a disabled layer alongside a background solid ----------
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 1, enabled: false }, { id: 2 }] });`);
  const res = run({ compId: get("comp.id"), layerId: 2, time: 0, downsample: 1, background: "black" });
  eq(res.layerId, 2);
  eq(get("comp._layers.length"), 2, "the background solid was still cleaned up");
  eq(get("comp.layer(1).enabled"), false, "the disabled layer was never touched");
}

// ---------- target layer's own state is unaffected beyond solo ----------
{
  const { run, get } = load();
  get(`mkComp({ layers: [{ id: 1, name: "Logo" }] });`);
  run({ compId: get("comp.id"), layerId: 1, time: 0, downsample: 1, background: "black" });
  eq(get("comp.layer(1).name"), "Logo", "the target layer's identity is untouched");
  eq(get("comp.layer(1).enabled"), true, "the target layer's enabled state is untouched");
}

// ---------------------------------------------------------------------------
// The schema half
// ---------------------------------------------------------------------------
const sharedDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;
const { OpSchemas, OpMutation } = await import(sharedDist("schemas.js"));
const ScreenshotLayer = OpSchemas.screenshot_layer;

{
  ok(ScreenshotLayer, "screenshot_layer is registered in OpSchemas");

  const omitted = ScreenshotLayer.safeParse({ compId: 1, layerId: 2 });
  ok(omitted.success, `background omitted should parse: ${omitted.error?.message}`);

  const black = ScreenshotLayer.safeParse({ compId: 1, layerId: 2, background: "black" });
  ok(black.success, `"black" should parse: ${black.error?.message}`);

  const rgb = ScreenshotLayer.safeParse({ compId: 1, layerId: 2, background: [0.1, 0.2, 0.3] });
  ok(rgb.success, `an [r,g,b] triple should parse: ${rgb.error?.message}`);

  const white = ScreenshotLayer.safeParse({ compId: 1, layerId: 2, background: "white" });
  eq(white.success, false, '"white" is not a recognised shorthand — [1,1,1] is how a caller asks for it');

  const wrongArity = ScreenshotLayer.safeParse({ compId: 1, layerId: 2, background: [1, 1] });
  eq(wrongArity.success, false, "a 2-element array must be refused, not silently accepted");

  const rgba = ScreenshotLayer.safeParse({ compId: 1, layerId: 2, background: [1, 1, 1, 0.5] });
  eq(rgba.success, false, "a 4-element array must be refused — backgrounds are always opaque solids");
}

eq(OpMutation.screenshot_layer, "read", "screenshot_layer stays classified as a read — background only affects a temporary render, never the project");

console.log(`screenshot-layer-background: ${passed} assertions passed`);
