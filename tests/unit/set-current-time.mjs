// set_current_time, out of packages/jsx/comps.jsx, sharing resolveComp with
// get_current_time (packages/jsx/ids.jsx, tests/unit/get-current-time.mjs).
//
// Three things separate this from an ordinary setter and are each worth a
// dedicated check rather than trust:
//
//   - It must report what AE actually ended up at, not an echo of the
//     request. The mock comp's `.time` setter can quantize the assigned
//     value the way a real comp snaps to frame boundaries, so a handler that
//     merely returned the requested `time` back would fail here.
//   - A target outside the comp's own 0..duration must be refused BEFORE
//     `.time` is ever written — never left to AE to clamp or wrap silently.
//     The mock records every write, so "nothing was written" is checked
//     directly rather than inferred from the error message alone.
//   - It must never open an undo group. That is checked against the REAL
//     core.jsx dispatch(), with app.beginUndoGroup/endUndoGroup logged, the
//     same way tests/unit/jsx-undo-group.mjs proves it for run_jsx — trusting
//     that OPS.set_current_time is wrapped in noUndo() would only prove the
//     wrapper was called, not that dispatch() actually honours it.
//
// There is no ExtendScript runtime on a runner, so After Effects is stubbed
// down to what the op touches: itemByID, activeItem, and a comp with
// id/name/time/frameRate/duration.
//
//   node tests/unit/set-current-time.mjs

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
// A vm-realm array (e.g. the mock's own .writes) has a different Array
// prototype from this file's, so deepEqual against a host-realm array
// literal fails on identity even when the contents match. Round-tripping
// through JSON strips that, the same way tests/unit/comp-snapshot.mjs does.
const plain = (v) => JSON.parse(JSON.stringify(v));

// A fresh fake project per case. Loads the REAL core.jsx (not a noUndo stub),
// so dispatch()'s undo-group handling is the genuine thing, matching
// tests/unit/jsx-undo-group.mjs's own approach.
function load() {
  const undoLog = [];
  const ctx = {
    app: {
      beginUndoGroup: (n) => undoLog.push(`begin:${n}`),
      endUndoGroup: () => undoLog.push("end"),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `
    function CompItem() {}
    function FolderItem() {}
    function FootageItem() {}

    var NEXT_ID = 1000;
    var ITEMS = [];
    var ACTIVE = null;

    function addItem(it) { ITEMS.push(it); return it; }

    // .time is read/write and records every assignment in .writes, so a test
    // can assert a rejected call never touches it — and it optionally
    // quantizes the assigned value the way a real comp snaps to a frame
    // boundary, so the handler's read-back is proven to come from AE rather
    // than being an echo of what was requested.
    function mkComp(spec) {
      var c = new CompItem();
      NEXT_ID += 1;
      c.id = spec.id === undefined ? NEXT_ID : spec.id;
      c.name = spec.name === undefined ? "Comp" : spec.name;
      c.frameRate = spec.frameRate === undefined ? 30 : spec.frameRate;
      c.duration = spec.duration === undefined ? 10 : spec.duration;
      var t = spec.time === undefined ? 0 : spec.time;
      var quantize = spec.quantize || null;
      c.writes = [];
      Object.defineProperty(c, "time", {
        get: function () { return t; },
        set: function (v) {
          c.writes.push(v);
          t = quantize ? quantize(v) : v;
        },
        enumerable: true
      });
      return addItem(c);
    }

    function mkFolder(name) {
      var f = new FolderItem();
      NEXT_ID += 1;
      f.id = NEXT_ID;
      f.name = name;
      return addItem(f);
    }

    function mkFootage(name) {
      var f = new FootageItem();
      NEXT_ID += 1;
      f.id = NEXT_ID;
      f.name = name;
      return addItem(f);
    }

    app.project = {
      get activeItem() { return ACTIVE; },
      itemByID: function (id) {
        for (var i = 0; i < ITEMS.length; i++) { if (ITEMS[i].id === id) return ITEMS[i]; }
        return null;
      }
    };
    function setActive(item) { ACTIVE = item; }
    `,
    ctx,
  );
  vm.runInContext(read("core.jsx"), ctx, { filename: "core.jsx" });
  vm.runInContext(read("ids.jsx"), ctx, { filename: "ids.jsx" });
  vm.runInContext(read("comps.jsx"), ctx, { filename: "comps.jsx" });
  const run = (args) => vm.runInContext("OPS.set_current_time", ctx)(args);
  const dispatchCall = (op, args) => vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }));
  return { ctx, run, dispatchCall, undoLog, get: (expr) => vm.runInContext(expr, ctx) };
}

// ---------- explicit compId ----------
{
  const { run, get } = load();
  get(`
    var other = mkComp({ time: 9, name: "Other" });
    var main = mkComp({ time: 0, name: "Main", frameRate: 30, duration: 10 });
    setActive(other);
  `);
  const res = run({ compId: get("main.id"), time: 2 });
  eq(res.compId, get("main.id"), "the named comp is the one written, not the active one");
  eq(res.compName, "Main");
  eq(get("other.time"), 9, "the active comp is left alone");
  eq(get("main.time"), 2, "the named comp's time was actually written");
}

// ---------- active comp fallback ----------
{
  const { run, get } = load();
  get(`
    var main = mkComp({ time: 0, name: "Main", duration: 10 });
    setActive(main);
  `);
  const res = run({ time: 3 });
  eq(res.compId, get("main.id"), "no compId given, so the active comp is used");
  eq(get("main.time"), 3);
}

// ---------- no active comp ----------
{
  const { run } = load();
  assert.throws(
    () => run({ time: 1 }),
    /No active comp, and no compId given\. Open a comp in the viewer, or pass compId\./,
  );
  passed++;
}

// ---------- non-comp active item ----------
{
  const { run, get } = load();
  get(`var folder = mkFolder("Rigs"); setActive(folder);`);
  assert.throws(() => run({ time: 1 }), /No active comp, and no compId given/, "a FolderItem must not be read as a comp");
  passed++;

  get(`var footage = mkFootage("logo.png"); setActive(footage);`);
  assert.throws(() => run({ time: 1 }), /No active comp, and no compId given/, "neither must a FootageItem");
  passed++;
}

// ---------- setting by seconds ----------
{
  const { run, get } = load();
  get(`var main = mkComp({ time: 0, frameRate: 24, duration: 10 });`);
  const res = run({ compId: get("main.id"), time: 4.5 });
  eq(res.time, 4.5);
  eq(plain(get("main.writes")), [4.5], "exactly one write, of the requested seconds");
}

// ---------- setting by frame, and the exact conversion formula ----------
{
  const { run, get } = load();
  get(`var main = mkComp({ time: 0, frameRate: 24, duration: 10 });`);
  const res = run({ compId: get("main.id"), frame: 48 });
  eq(res.time, 2, "48 frames at 24fps is 2 seconds");
  eq(res.frame, 48);
  eq(plain(get("main.writes")), [2], "the write is seconds, converted before it reaches .time");
}
{
  // A frame count that is not an exact multiple of frameRate, so the formula
  // itself is exercised, not just a case that happens to round trip cleanly.
  const { run, get } = load();
  get(`var main = mkComp({ time: 0, frameRate: 30, duration: 10 });`);
  run({ compId: get("main.id"), frame: 20 });
  const written = get("main.writes[0]");
  ok(Math.abs(written - 20 / 30) < 1e-9, `frame / frameRate expected, got ${written}`);
}

// ---------- the returned state comes from AE's read-back, not an echo ----------
{
  const { run, get } = load();
  get(`
    var main = mkComp({
      time: 0, frameRate: 24, duration: 10,
      quantize: function (v) { return Math.round(v * 24) / 24; }
    });
  `);
  // 1.001s at 24fps is not on a frame boundary, so the mock's quantizer moves
  // it. A handler that echoed the request would report 1.001 here.
  const res = run({ compId: get("main.id"), time: 1.001 });
  const expected = Math.round(1.001 * 24) / 24;
  ok(Math.abs(res.time - expected) < 1e-9, `time must be read back from AE (expected ~${expected}, got ${res.time})`);
  ok(Math.abs(res.time - 1.001) > 1e-6, "and must not simply echo the requested 1.001");
  eq(res.frame, Math.round(res.time * 24), "frame is derived from the read-back time, the same convention get_current_time uses");
}

// ---------- negative time / frame rejected, before .time is ever written ----------
{
  const { run, get } = load();
  get(`var main = mkComp({ duration: 10 });`);
  assert.throws(() => run({ compId: get("main.id"), time: -1 }), /outside the comp, which runs 0 to 10s/);
  passed++;
  eq(plain(get("main.writes")), [], "a rejected negative time must never reach .time");
}
{
  const { run, get } = load();
  get(`var main = mkComp({ duration: 10, frameRate: 30 });`);
  assert.throws(() => run({ compId: get("main.id"), frame: -5 }), /outside the comp, which runs 0 to 10s/);
  passed++;
  eq(plain(get("main.writes")), [], "a rejected negative frame must never reach .time");
}

// ---------- non-integer / non-finite frame or time rejected in the handler ----------
// (the JSX-level guard, for a call that reaches OPS directly — run_batch's
// steps are never zod-validated, so this is the only thing that catches it there.)
{
  const { run, get } = load();
  get(`var main = mkComp({ duration: 10 });`);
  assert.throws(() => run({ compId: get("main.id"), frame: 1.5 }), /frame must be a finite integer/);
  passed++;
  assert.throws(() => run({ compId: get("main.id"), time: Infinity }), /time must be a finite number/);
  passed++;
}

// ---------- neither time nor frame ----------
{
  const { run, get } = load();
  get(`var main = mkComp({ duration: 10 });`);
  assert.throws(() => run({ compId: get("main.id") }), /pass exactly one of time or frame/i);
  passed++;
  eq(plain(get("main.writes")), [], "a call refused for having neither field must never reach .time");
}

// ---------- both time and frame reaching the JSX directly must throw ----------
// The schema's crossField rule refuses this for a normal call (below); this
// is the layer that catches a run_batch step, which is never zod-validated.
// Silently preferring `time` would give the handler a looser contract than
// the tool advertises, so it must refuse both exactly as it refuses neither.
{
  const { run, get } = load();
  get(`var main = mkComp({ time: 0, duration: 10, frameRate: 30 });`);
  assert.throws(
    () => run({ compId: get("main.id"), time: 2, frame: 999 }),
    /pass exactly one of time or frame/i,
    "both fields reaching the handler directly must be refused, not silently resolved to time",
  );
  passed++;
  eq(plain(get("main.writes")), [], "a call refused for having both fields must never reach .time");
}

// ---------- beyond-duration is rejected; the exact boundary is inclusive ----------
{
  const { run, get } = load();
  get(`var main = mkComp({ duration: 5, frameRate: 30 });`);
  assert.throws(() => run({ compId: get("main.id"), time: 5.5 }), /outside the comp, which runs 0 to 5s/);
  passed++;
  eq(plain(get("main.writes")), [], "a beyond-duration target must never reach .time");
}
{
  // Exactly at duration is accepted — matching the 0..duration convention
  // already established in this codebase (audio.jsx's cue placement,
  // mogrt.jsx's posterTime), not a new, stricter boundary invented here.
  const { run, get } = load();
  get(`var main = mkComp({ duration: 5, frameRate: 30 });`);
  const res = run({ compId: get("main.id"), time: 5 });
  eq(res.time, 5, "exactly at duration is accepted");
}
{
  // A hair past duration, within float noise, must not be refused on a
  // technicality — the same __TIME_EPS tolerance audio.jsx uses.
  const { run, get } = load();
  get(`var main = mkComp({ duration: 5, frameRate: 30 });`);
  const res = run({ compId: get("main.id"), time: 5 + 1e-9 });
  ok(res && typeof res.time === "number", "a target within float noise of duration is accepted");
}

// ---------- never opens an undo group, checked against the real dispatch() ----------
{
  const { dispatchCall, undoLog, get } = load();
  get(`var main = mkComp({ duration: 10, frameRate: 30 }); setActive(main);`);
  const r = dispatchCall("set_current_time", { time: 2 });
  eq(r.ok, true, "the call itself still succeeds through the real dispatcher");
  eq(r.result.time, 2);
  eq(undoLog, [], "set_current_time must never call app.beginUndoGroup/endUndoGroup");
}
{
  // And a throwing call — the bounds rejection — leaves undo state exactly as
  // untouched as a successful one; noUndo skips withUndo() entirely, so there
  // is no group to leave open on a throw either.
  const { dispatchCall, undoLog, get } = load();
  get(`var main = mkComp({ duration: 5 }); setActive(main);`);
  const r = dispatchCall("set_current_time", { time: 50 });
  eq(r.ok, false);
  eq(undoLog, [], "a rejected call must not touch undo state either");
}

// ---------------------------------------------------------------------------
// The schema half
// ---------------------------------------------------------------------------
const sharedDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;
const { OpSchemas, OpMutation } = await import(sharedDist("schemas.js"));
const SetCurrentTime = OpSchemas.set_current_time;

{
  ok(SetCurrentTime, "set_current_time is registered in OpSchemas");

  const byTime = SetCurrentTime.safeParse({ time: 2.5 });
  ok(byTime.success, `time alone should parse: ${byTime.error?.message}`);

  const byFrame = SetCurrentTime.safeParse({ frame: 48 });
  ok(byFrame.success, `frame alone should parse: ${byFrame.error?.message}`);

  const withComp = SetCurrentTime.safeParse({ compId: 123, frame: 48 });
  ok(withComp.success, "compId alongside frame should parse");

  const neither = SetCurrentTime.safeParse({ compId: 1 });
  eq(neither.success, false, "neither time nor frame must be refused");
  assert.match(neither.error.message, /exactly one of/i);
  passed++;

  const both = SetCurrentTime.safeParse({ time: 1, frame: 1 });
  eq(both.success, false, "both time and frame must be refused");
  assert.match(both.error.message, /exactly one of/i);
  passed++;

  const negTime = SetCurrentTime.safeParse({ time: -1 });
  eq(negTime.success, false, "negative time must be refused by the schema");

  const negFrame = SetCurrentTime.safeParse({ frame: -1 });
  eq(negFrame.success, false, "negative frame must be refused by the schema");

  const fracFrame = SetCurrentTime.safeParse({ frame: 1.5 });
  eq(fracFrame.success, false, "a non-integer frame must be refused by the schema");

  const infTime = SetCurrentTime.safeParse({ time: Infinity });
  eq(infTime.success, false, "a non-finite time must be refused by the schema");

  const strict = SetCurrentTime.safeParse({ time: 1, extra: true });
  eq(strict.success, false, "the schema is strict — an unknown key must not be silently stripped");
}

eq(OpMutation.set_current_time, "write", "set_current_time is classified as a write, so it serializes behind other writes");

console.log(`set-current-time: ${passed} assertions passed`);
