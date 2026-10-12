// What resolution a screenshot is actually rendered at (issue #72).
//
// `saveFrameToPng` renders at the comp's own `resolutionFactor`, and the comp's
// resolutionFactor is the Resolution dropdown the designer left the viewer on.
// `__saveFrameAt` set it for any factor above 1 and skipped it at 1 — so on a
// comp parked at Quarter, `downsample: 1` returned a quarter-size frame and
// `downsample: 2` returned one four times *larger*. The response never lied
// about it (the panel reads the dimensions out of the PNG's IHDR), which is
// precisely why it was invisible: the picture disagreed with the request while
// the numbers agreed with the picture.
//
// So this runs the real vision.jsx ops against a comp whose factor starts at
// Quarter and records what `saveFrameToPng` saw each time it was called. Three
// properties, all of which have to hold together:
//
//   * every requested factor — 1 included — is set explicitly before the render;
//   * the user's own factor is put back afterwards, including when the render
//     throws, because leaving someone's comp at Quarter is a worse bug than the
//     one being fixed;
//   * omitting the factor still runs the derivation, which is what would break
//     if a zod `.default(1)` were ever added to the screenshot schemas.
//
//   node tests/unit/screenshot-resolution.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const visionSrc = fs.readFileSync(path.join(jsxDir, "vision.jsx"), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`screenshot-resolution FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// The mock DOM. The only thing it really models is that saveFrameToPng renders
// at whatever resolutionFactor happens to be set when it is called.
// ---------------------------------------------------------------------------

const QUARTER = [4, 4];

// A [x, y] resolution factor as a plain host array, whichever realm it came from.
const pair = (v) => [v[0], v[1]];

class MockComp {
  constructor(o) {
    o = o || {};
    this.id = 900;
    this.width = o.width || 1920;
    this.height = o.height || 1080;
    this.time = 0.5;
    // The designer's viewer setting. Quarter unless a test says otherwise.
    // Every assignment is recorded: in After Effects each one is an Undo step,
    // even one that assigns the value the comp already has (measured, 26.5).
    this._rf = (o.resolutionFactor || QUARTER).slice();
    this.rfSets = [];
    this.refuseRestoreTo = o.refuseRestoreTo;   // a factor AE "accepts" but does not keep
    this.renders = [];          // { time, factor } as seen from inside the render
    this.failAt = o.failAt;     // a time whose render throws
    this.layers = [];
  }
  get resolutionFactor() { return this._rf; }
  set resolutionFactor(v) {
    this.rfSets.push(pair(v));
    if (this.refuseRestoreTo && v[0] === this.refuseRestoreTo[0] && this.rfSets.length > 1) return;
    this._rf = pair(v);
  }
  get numLayers() { return this.layers.length; }
  layer(i) { return this.layers[i - 1]; }
  saveFrameToPng(time, file) {
    // Copied element by element rather than with .slice(): the factor the JSX
    // sets is an Array from the vm realm, and deepStrictEqual compares
    // prototypes. This is the host's array holding the same two numbers.
    this.renders.push({ time, factor: pair(this.resolutionFactor), path: file.path });
    if (this.failAt !== undefined && time === this.failAt) {
      throw new Error("After Effects error: could not render the frame");
    }
  }
  // The size AE would write at the factor a render saw. Not used by the code
  // under test — it is how this file states "larger" and "smaller".
  renderedSize(i) {
    const f = this.renders[i].factor[0];
    return [Math.floor(this.width / f), Math.floor(this.height / f)];
  }
}

class MockLayer {
  constructor(id, name) { this.id = id; this.name = name; this.solo = false; this.enabled = true; }
}

// The undo-group calls a capture makes, in order. core.jsx's __beginUndoGroup is
// the only caller of app.beginUndoGroup, so the stub stands in for both.
let undoLog = [];
function loadOps(comp, o) {
  o = o || {};
  undoLog = [];
  const ctx = {
    OPS: {},
    Math, Date, isFinite, Error, String,
    noUndo: (fn) => fn,
    __UNDO_OPEN: o.insideCallerGroup === true,
    __beginUndoGroup: (name) => undoLog.push(["begin", name]),
    app: { endUndoGroup: () => undoLog.push(["end"]) },
    Folder: { temp: { fsName: "/tmp/ae-mcp-test" } },
    File: class { constructor(p) { this.path = p; } },
    getCompById: (id) => {
      assert.equal(id, comp.id, "the handler must resolve the comp it was given");
      return comp;
    },
    getLayerById: (c, id) => {
      const hit = c.layers.find((l) => l.id === id);
      assert.ok(hit, `no mock layer ${id}`);
      return hit;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(visionSrc, ctx, { filename: "vision.jsx" });
  return ctx.OPS;
}

function scene(o) {
  const comp = new MockComp(o);
  comp.layers = [new MockLayer(1, "bg"), new MockLayer(2, "title"), new MockLayer(3, "chip")];
  return { comp, ops: loadOps(comp, o) };
}

const factors = (comp) => comp.renders.map((r) => r.factor);
// What the viewer is left on once the op has finished.
const viewer = (comp) => pair(comp.resolutionFactor);

// ---------------------------------------------------------------------------
// The reported bug, stated as the comparison that made it visible
// ---------------------------------------------------------------------------

check("downsample 2 is never larger than downsample 1 — the whole of issue #72", () => {
  const { comp, ops } = scene();               // viewer left on Quarter
  ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  ops.screenshot_frame({ compId: comp.id, downsample: 2 });
  const [full, half] = [comp.renderedSize(0), comp.renderedSize(1)];
  assert.deepEqual(full, [1920, 1080], `downsample 1 rendered ${full.join("x")}, not the comp's true size`);
  assert.deepEqual(half, [960, 540]);
  assert.ok(full[0] > half[0], "downsample 1 must be the larger of the two");
});

check("downsample 1 sets the factor rather than inheriting the comp's own", () => {
  const { comp, ops } = scene();
  const out = ops.screenshot_frame({ compId: comp.id, time: 2, downsample: 1 });
  assert.deepEqual(factors(comp), [[1, 1]], "the render must have seen Full, not the viewer's Quarter");
  assert.equal(out.downsample, 1, "the reported factor is the one that was rendered");
});

check("every explicit factor is honoured from every starting viewer resolution", () => {
  for (const start of [[1, 1], [2, 2], [3, 3], [4, 4], [8, 8]]) {
    for (const ds of [1, 2, 3, 4, 8]) {
      const { comp, ops } = scene({ resolutionFactor: start });
      const out = ops.screenshot_frame({ compId: comp.id, downsample: ds });
      assert.deepEqual(
        comp.renders[0].factor, [ds, ds],
        `viewer at ${start[0]}, downsample ${ds} rendered at ${comp.renders[0].factor[0]}`,
      );
      assert.equal(out.downsample, ds);
      assert.deepEqual(viewer(comp), start, "the viewer's own setting must come back");
    }
  }
});

// ---------------------------------------------------------------------------
// The restore, which the fix must not have cost
// ---------------------------------------------------------------------------

check("the viewer's resolution is restored after a successful render", () => {
  const { comp, ops } = scene();
  ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  assert.deepEqual(viewer(comp), QUARTER);
  ops.screenshot_frame({ compId: comp.id, downsample: 3 });
  assert.deepEqual(viewer(comp), QUARTER);
});

check("the viewer's resolution is restored when the render throws — at factor 1 too", () => {
  // The finally used to be reachable only above factor 1. Now that 1 sets the
  // factor as well, 1 is the case that would leave a comp at Full if the
  // restore were ever moved into the success path.
  for (const ds of [1, 4]) {
    const { comp, ops } = scene({ failAt: 2 });
    assert.throws(
      () => ops.screenshot_frame({ compId: comp.id, time: 2, downsample: ds }),
      /could not render the frame/,
    );
    assert.deepEqual(
      viewer(comp), QUARTER,
      `a throw at downsample ${ds} left the comp at ${viewer(comp)[0]}`,
    );
  }
});

check("screenshot_layer sets the factor explicitly and restores solo as well", () => {
  const { comp, ops } = scene();
  comp.layers[0].solo = true;                 // a solo the user set, to be put back
  const out = ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 });
  assert.deepEqual(factors(comp), [[1, 1]]);
  assert.deepEqual(viewer(comp), QUARTER);
  assert.deepEqual(comp.layers.map((l) => l.solo), [true, false, false], "solo state must be restored");
  assert.equal(out.layerId, 2);
  assert.equal(out.downsample, 1);
});

check("screenshot_layer restores both the resolution and the solo state on a throw", () => {
  const { comp, ops } = scene({ failAt: 0.5 });
  comp.layers[2].solo = true;
  assert.throws(() => ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 }), /could not render/);
  assert.deepEqual(viewer(comp), QUARTER);
  assert.deepEqual(comp.layers.map((l) => l.solo), [false, false, true]);
});

// ---------------------------------------------------------------------------
// The derivation, which a zod `.default(1)` would silently switch off
// ---------------------------------------------------------------------------

check("an omitted factor is derived from the comp, not taken as 1", () => {
  const hd = scene({ width: 1920, height: 1080 });
  assert.equal(hd.ops.screenshot_frame({ compId: hd.comp.id }).downsample, 2);
  assert.deepEqual(hd.comp.renders[0].factor, [2, 2]);

  const uhd = scene({ width: 3840, height: 2160 });
  assert.equal(uhd.ops.screenshot_frame({ compId: uhd.comp.id }).downsample, 3);
  assert.deepEqual(uhd.comp.renders[0].factor, [3, 3]);

  // Already small: the derivation lands on 1, and 1 is now an explicit Full
  // render rather than "whatever the viewer says".
  const small = scene({ width: 800, height: 600 });
  assert.equal(small.ops.screenshot_frame({ compId: small.comp.id }).downsample, 1);
  assert.deepEqual(small.comp.renders[0].factor, [1, 1]);
  assert.deepEqual(viewer(small.comp), QUARTER);
});

check("the screenshot schemas carry no zod default on downsample", () => {
  // Behavioural cover for the same trap: a `.default(1)` reaches the panel as
  // an explicit 1 and the derivation above never runs again.
  const src = fs.readFileSync(path.join(root, "packages", "shared", "src", "schemas.ts"), "utf8");
  const decl = src.slice(src.indexOf("const downsampleParam"));
  const chain = decl.slice(0, decl.indexOf(");"));
  assert.ok(!/\.default\(/.test(chain), "downsampleParam must stay optional with no default");
});

// ---------------------------------------------------------------------------
// The contact sheet, which renders through the same function
// ---------------------------------------------------------------------------

check("every tile of a sheet renders at the sheet's factor, explicit 1 included", () => {
  const { comp, ops } = scene();
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2], downsample: 1 });
  assert.equal(out.contactSheet, true);
  assert.deepEqual(factors(comp), [[1, 1], [1, 1], [1, 1]], "a Quarter viewer must not shrink the tiles");
  assert.equal(out.downsample, 1);
  // Array.from, because `tiles` was built inside the vm realm and
  // deepStrictEqual compares prototypes.
  assert.deepEqual(Array.from(out.tiles, (t) => t.downsample), [1, 1, 1]);
  assert.deepEqual(viewer(comp), QUARTER);
});

check("a sheet's derived per-tile factor is used for the render, not just reported", () => {
  const { comp, ops } = scene();               // 1080p, single-frame factor 2
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2] });
  assert.equal(out.downsample, 4, "ceil(2 * sqrt(3)) — a sheet costs about what one frame costs");
  assert.deepEqual(factors(comp), [[4, 4], [4, 4], [4, 4]]);
  assert.deepEqual(viewer(comp), QUARTER);
});

check("one tile that will not render costs neither the others nor the restore", () => {
  const { comp, ops } = scene({ failAt: 1 });
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2], downsample: 1 });
  assert.equal(out.tiles.length, 3, "every requested time keeps its cell");
  assert.equal(out.tiles[1].path, undefined);
  assert.match(out.tiles[1].error, /could not render the frame/);
  assert.ok(out.tiles[0].path && out.tiles[2].path);
  assert.deepEqual(factors(comp), [[1, 1], [1, 1], [1, 1]]);
  assert.deepEqual(viewer(comp), QUARTER, "a failed tile must not leave the comp at Full");
});

// ---------------------------------------------------------------------------
// The Undo history (recipe 64). Measured on 26.5 before this fix: every
// resolution assignment was its own "Resolution Change" step — even one that
// assigned the value the comp already had — so a single frame cost the user
// two steps and a 4-tile sheet eight, sitting on top of their last edit.
// ---------------------------------------------------------------------------

const plainOf = (v) => JSON.parse(JSON.stringify(v));
const groups = () => undoLog.filter((e) => e[0] === "begin").length;
const balanced = () => undoLog.filter((e) => e[0] === "begin").length === undoLog.filter((e) => e[0] === "end").length;

check("U1. a capture at the viewer's own resolution assigns nothing and opens no group", () => {
  for (const ds of [1, 2, 4]) {
    const { comp, ops } = scene({ resolutionFactor: [ds, ds] });
    const out = ops.screenshot_frame({ compId: comp.id, time: 1, downsample: ds });
    assert.deepEqual(comp.rfSets, [], `viewer already at ${ds}: an unchanged assignment is still an Undo step in AE`);
    assert.deepEqual(factors(comp), [[ds, ds]], "the render still sees the requested factor");
    assert.equal(groups(), 0);
    const u = plainOf(out.undo);
    assert.equal(u.undoGroupsOpened, 0);
    assert.equal(u.undoGroupName, null);
    assert.deepEqual(u.temporaryChanges, []);
    assert.equal(u.restored, true);
  }
});

check("U2. a capture that must change the resolution does it inside ONE named group, closed after the restore", () => {
  const { comp, ops } = scene();               // Quarter, asked for 2
  const out = ops.screenshot_frame({ compId: comp.id, time: 1, downsample: 2 });
  assert.deepEqual(comp.rfSets, [[2, 2], [4, 4]], "one set, one restore");
  assert.deepEqual(undoLog, [["begin", "AE MCP: screenshot (view only)"], ["end"]]);
  assert.deepEqual(viewer(comp), QUARTER);
  const u = plainOf(out.undo);
  assert.equal(u.undoGroupsOpened, 1);
  assert.equal(u.undoGroupName, "AE MCP: screenshot (view only)");
  assert.deepEqual(u.temporaryChanges, ["resolution"]);
  assert.equal(u.restored, true);
});

check("U3. a contact sheet changes the resolution once for the whole sheet, not once per tile", () => {
  const { comp, ops } = scene();
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2, 3], downsample: 2 });
  assert.deepEqual(factors(comp), [[2, 2], [2, 2], [2, 2], [2, 2]], "every tile still renders at the sheet's factor");
  assert.deepEqual(comp.rfSets, [[2, 2], [4, 4]], "set before the first tile, restored after the last");
  assert.equal(groups(), 1);
  assert.ok(balanced());
  assert.equal(plainOf(out.undo).undoGroupsOpened, 1);
  // And at the viewer's own factor, a sheet costs nothing at all.
  const same = scene({ resolutionFactor: [2, 2] });
  const out2 = same.ops.screenshot_frame({ compId: same.comp.id, times: [0, 1, 2, 3], downsample: 2 });
  assert.deepEqual(same.comp.rfSets, []);
  assert.equal(plainOf(out2.undo).undoGroupsOpened, 0);
});

check("U4. a render that throws still restores, still closes the group, and the failure carries the account", () => {
  const { comp, ops } = scene({ failAt: 2 });
  let err;
  try { ops.screenshot_frame({ compId: comp.id, time: 2, downsample: 1 }); } catch (e) { err = e; }
  assert.ok(err, "the render failure must still be a failure");
  assert.match(err.message, /could not render the frame/, "the original error is the one thrown");
  assert.deepEqual(viewer(comp), QUARTER);
  assert.ok(balanced(), "the group must close on the failure path too — one left open swallows the user's next edits");
  const u = plainOf(err.aeDetail.screenshotUndo);
  assert.equal(u.undoGroupsOpened, 1);
  assert.deepEqual(u.temporaryChanges, ["resolution"]);
  assert.equal(u.restored, true);
});

check("U5. one failed tile in a sheet: the sheet returns, the account covers the whole capture", () => {
  const { comp, ops } = scene({ failAt: 1 });
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2], downsample: 1 });
  assert.match(out.tiles[1].error, /could not render the frame/);
  assert.equal(groups(), 1);
  assert.ok(balanced());
  assert.equal(plainOf(out.undo).restored, true);
  assert.deepEqual(viewer(comp), QUARTER);
});

check("U6. inside a caller's own undo group no group is opened; the changes join the caller's step", () => {
  const { comp, ops } = scene({ insideCallerGroup: true });
  const out = ops.screenshot_frame({ compId: comp.id, time: 1, downsample: 2 });
  assert.equal(groups(), 0, "a nested beginUndoGroup would be closed by our endUndoGroup — and close the caller's too");
  assert.deepEqual(undoLog, []);
  assert.deepEqual(viewer(comp), QUARTER, "still restored");
  const u = plainOf(out.undo);
  assert.equal(u.undoGroupsOpened, 0);
  assert.equal(u.insideCallerGroup, true);
  assert.deepEqual(u.temporaryChanges, ["resolution"]);
});

check("U7. a restore After Effects does not keep is reported, not assumed", () => {
  const { comp, ops } = scene({ refuseRestoreTo: QUARTER });
  const out = ops.screenshot_frame({ compId: comp.id, time: 1, downsample: 2 });
  const u = plainOf(out.undo);
  assert.equal(u.restored, false);
  assert.match(u.problems.join(" "), /resolution reads \[2,2\] after restoring, not its original \[4,4\]/);
  assert.ok(balanced());
});

check("U8. screenshot_layer: solo and resolution changes share one group; nothing to change means no group", () => {
  const { comp, ops } = scene();
  comp.layers[0].solo = true;
  const out = ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 });
  assert.equal(groups(), 1);
  assert.ok(balanced());
  const u = plainOf(out.undo);
  assert.deepEqual(u.temporaryChanges, ["solo", "resolution"]);
  assert.deepEqual(comp.layers.map((l) => l.solo), [true, false, false]);
  // Target already the only solo, viewer already at the factor: no change at all.
  const quiet = scene({ resolutionFactor: [1, 1] });
  quiet.comp.layers[1].solo = true;
  const out2 = quiet.ops.screenshot_layer({ compId: quiet.comp.id, layerId: 2, downsample: 1 });
  assert.equal(groups(), 0);
  assert.equal(plainOf(out2.undo).undoGroupsOpened, 0);
  assert.deepEqual(quiet.comp.layers.map((l) => l.solo), [false, true, false], "the user's own solo is left exactly as it was");
});

check("U9. screenshot_layer that throws mid-render restores solo and resolution, closes the group, carries the account", () => {
  const { comp, ops } = scene({ failAt: 0.5 });
  comp.layers[2].solo = true;
  let err;
  try { ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 }); } catch (e) { err = e; }
  assert.ok(err);
  assert.ok(balanced());
  assert.deepEqual(comp.layers.map((l) => l.solo), [false, false, true]);
  assert.deepEqual(viewer(comp), QUARTER);
  assert.equal(plainOf(err.aeDetail.screenshotUndo).undoGroupsOpened, 1);
});

console.log(`screenshot-resolution: ${passed} checks passed`);
process.exit(0);
