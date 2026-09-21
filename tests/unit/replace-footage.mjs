// replace_footage — swap a FootageItem's source file in place.
//
// The one property that makes this worth a dedicated test: `.replace()` /
// `.replaceWithSequence()` change the item AE already has, never its id, and
// never touch which layers point at it. That is the whole reason this op
// exists instead of "delete the item, re-import, relink every layer by hand" —
// a layer's transform, effects, keyframes, parenting and expressions all
// survive because nothing about the layer itself is touched. The mock proves
// identity is preserved (`===` on the same project-item object, and matching
// ids), not merely that a same-shaped item exists afterward.
//
// Everything else follows the same conventions purge-footage.mjs already
// established for this file: FootageItem/FileSource/SolidSource mocks, a real
// `dispatch()` so undo grouping is under test too, and no ExtendScript runtime
// since there is none on a CI runner.
//
//   node tests/unit/replace-footage.mjs

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

function load() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `
    function CompItem() {}
    function FolderItem() {}
    function FootageItem() {}
    function AVLayer() {}
    function SolidSource() {}
    function FileSource() {}
    function PlaceholderSource() {}

    var NEXT_ID = 1000;
    var ITEMS = [];
    var THROW_ON_REPLACE = {};   // item name -> error message
    var DISK = {};               // fsName -> true, what "exists" on disk
    var REPLACEMENT_META = {};   // fsName -> {width,height,duration,frameRate,footageMissing}

    function File(p) {
      this.fsName = p;
      Object.defineProperty(this, "exists", { get: function () { return !!DISK[p]; } });
    }

    var ROOT = new FolderItem();
    ROOT.id = 1; ROOT.name = "Root"; ROOT.parentFolder = null;

    function indexOf(it) {
      for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i] === it) return i + 1;
      return -1;
    }
    function addItem(it, folder) {
      it.parentFolder = folder || ROOT;
      ITEMS.push(it);
      return it;
    }
    function compsUsing(it) {
      var out = [];
      for (var i = 0; i < ITEMS.length; i++) {
        var c = ITEMS[i];
        if (!(c instanceof CompItem)) continue;
        for (var j = 0; j < c._layers.length; j++) {
          if (c._layers[j].source === it) { out.push(c); break; }
        }
      }
      return out;
    }
    function avItem(it) {
      Object.defineProperty(it, "usedIn", { get: function () { return compsUsing(it); } });
      it.remove = function () {
        var idx = indexOf(it);
        if (idx > 0) ITEMS.splice(idx - 1, 1);
      };
      return it;
    }

    function applyReplace(f, file) {
      if (THROW_ON_REPLACE[f.name]) throw new Error(THROW_ON_REPLACE[f.name]);
      var meta = REPLACEMENT_META[file.fsName] || {};
      f.mainSource.file = { fsName: file.fsName };
      if (meta.width !== undefined) f.width = meta.width;
      if (meta.height !== undefined) f.height = meta.height;
      if (meta.duration !== undefined) f.duration = meta.duration;
      if (meta.frameRate !== undefined) f.frameRate = meta.frameRate;
      f.footageMissing = !!meta.footageMissing;
    }

    function mkFile(name, fsPath, opts) {
      var o = opts || {};
      var f = new FootageItem();
      f.id = ++NEXT_ID; f.name = name;
      f.mainSource = new FileSource();
      f.mainSource.file = { fsName: fsPath };
      f.width = o.width === undefined ? 200 : o.width;
      f.height = o.height === undefined ? 200 : o.height;
      f.duration = o.duration === undefined ? 0 : o.duration;
      f.frameRate = o.frameRate === undefined ? 0 : o.frameRate;
      f.footageMissing = false;
      f.replace = function (file) { applyReplace(f, file); };
      f.replaceWithSequence = function (file, forceAlphabetical) {
        f.__lastForceAlphabetical = forceAlphabetical;
        applyReplace(f, file);
      };
      return addItem(avItem(f), o.folder);
    }
    function mkFolder(name, folder) {
      var f = new FolderItem();
      f.id = ++NEXT_ID; f.name = name;
      return addItem(f, folder);
    }
    function mkSolid(name, folder) {
      var f = new FootageItem();
      f.id = ++NEXT_ID; f.name = name;
      f.mainSource = new SolidSource();
      f.mainSource.color = [1, 0, 0];
      f.footageMissing = false;
      return addItem(avItem(f), folder);
    }
    function mkLayer(name, source) {
      var l = new AVLayer();
      l.name = name;
      l.source = source || null;
      return l;
    }
    function mkComp(name, layers, folder) {
      var c = new CompItem();
      c.id = ++NEXT_ID; c.name = name;
      c._layers = layers || [];
      c.numLayers = c._layers.length;
      c.layer = function (i) { return c._layers[i - 1]; };
      return addItem(avItem(c), folder);
    }
    function diskFile(fsPath, meta) {
      DISK[fsPath] = true;
      if (meta) REPLACEMENT_META[fsPath] = meta;
    }

    var UNDO = [];
    var app = {
      beginUndoGroup: function (n) { UNDO.push("begin:" + n); },
      endUndoGroup: function () { UNDO.push("end"); },
      project: {
        get numItems() { return ITEMS.length; },
        item: function (i) { return ITEMS[i - 1]; },
        itemByID: function (id) {
          for (var i = 0; i < ITEMS.length; i++) { if (ITEMS[i].id === id) return ITEMS[i]; }
          return null;
        }
      }
    };
    `,
    ctx,
  );
  for (const f of ["core.jsx", "ids.jsx", "footage.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const get = (expr) => vm.runInContext(expr, ctx);
  const data = (expr) => JSON.parse(JSON.stringify(get(expr)));
  const call = (op, args) => JSON.parse(JSON.stringify(get("dispatch")(JSON.stringify({ op, args }))));
  const success = (r) => { assert.equal(r.ok, true, `expected success, got: ${r.error}`); return r.result; };
  const failure = (r) => { assert.equal(r.ok, false, `expected a failure, got: ${JSON.stringify(r.result)}`); return r.error; };
  return { ctx, get, data, call, success, failure };
}

// ---------- valid replacement, identity preserved, dimensions updated ----------
{
  const { get, call, success } = load();
  get(`
    diskFile("/art/logo-v2.png", { width: 400, height: 200, duration: 0, frameRate: 0 });
    var item = mkFile("logo.png", "/art/logo-v1.png", { width: 200, height: 200 });
    var layer = mkLayer("Logo Layer", item);
    var comp = mkComp("MCP Test", [layer]);
  `);
  const itemId = get("item.id");
  const layerSourceBefore = get("layer.source === item");
  ok(layerSourceBefore, "sanity: layer starts pointing at the item");

  const r = success(call("replace_footage", { itemId, filePath: "/art/logo-v2.png" }));

  eq(r.itemId, itemId, "same item id survives replacement");
  eq(r.oldFilePath, "/art/logo-v1.png");
  eq(r.newFilePath, "/art/logo-v2.png");
  eq(r.width, 400, "dimensions read back reflect the new file, not the old one");
  eq(r.height, 200);
  ok(get("item.id") === itemId, "the underlying item object's id never changed");
  ok(get("layer.source === item"), "the layer's source is still the SAME item object — identity, not a lookalike");
  eq(get("item.mainSource.file.fsName"), "/art/logo-v2.png", "the item's own file pointer was actually updated");
}

// ---------- multiple layers referencing the item all keep referencing it ----------
{
  const { get, call, success } = load();
  get(`
    diskFile("/art/b.png", { width: 400, height: 200 });
    var item = mkFile("shared.png", "/art/a.png", { width: 200, height: 200 });
    var l1 = mkLayer("L1", item);
    var l2 = mkLayer("L2", item);
    var l3 = mkLayer("L3", item);
    var comp = mkComp("C", [l1, l2, l3]);
  `);
  const itemId = get("item.id");
  const r = success(call("replace_footage", { itemId, filePath: "/art/b.png" }));
  eq(r.layerCount, 3, "all three layers referencing the item are counted");
  eq(r.usedIn.length, 1, "reported via the one comp that uses it");
  ok(get("l1.source === item && l2.source === item && l3.source === item"), "every layer still points at the same item");
}

// ---------- missing item id rejected ----------
{
  const { get, call, failure } = load();
  get(`diskFile("/art/b.png");`);
  const err = failure(call("replace_footage", { itemId: 999999, filePath: "/art/b.png" }));
  assert.match(err, /No project item with id 999999/);
  passed++;
}

// ---------- comp target rejected ----------
{
  const { get, call, failure } = load();
  get(`var comp = mkComp("A Comp", []); diskFile("/art/b.png");`);
  const compId = get("comp.id");
  const err = failure(call("replace_footage", { itemId: compId, filePath: "/art/b.png" }));
  assert.match(err, /is a comp, not footage/);
  passed++;
}

// ---------- folder target rejected ----------
{
  const { get, call, failure } = load();
  get(`var f = mkFolder("Assets"); diskFile("/art/b.png");`);
  const folderId = get("f.id");
  const err = failure(call("replace_footage", { itemId: folderId, filePath: "/art/b.png" }));
  assert.match(err, /is a folder, not footage/);
  passed++;
}

// ---------- solid target rejected — no external file to replace ----------
{
  const { get, call, failure } = load();
  get(`var s = mkSolid("Black Solid 1"); diskFile("/art/b.png");`);
  const solidId = get("s.id");
  const err = failure(call("replace_footage", { itemId: solidId, filePath: "/art/b.png" }));
  assert.match(err, /no external file source to replace/);
  passed++;
}

// ---------- nonexistent replacement file rejected, old source untouched ----------
{
  const { get, call, failure } = load();
  get(`var item = mkFile("logo.png", "/art/a.png", { width: 200, height: 200 });`);
  const itemId = get("item.id");
  const err = failure(call("replace_footage", { itemId, filePath: "/art/does-not-exist.png" }));
  assert.match(err, /No file at \/art\/does-not-exist\.png/);
  passed++;
  eq(get("item.mainSource.file.fsName"), "/art/a.png", "the old source is untouched when the new path does not exist");
  eq(get("item.width"), 200, "dimensions are untouched too — nothing about the item changed");
}

// ---------- replacement failure (AE throws) creates no duplicate project item ----------
{
  const { get, call, failure } = load();
  get(`
    THROW_ON_REPLACE["logo.png"] = "After Effects could not interpret this file";
    diskFile("/art/b.png", { width: 400, height: 200 });
    var item = mkFile("logo.png", "/art/a.png", { width: 200, height: 200 });
  `);
  const itemId = get("item.id");
  const before = get("ITEMS.length");
  const err = failure(call("replace_footage", { itemId, filePath: "/art/b.png" }));
  assert.match(err, /could not interpret this file/);
  passed++;
  eq(get("ITEMS.length"), before, "no project item was added or removed by the failed replacement");
  eq(get("item.mainSource.file.fsName"), "/art/a.png", "the old source is still what the item points at");
}

// ---------- path with spaces ----------
{
  const { get, call, success } = load();
  get(`
    diskFile("/Users/johnny/My Projects/Assets/logo v2.png", { width: 300, height: 300 });
    var item = mkFile("logo.png", "/art/a.png", { width: 200, height: 200 });
  `);
  const itemId = get("item.id");
  const r = success(call("replace_footage", { itemId, filePath: "/Users/johnny/My Projects/Assets/logo v2.png" }));
  eq(r.newFilePath, "/Users/johnny/My Projects/Assets/logo v2.png", "a path containing spaces passes through untouched");
  eq(r.width, 300);
}

// ---------- Windows-style path passes through untouched ----------
{
  const { get, call, success } = load();
  get(`
    diskFile("C:\\\\Users\\\\Johnny\\\\Documents\\\\assets\\\\logo-v2.png", { width: 500, height: 500 });
    var item = mkFile("logo.png", "C:\\\\Users\\\\Johnny\\\\Documents\\\\assets\\\\logo-v1.png", { width: 200, height: 200 });
  `);
  const itemId = get("item.id");
  const r = success(call("replace_footage", { itemId, filePath: "C:\\Users\\Johnny\\Documents\\assets\\logo-v2.png" }));
  eq(r.newFilePath, "C:\\Users\\Johnny\\Documents\\assets\\logo-v2.png", "a Windows drive-letter path is passed through as a plain string, never reformatted");
  eq(r.width, 500);
}

// ---------- unrelated footage is untouched by replacing a different item ----------
{
  const { get, call, success } = load();
  get(`
    diskFile("/art/b.png", { width: 400, height: 200 });
    var target = mkFile("target.png", "/art/target-a.png", { width: 200, height: 200 });
    var other = mkFile("other.png", "/art/other.png", { width: 111, height: 222 });
  `);
  const targetId = get("target.id");
  const otherId = get("other.id");
  success(call("replace_footage", { itemId: targetId, filePath: "/art/b.png" }));
  eq(get("other.width"), 111, "an unrelated item's width is untouched");
  eq(get("other.height"), 222);
  eq(get("other.mainSource.file.fsName"), "/art/other.png", "an unrelated item's source path is untouched");
}

// ---------- sequence flag reaches replaceWithSequence with forceAlphabetical ----------
{
  const { get, call, success } = load();
  get(`
    diskFile("/seq/frame_001.png", { width: 640, height: 480, duration: 5, frameRate: 24 });
    var item = mkFile("seq.png", "/art/a.png", { width: 200, height: 200 });
  `);
  const itemId = get("item.id");
  const r = success(call("replace_footage", { itemId, filePath: "/seq/frame_001.png", sequence: true }));
  eq(r.width, 640);
  eq(r.duration, 5);
  eq(get("item.__lastForceAlphabetical"), true, "forceAlphabetical is passed as true — the only ordering exposed in v1");
}

// ---------- undo grouping follows the normal write-op convention ----------
{
  const { get, call } = load();
  get(`
    diskFile("/art/b.png", { width: 400, height: 200 });
    var item = mkFile("logo.png", "/art/a.png", { width: 200, height: 200 });
  `);
  const itemId = get("item.id");
  const r = call("replace_footage", { itemId, filePath: "/art/b.png" });
  eq(r.ok, true);
  const undoLog = get("UNDO.slice(0)");
  eq(undoLog.length, 2, "exactly one undo group opened and closed — no noUndo escape hatch, no double-wrapping");
  ok(String(undoLog[0]).indexOf("begin:") === 0 && undoLog[1] === "end", "a real begin/end pair, the same convention every other write op uses");
}
{
  // And a rejected call must not leave an open undo group either — dispatch()
  // wraps the whole handler, so the throw from inside still closes it.
  const { get, call } = load();
  get(`var item = mkFile("logo.png", "/art/a.png", { width: 200, height: 200 });`);
  const itemId = get("item.id");
  const r = call("replace_footage", { itemId, filePath: "/art/does-not-exist.png" });
  eq(r.ok, false);
  const undoLog = get("UNDO.slice(0)");
  eq(undoLog.length, 2, "a refused call still opens and closes its group symmetrically");
}

// ---------------------------------------------------------------------------
// The schema half
// ---------------------------------------------------------------------------
const sharedDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;
const { OpSchemas, OpMutation } = await import(sharedDist("schemas.js"));
const ReplaceFootage = OpSchemas.replace_footage;

{
  ok(ReplaceFootage, "replace_footage is registered in OpSchemas");

  const valid = ReplaceFootage.safeParse({ itemId: 42, filePath: "/art/b.png" });
  ok(valid.success, `a plain valid call should parse: ${valid.error?.message}`);

  const withSequence = ReplaceFootage.safeParse({ itemId: 42, filePath: "/seq/f_001.png", sequence: true });
  ok(withSequence.success, "sequence:true should parse");

  const missingItemId = ReplaceFootage.safeParse({ filePath: "/art/b.png" });
  eq(missingItemId.success, false, "itemId is required");

  const wrongTypeItemId = ReplaceFootage.safeParse({ itemId: "42", filePath: "/art/b.png" });
  eq(wrongTypeItemId.success, false, "itemId must be a number, not a numeric string");

  const missingPath = ReplaceFootage.safeParse({ itemId: 42 });
  eq(missingPath.success, false, "filePath is required");

  const emptyPath = ReplaceFootage.safeParse({ itemId: 42, filePath: "" });
  eq(emptyPath.success, false, "an empty filePath must be refused");

  const wrongTypeSequence = ReplaceFootage.safeParse({ itemId: 42, filePath: "/art/b.png", sequence: "yes" });
  eq(wrongTypeSequence.success, false, "sequence must be boolean, not a string");

  const strict = ReplaceFootage.safeParse({ itemId: 42, filePath: "/art/b.png", extra: true });
  eq(strict.success, false, "the schema is strict — an unknown key must not be silently stripped");
}

eq(OpMutation.replace_footage, "write", "replace_footage is classified as a write, so it serializes behind other writes");

console.log(`replace-footage: ${passed} assertions passed`);
