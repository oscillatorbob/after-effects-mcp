// get_current_time, out of packages/jsx/comps.jsx and the resolveComp helper
// in packages/jsx/ids.jsx.
//
// The whole op is a read: resolve a comp (explicit id, or whatever is active
// in the viewer), report its .time, and derive a frame number from it. The
// only real risk is the resolver — reaching for an id that isn't a comp, or
// falling back to an activeItem that isn't one either, either of which must
// fail with a clear message rather than crash on a missing .time property or
// silently answer for the wrong comp.
//
// There is no ExtendScript runtime on a runner, so After Effects is stubbed
// down to what the op actually touches: itemByID, activeItem, and a comp with
// id/name/time/frameRate. `.time` is a getter that throws on write, so a
// version of the op that ever assigned it — this is meant to be read-only —
// would fail here rather than in someone's project.
//
//   node tests/unit/get-current-time.mjs

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

// A fresh fake project per case.
function load() {
  const ctx = { OPS: {}, noUndo: (fn) => fn, noUndoWhen: (p, fn) => fn, undoNamed: (n, fn) => fn };
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

    // .time is a getter that throws on write, so the op accidentally setting
    // it — the one way a "read-only" op could still move the playhead — fails
    // this mock rather than a designer's project.
    function mkComp(spec) {
      var c = new CompItem();
      NEXT_ID += 1;
      c.id = spec.id === undefined ? NEXT_ID : spec.id;
      c.name = spec.name === undefined ? "Comp" : spec.name;
      c.frameRate = spec.frameRate === undefined ? 30 : spec.frameRate;
      var t = spec.time === undefined ? 0 : spec.time;
      Object.defineProperty(c, "time", {
        get: function () { return t; },
        set: function () { throw new Error("get_current_time must never write .time"); },
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

    var app = {
      project: {
        get activeItem() { return ACTIVE; },
        itemByID: function (id) {
          for (var i = 0; i < ITEMS.length; i++) { if (ITEMS[i].id === id) return ITEMS[i]; }
          return null;
        }
      }
    };

    function setActive(item) { ACTIVE = item; }
    `,
    ctx,
  );
  vm.runInContext(read("ids.jsx"), ctx, { filename: "ids.jsx" });
  vm.runInContext(read("comps.jsx"), ctx, { filename: "comps.jsx" });
  const run = (args) => vm.runInContext("OPS.get_current_time", ctx)(args);
  return { ctx, run, get: (expr) => vm.runInContext(expr, ctx) };
}

// ---------- explicit compId resolves correctly ----------
{
  const { run, get } = load();
  get(`
    var other = mkComp({ time: 9, name: "Other" });
    var main = mkComp({ time: 1.5, name: "Main", frameRate: 30 });
    setActive(other);
  `);
  const res = run({ compId: get("main.id") });
  eq(res.compId, get("main.id"), "the named comp is the one read, not the active one");
  eq(res.compName, "Main");
  eq(res.time, 1.5, "its own time, not the active comp's");
}

// ---------- active comp fallback ----------
{
  const { run, get } = load();
  get(`
    var main = mkComp({ time: 2, name: "Main" });
    setActive(main);
  `);
  const res = run({});
  eq(res.compId, get("main.id"), "no compId given, so the active comp is used");
  eq(res.time, 2);

  const bare = run(undefined);
  eq(bare.compId, get("main.id"), "an omitted args object falls back the same way");
}

// ---------- non-comp active item ----------
{
  const { run, get } = load();
  get(`
    var folder = mkFolder("Rigs");
    setActive(folder);
  `);
  assert.throws(
    () => run({}),
    /No active comp, and no compId given/,
    "a FolderItem active in the viewer must not be read as a comp",
  );
  passed++;

  get(`
    var footage = mkFootage("logo.png");
    setActive(footage);
  `);
  assert.throws(
    () => run({}),
    /No active comp, and no compId given/,
    "neither must a FootageItem",
  );
  passed++;
}

// ---------- no active item at all ----------
{
  const { run } = load();
  assert.throws(
    () => run({}),
    /No active comp, and no compId given\. Open a comp in the viewer, or pass compId\./,
    "a null activeItem gets the same clear error, naming both ways forward",
  );
  passed++;
}

// ---------- a compId that resolves to nothing, or to a non-comp ----------
{
  const { run, get } = load();
  assert.throws(() => run({ compId: 999999 }), /No comp with id 999999/, "getCompById's own message carries through");
  passed++;

  get(`var folder = mkFolder("Rigs");`);
  assert.throws(
    () => run({ compId: get("folder.id") }),
    /is not a CompItem/,
    "an id that resolves to a non-comp item is refused, not read as one",
  );
  passed++;
}

// ---------- time is reported exactly, and frame is derived correctly ----------
{
  const { run, get } = load();
  get(`var main = mkComp({ time: 1, name: "Main", frameRate: 24 });`);
  const res = run({ compId: get("main.id") });
  eq(res.time, 1);
  eq(res.frameRate, 24);
  eq(res.frame, 24, "one second at 24fps is frame 24");
}

{
  // Floating-point time landing a hair short of an exact frame boundary must
  // still read as that frame — the reason frame is rounded, not floored.
  const { run, get } = load();
  get(`var main = mkComp({ time: 2 / 30 - 1e-12, name: "Main", frameRate: 30 });`);
  const res = run({ compId: get("main.id") });
  eq(res.frame, 2, `frame should round to 2, got ${res.frame}`);
}

{
  const { run, get } = load();
  get(`var main = mkComp({ time: 0, name: "Main", frameRate: 25 });`);
  const res = run({ compId: get("main.id") });
  eq(res.frame, 0, "time zero is frame zero");
}

// ---------- never writes .time ----------
{
  // mkComp's setter throws if get_current_time ever assigns .time — reaching
  // this point at all is most of the assertion.
  const { run, get } = load();
  get(`var main = mkComp({ time: 3.2, name: "Main" });`);
  run({ compId: get("main.id") });
  eq(get("main.time"), 3.2, "the comp's time is exactly what it was before the call");
}

// ---------------------------------------------------------------------------
// The schema half
// ---------------------------------------------------------------------------
const sharedDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;
const { OpSchemas, OpMutation } = await import(sharedDist("schemas.js"));
const GetCurrentTime = OpSchemas.get_current_time;

{
  ok(GetCurrentTime, "get_current_time is registered in OpSchemas");

  const bare = GetCurrentTime.safeParse({});
  ok(bare.success, `an empty object should parse: ${bare.error?.message}`);

  const withId = GetCurrentTime.safeParse({ compId: 42 });
  ok(withId.success, "an explicit compId should parse");

  const badType = GetCurrentTime.safeParse({ compId: "42" });
  eq(badType.success, false, "compId must be a number, not a numeric string");

  const strict = GetCurrentTime.safeParse({ compId: 1, extra: true });
  eq(strict.success, false, "the schema is strict — an unknown key must not be silently stripped");
}

eq(OpMutation.get_current_time, "read", "get_current_time is classified as a read, so it never queues behind a write");

console.log(`get-current-time: ${passed} assertions passed`);
