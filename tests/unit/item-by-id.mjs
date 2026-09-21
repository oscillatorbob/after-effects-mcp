// itemByIdOrNull (packages/jsx/ids.jsx) and every op built on it.
//
// Measured live against real AE 2026: app.project.itemByID(id) does not
// reliably return null for a missing item — it throws its own internal
// message ("internal verification failure, sorry! {Item Not Found}") for
// every nonexistent id tried, and never once returned null. Every op below
// wrote `if (!item) throw <friendly message>`, which was dead code on this
// AE version: the raw AE error reached the caller instead. This is the
// regression suite for the fix, run against the ops it actually reaches
// (getCompById and everything built on it, replace_footage,
// create_footage_layer, purge_unused_footage's folderId), not just the
// helper in isolation — a helper that behaves correctly in a vacuum proves
// nothing about whether five different call sites actually reach it.
//
// The mock's `itemByID` is switchable per test between AE's two observed
// shapes — a clean null return, and the measured throw — so every op is
// proven against both without assuming which one any given AE version uses.
//
//   node tests/unit/item-by-id.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };

// `throwMode`: "null" (AE's documented behaviour — never observed) or
// "throwNotFound" (what was actually measured). Both must be exercised.
function load(throwMode) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `
    function CompItem() {}
    function FolderItem() {}
    function FootageItem() {}
    function SolidSource() {}
    function FileSource() {}
    function AVLayer() {}

    var THROW_MODE = ${JSON.stringify(throwMode)};
    var NEXT_ID = 1000;
    var ITEMS = [];
    function addItem(it) { ITEMS.push(it); return it; }

    function realItemByID(id) {
      var found = null;
      for (var i = 0; i < ITEMS.length; i++) { if (ITEMS[i].id === id) { found = ITEMS[i]; break; } }
      if (found) return found;
      if (THROW_MODE === "throwNotFound") {
        throw new Error("After Effects error: internal verification failure, sorry! {Item Not Found}");
      }
      return null; // AE's documented behaviour, never actually observed live
    }

    function mkComp(name) {
      var c = new CompItem();
      c.id = ++NEXT_ID; c.name = name; c.numLayers = 0;
      c.layer = function () { return null; };
      c.layers = {
        add: function (item) {
          var l = new AVLayer();
          l.id = ++NEXT_ID; l.name = item.name; l.source = item;
          l.property = function () { return { setValue: function () {} }; };
          return l;
        }
      };
      return addItem(c);
    }
    function mkFolder(name) {
      var f = new FolderItem();
      f.id = ++NEXT_ID; f.name = name;
      return addItem(f);
    }
    function mkFile(name, fsPath) {
      var f = new FootageItem();
      f.id = ++NEXT_ID; f.name = name;
      f.mainSource = new FileSource();
      f.mainSource.file = { fsName: fsPath };
      f.width = 200; f.height = 200; f.duration = 0; f.frameRate = 0; f.footageMissing = false;
      Object.defineProperty(f, "usedIn", { get: function () { return []; } });
      f.replace = function (file) { f.mainSource.file = { fsName: file.fsName }; };
      return addItem(f);
    }

    function File(p) { this.fsName = p; this.exists = true; }

    var UNDO = [];
    var app = {
      beginUndoGroup: function (n) { UNDO.push("begin:" + n); },
      endUndoGroup: function () { UNDO.push("end"); },
      project: {
        get numItems() { return ITEMS.length; },
        item: function (i) { return ITEMS[i - 1]; },
        itemByID: realItemByID
      }
    };
    `,
    ctx,
  );
  for (const f of ["core.jsx", "ids.jsx", "comps.jsx", "footage.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const get = (expr) => vm.runInContext(expr, ctx);
  const call = (op, args) => JSON.parse(JSON.stringify(get("dispatch")(JSON.stringify({ op, args }))));
  const success = (r) => { assert.equal(r.ok, true, `expected success, got: ${r.error}`); return r.result; };
  const failure = (r) => { assert.equal(r.ok, false, `expected a failure, got: ${JSON.stringify(r.result)}`); return r.error; };
  return { get, call, success, failure };
}

for (const mode of ["null", "throwNotFound"]) {
  const label = mode === "null" ? "AE returns null" : "AE throws Item Not Found (measured live)";

  // 1. getCompById, reached directly through create_footage_layer.
  {
    const { get, call, failure } = load(mode);
    get(`var c = mkComp("Comp A"); var f = mkFile("logo.png", "/art/a.png");`);
    const err = failure(call("create_footage_layer", { compId: 999999, itemId: get("f.id") }));
    assert.match(err, /No comp with id 999999/, `[${label}] getCompById's own friendly message must reach the caller`);
    passed++;
  }

  // 2. replace_footage missing item.
  {
    const { call, failure } = load(mode);
    const err = failure(call("replace_footage", { itemId: 999999, filePath: "/art/b.png" }));
    assert.match(err, /No project item with id 999999/, `[${label}] replace_footage's own message`);
    passed++;
  }

  // 3. create_footage_layer missing item (comp exists, item does not).
  {
    const { get, call, failure } = load(mode);
    get(`var c = mkComp("Comp A");`);
    const compId = get("c.id");
    const err = failure(call("create_footage_layer", { compId, itemId: 999999 }));
    assert.match(err, /No project item with id 999999/, `[${label}] create_footage_layer's own message`);
    passed++;
  }

  // 4. purge_unused_footage: missing folderId, through the shared __folderArg
  // helper (also used by duplicate_comp).
  {
    const { call, failure } = load(mode);
    const err = failure(call("purge_unused_footage", { folderId: 999999, dryRun: true }));
    assert.match(err, /No project item with id 999999 to use as folderId/, `[${label}] __folderArg's own message, not the raw AE error`);
    passed++;
    assert.doesNotMatch(err, /internal verification failure/, `[${label}] the raw AE error text never reaches the caller`);
    passed++;
  }

  // 6. valid ids remain unaffected — same call, existing item.
  {
    const { get, call, success } = load(mode);
    get(`var c = mkComp("Comp A"); var f = mkFile("logo.png", "/art/a.png");`);
    const r = success(call("create_footage_layer", { compId: get("c.id"), itemId: get("f.id") }));
    eq(r.itemId, get("f.id"), `[${label}] a valid id still resolves correctly`);
  }

  // 7. a non-comp/wrong-type target still gets its own distinct message, not
  // conflated with "missing".
  {
    const { get, call, failure } = load(mode);
    get(`var folder = mkFolder("Assets");`);
    const err = failure(call("create_footage_layer", { compId: get("folder.id"), itemId: get("folder.id") }));
    // compId resolves through getCompById, which for a FolderItem target
    // reports "is not a CompItem" — never "No comp with id", which would
    // wrongly imply the id could not be found at all.
    assert.match(err, /is not a CompItem/, `[${label}] wrong-type error stays distinct from a missing-item error`);
    assert.doesNotMatch(err, /No comp with id/, `[${label}] a found-but-wrong-type item must not be reported as missing`);
    passed += 2;
  }
}

// 8. unrelated exceptions are never swallowed — only the exact measured
// "Item Not Found" text is treated as "missing". Anything else propagates.
{
  const { get, call, failure } = load("null");
  get(`
    app.project.itemByID = function (id) {
      throw new Error("After Effects error: the project file is corrupt");
    };
  `);
  const err = failure(call("replace_footage", { itemId: 42, filePath: "/art/b.png" }));
  assert.match(err, /project file is corrupt/, "a genuinely unexpected AE error must reach the caller unchanged");
  passed++;
  assert.doesNotMatch(err, /No project item with id/, "it must not be silently reinterpreted as a missing-item case");
  passed++;
}

// The helper itself, directly: proves the distinguishing logic in isolation
// too, not only through the ops built on it.
{
  const { get } = load("throwNotFound");
  get(`var c = mkComp("Comp A");`);
  eq(get(`itemByIdOrNull(c.id) === c`), true, "a valid id returns the same object");
  eq(get(`itemByIdOrNull(999999)`), null, "the measured throw is normalized to null");
}
{
  const { get } = load("null");
  get(`var c = mkComp("Comp A");`);
  eq(get(`itemByIdOrNull(999999)`), null, "a plain null return passes through unchanged");
}

console.log(`item-by-id: ${passed} assertions passed`);
