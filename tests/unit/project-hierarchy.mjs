// The Project panel hierarchy tools in packages/jsx/project.jsx: get_project_tree,
// create_project_folder, rename_project_item, move_project_item,
// analyze_project_item_deletion and delete_project_item.
//
// After Effects deletes without asking (measured on 26.5x89, recipe 53): a
// folder takes everything inside it, a comp or footage item takes every layer
// using it in every comp, and a comp takes its Render Queue items. The stub
// below does exactly that, so a tool that forgot to check would destroy the
// stub's layers the way it would destroy the user's — and these tests would
// see it. It also reproduces the root (id 0, absent from project.items,
// itemByID(0) throws, cannot be removed or moved), AE's own cycle errors, and
// project.item(i) walking in panel order so an index moves under a rename.
//
// Every op runs through the real dispatch() from core.jsx, so undo grouping is
// under test too.
//
//   node tests/unit/project-hierarchy.mjs

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
  catch (e) { console.error(`project-hierarchy FAILED: ${name}`); throw e; }
}

const STUB = `
function CompItem() {} function FolderItem() {} function FootageItem() {}
function AVLayer() {} function SolidSource() {} function FileSource() {} function PlaceholderSource() {}
var RQItemStatus = { QUEUED: 3015, DONE: 3017 };
var NEXT_ID = 100, ALL = [], RQ = [], UNDO = [], WRITES = 0;

function itemsIn(folder) { var o = []; for (var i = 0; i < ALL.length; i++) if (ALL[i]._parent === folder) o.push(ALL[i]); return o; }
function panelOrder() { // AE walks project.item(i) depth-first by name: an index moves on rename
  var out = [];
  function walk(f) { var k = itemsIn(f).sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    for (var i = 0; i < k.length; i++) { out.push(k[i]); if (k[i] instanceof FolderItem) walk(k[i]); } }
  walk(ROOT); return out;
}
function invalid(it) { return ALL.indexOf(it) < 0 && it !== ROOT; }
function guard(it) { if (invalid(it)) throw new Error("Object is invalid"); }
function killItem(it) { // AE's remove(): recursive, and it takes layers + RQ items with it
  if (it instanceof FolderItem) { var kids = itemsIn(it); for (var i = 0; i < kids.length; i++) killItem(kids[i]); }
  for (var c = 0; c < ALL.length; c++) if (ALL[c] instanceof CompItem && ALL[c] !== it)
    ALL[c]._layers = ALL[c]._layers.filter(function (l) { return l.source !== it; });
  RQ = RQ.filter(function (q) { return q.comp !== it; });
  ALL.splice(ALL.indexOf(it), 1);
}
function decorate(it, parent) {
  it._parent = parent;
  Object.defineProperty(it, "parentFolder", { configurable: true,
    get: function () { guard(it); return it._parent; },
    set: function (f) { guard(it); WRITES++;
      if (!(f instanceof FolderItem)) throw new Error("After Effects error: Unable to set \\u201cparentFolder\\u201d. " + f + " is not of the correct type.");
      if (f === it) throw new Error("After Effects error: internal verification failure, sorry! {parent_folder_itemH must be different from itemH}");
      for (var p = f; p; p = p._parent) if (p === it) throw new Error("After Effects error: a folder cannot be moved inside itself.");
      it._parent = f; } });
  var nm = it.name;
  Object.defineProperty(it, "name", { configurable: true, get: function () { guard(it); return nm; }, set: function (v) { guard(it); WRITES++; nm = String(v); } });
  it.remove = function () { guard(it); WRITES++; killItem(it); };
  if (it instanceof CompItem || it instanceof FootageItem) Object.defineProperty(it, "usedIn", { get: function () {
    var o = []; for (var i = 0; i < ALL.length; i++) { var c = ALL[i]; if (!(c instanceof CompItem)) continue;
      for (var j = 0; j < c._layers.length; j++) if (c._layers[j].source === it) { o.push(c); break; } } return o; } });
  if (it instanceof FolderItem) {
    Object.defineProperty(it, "numItems", { get: function () { return itemsIn(it).length; } });
    it.item = function (i) { return itemsIn(it)[i - 1]; };
    it.items = { addFolder: function (n) { return mkFolder(n, it); } };
  }
  if (it !== ROOT) ALL.push(it);
  return it;
}
var ROOT = new FolderItem(); ROOT.id = 0; ROOT.name = "Root"; decorate(ROOT, null);
ROOT.remove = function () { throw new Error("After Effects error: Can not remove the root folder."); };
function mkFolder(name, parent) { var f = new FolderItem(); f.id = ++NEXT_ID; f.name = name; return decorate(f, parent || ROOT); }
function mkComp(name, parent) { var c = new CompItem(); c.id = ++NEXT_ID; c.name = name; c._layers = [];
  c.width = 1920; c.height = 1080; c.duration = 5; c.frameRate = 30;
  Object.defineProperty(c, "numLayers", { get: function () { return c._layers.length; } });
  c.layer = function (i) { return c._layers[i - 1]; }; return decorate(c, parent || ROOT); }
function mkFootage(name, parent, file) { var f = new FootageItem(); f.id = ++NEXT_ID; f.name = name;
  f.mainSource = new FileSource(); f.mainSource.file = { fsName: file || "C:\\\\x\\\\" + name + ".png" }; f.width = 8; f.height = 8;
  return decorate(f, parent || ROOT); }
function mkSolid(name, parent) { var f = new FootageItem(); f.id = ++NEXT_ID; f.name = name;
  f.mainSource = new SolidSource(); f.mainSource.color = [1, 0, 0]; f.width = 8; f.height = 8; return decorate(f, parent || ROOT); }
var LAYER_ID = 9000;
function place(comp, source) { var l = new AVLayer(); l.id = ++LAYER_ID; l.name = source.name; l.source = source; comp._layers.push(l); return l; }
function queue(comp) { RQ.push({ comp: comp, status: 3015 }); }

var app = {
  beginUndoGroup: function (n) { UNDO.push("begin:" + n); }, endUndoGroup: function () { UNDO.push("end"); },
  project: {
    rootFolder: ROOT, file: null,
    get numItems() { return ALL.length; },
    item: function (i) { return panelOrder()[i - 1]; },
    itemByID: function (id) { for (var i = 0; i < ALL.length; i++) if (ALL[i].id === id) return ALL[i];
      throw new Error("After Effects error: internal verification failure, sorry! {Item Not Found}"); },
    items: { addFolder: function (n) { return mkFolder(n, ROOT); } },
    renderQueue: { get numItems() { return RQ.length; }, item: function (i) { return RQ[i - 1]; } },
  },
};
`;

function load() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(STUB, ctx, { filename: "stub" });
  for (const f of ["core.jsx", "ids.jsx", "comps.jsx", "explore.jsx", "footage.jsx", "project.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const run = (op, args) => {
    const r = JSON.parse(vm.runInContext(`JSON.stringify(dispatchValue(${JSON.stringify({ op, args })}))`, ctx));
    return r;
  };
  const ok = (op, args) => { const r = run(op, args); assert.equal(r.ok, true, `${op} failed: ${r.error}`); return r.result; };
  const refused = (op, args, re) => {
    const writes = ctx.WRITES;
    const r = run(op, args);
    assert.equal(r.ok, false, `${op} should have been refused`);
    if (re) assert.match(r.error, re);
    assert.equal(ctx.WRITES, writes, `${op} wrote to the project before refusing`);
    return r.error;
  };
  const js = (src) => { const v = vm.runInContext(src, ctx); return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v; };
  return { ctx, run, ok, refused, js };
}

// ---------------------------------------------------------------------------
// get_project_tree
// ---------------------------------------------------------------------------
check("1. root tree of an empty project", () => {
  const { ok } = load();
  const t = ok("get_project_tree", {});
  assert.deepEqual(t.folder, { id: 0, name: "Root", type: "folder", parentFolderId: null, pathIds: [], childCount: 0, isProjectRoot: true });
  assert.deepEqual(t.items, []);
  assert.equal(t.totalItems, 0);
  assert.equal(t.truncated, false);
});

check("2. nested folders: depth-first, parent ids, pathIds, metadata", () => {
  const { ok, js } = load();
  js(`var A = mkFolder("A"), B = mkFolder("B", A), C = mkFolder("C", B), comp = mkComp("Main", B), foot = mkFootage("plate", A, "C:\\\\shots\\\\plate.png"), s = mkSolid("Red", ROOT);
      place(comp, foot); queue(comp);`);
  const t = ok("get_project_tree", {});
  assert.deepEqual(t.items.map((n) => [n.name, n.depth, n.parentFolderId]), [
    ["A", 1, 0], ["B", 2, js("A.id")], ["C", 3, js("B.id")], ["Main", 3, js("B.id")], ["plate", 2, js("A.id")], ["Red", 1, 0],
  ]);
  const main = t.items.find((n) => n.name === "Main");
  assert.deepEqual(main.pathIds, [0, js("A.id"), js("B.id")]);
  assert.equal(main.type, "comp");
  assert.equal(main.width, 1920);
  assert.equal(main.numLayers, 1);
  assert.equal(main.renderQueueCount, 1);
  const plate = t.items.find((n) => n.name === "plate");
  assert.equal(plate.type, "footage");
  assert.equal(plate.sourceKind, "footage");
  assert.equal(plate.filePath, "C:\\shots\\plate.png");
  assert.equal(plate.usedInCount, 1);
  assert.equal(t.items.find((n) => n.name === "Red").type, "solid");
  assert.equal(t.items.find((n) => n.name === "A").childCount, 2);
  assert.equal(t.totalItems, 6);
});

check("34. tree order is deterministic and does not follow AE's index order", () => {
  const { ok, js } = load();
  js(`mkFolder("b"); mkFolder("B"); mkFolder("a"); var z1 = mkComp("same"), z2 = mkComp("same");`);
  const once = ok("get_project_tree", {}).items.map((n) => n.id);
  assert.deepEqual(ok("get_project_tree", {}).items.map((n) => n.id), once);
  const names = ok("get_project_tree", {}).items.map((n) => n.name);
  assert.deepEqual(names, ["a", "B", "b", "same", "same"]);
  const same = ok("get_project_tree", {}).items.filter((n) => n.name === "same").map((n) => n.id);
  assert.ok(same[0] < same[1], "equal names are ordered by id");
});

check("35. truncation by maxItems and by depth is reported", () => {
  const { ok, js } = load();
  js(`var D = mkFolder("D"), E = mkFolder("E", D), F = mkFolder("F", E); mkComp("deep", F); for (var i = 0; i < 5; i++) mkComp("c" + i);`);
  const t = ok("get_project_tree", { maxItems: 3 });
  assert.equal(t.listedCount, 3);
  assert.equal(t.totalItems, 9);
  assert.equal(t.truncated, true);
  assert.equal(t.truncation.reason, "maxItems");
  assert.ok(t.truncation.nextUnlisted && typeof t.truncation.nextUnlisted.id === "number");
  const d = ok("get_project_tree", { depth: 2 });
  assert.deepEqual(d.depthLimitedFolderIds, [js("E.id")]);
  assert.equal(d.items.find((n) => n.name === "E").childrenNotListed, true);
  assert.equal(d.truncated, true);
  const sub = ok("get_project_tree", { folderId: js("E.id") });
  assert.equal(sub.folder.id, js("E.id"));
  assert.deepEqual(sub.folder.pathIds, [0, js("D.id")]);
  assert.deepEqual(sub.items.map((n) => n.name), ["F", "deep"]);
});

// ---------------------------------------------------------------------------
// create_project_folder
// ---------------------------------------------------------------------------
check("3/4/5. folders at root and nested; duplicate names allowed; result is read back", () => {
  const { ok, js } = load();
  const a = ok("create_project_folder", { name: "01_Assets" });
  assert.equal(a.parentFolderId, 0);
  assert.deepEqual(a.pathIds, [0]);
  const n = ok("create_project_folder", { name: "plates", parentFolderId: a.itemId });
  assert.equal(n.parentFolderId, a.itemId);
  assert.deepEqual(n.pathIds, [0, a.itemId]);
  const dup = ok("create_project_folder", { name: "01_Assets" });
  assert.notEqual(dup.itemId, a.itemId);
  assert.equal(js(`app.project.itemByID(${n.itemId}).parentFolder.id`), a.itemId);
  const bad = js("UNDO.slice(-2)");
  assert.deepEqual(bad, ["begin:AE MCP: create project folder", "end"]);
});

check("create_project_folder refuses a blank name and a non-folder parent", () => {
  const { refused, js } = load();
  js(`var cc = mkComp("notAFolder");`);
  refused("create_project_folder", { name: "   " }, /non-empty/);
  refused("create_project_folder", { name: "x", parentFolderId: js("cc.id") }, /not a project folder/);
  refused("create_project_folder", { name: "x", parentFolderId: 424242 }, /No project item with id 424242/);
});

// ---------------------------------------------------------------------------
// rename_project_item
// ---------------------------------------------------------------------------
check("6/7/8/18. rename folder, comp and footage; id unchanged; file path untouched", () => {
  const { ok, js } = load();
  js(`var f = mkFolder("old"), c = mkComp("comp"), ft = mkFootage("img", ROOT, "C:\\\\x\\\\img.png");`);
  for (const [v, to] of [["f", "new folder"], ["c", "new comp"], ["ft", "new footage"]]) {
    const id = js(`${v}.id`);
    const r = ok("rename_project_item", { itemId: id, name: to });
    assert.equal(r.itemId, id);
    assert.equal(r.actualName, to);
    assert.equal(js(`app.project.itemByID(${id}).name`), to);
  }
  assert.equal(js("ft.mainSource.file.fsName"), "C:\\x\\img.png");
});

check("9/33. the root (id 0) cannot be renamed, moved or deleted", () => {
  const { refused, js } = load();
  refused("rename_project_item", { itemId: 0, name: "Mine" }, /project root/);
  refused("move_project_item", { itemId: 0, folderId: 0 }, /project root/);
  refused("delete_project_item", { itemId: 0 }, /project root/);
  refused("analyze_project_item_deletion", { itemId: 0 }, /project root/);
  assert.equal(js("ROOT.name"), "Root");
});

check("26. a missing id is a friendly error, not AE's internal one", () => {
  const { refused } = load();
  for (const op of ["rename_project_item", "move_project_item", "delete_project_item", "analyze_project_item_deletion"]) {
    const msg = refused(op, { itemId: 777777, name: "x", folderId: 0 }, /No project item with id 777777/);
    assert.doesNotMatch(msg, /internal verification failure/);
  }
});

// ---------------------------------------------------------------------------
// move_project_item
// ---------------------------------------------------------------------------
check("10/11/12/13/19. move comp, footage and folder; to root; id unchanged", () => {
  const { ok, js } = load();
  js(`var A = mkFolder("A"), B = mkFolder("B"), c = mkComp("c"), ft = mkFootage("ft"), inner = mkComp("inner", A);`);
  let r = ok("move_project_item", { itemId: js("c.id"), folderId: js("A.id") });
  assert.deepEqual([r.previousParentFolderId, r.parentFolderId, r.changed], [0, js("A.id"), true]);
  r = ok("move_project_item", { itemId: js("ft.id"), folderId: js("B.id") });
  assert.equal(js("ft.parentFolder.id"), js("B.id"));
  r = ok("move_project_item", { itemId: js("A.id"), folderId: js("B.id") });
  assert.deepEqual(r.pathIds, [0, js("B.id")]);
  assert.equal(js("inner.parentFolder.id"), js("A.id"), "a moved folder keeps its contents");
  r = ok("move_project_item", { itemId: js("c.id"), folderId: 0 });
  assert.equal(r.parentFolderId, 0);
  assert.equal(r.itemId, js("c.id"));
  r = ok("move_project_item", { itemId: js("c.id"), folderId: 0 });
  assert.equal(r.changed, false);
});

check("14/15/16/17. invalid target, non-folder target, self move and descendant cycles are refused before any write", () => {
  const { refused, js, ok } = load();
  js(`var A = mkFolder("A"), B = mkFolder("B", A), C = mkFolder("C", B), cc = mkComp("cc");`);
  refused("move_project_item", { itemId: js("cc.id"), folderId: 999999 }, /No project item with id 999999/);
  refused("move_project_item", { itemId: js("A.id"), folderId: js("cc.id") }, /not a project folder/);
  refused("move_project_item", { itemId: js("B.id"), folderId: js("B.id") }, /cannot be moved into itself/);
  const msg = refused("move_project_item", { itemId: js("A.id"), folderId: js("C.id") }, /cycle/);
  assert.match(msg, new RegExp(`0 > ${js("A.id")} > ${js("B.id")} > ${js("C.id")}`));
  assert.doesNotMatch(msg, /After Effects error/, "our preflight, not AE's own throw");
  assert.deepEqual(ok("get_project_tree", {}).items.map((n) => [n.name, n.depth]), [["A", 1], ["B", 2], ["C", 3], ["cc", 1]]);
  ok("move_project_item", { itemId: js("C.id"), folderId: 0 });
  ok("move_project_item", { itemId: js("C.id"), folderId: js("A.id") });
  assert.equal(js("C.parentFolder.id"), js("A.id"));
});

// ---------------------------------------------------------------------------
// deletion analysis and delete
// ---------------------------------------------------------------------------
check("20. safe delete of an empty folder (an empty Solids folder) is verified gone", () => {
  const { ok, js } = load();
  js(`var S = mkFolder("Solids"), keep = mkComp("keep");`);
  const id = js("S.id");
  const r = ok("delete_project_item", { itemId: id });
  assert.equal(r.deleted, true);
  assert.equal(r.removedItemCount, 1);
  assert.deepEqual(r.verified.projectItems, { before: 2, after: 1 });
  assert.equal(js(`itemByIdOrNull(${id})`), null);
  assert.deepEqual(js("UNDO.slice(-2)"), ["begin:AE MCP: delete project item", "end"]);
});

check("safe delete of an unused comp and of unused footage", () => {
  const { ok, js } = load();
  js(`var c = mkComp("unused"), ft = mkFootage("unusedImg");`);
  ok("delete_project_item", { itemId: js("c.id") });
  ok("delete_project_item", { itemId: js("ft.id"), mode: "safe" });
  assert.equal(js("ALL.length"), 0);
});

check("21. a non-empty folder is refused in safe mode; contents intact", () => {
  const { refused, js } = load();
  js(`var F = mkFolder("F"), inside = mkComp("inside", F);`);
  const msg = refused("delete_project_item", { itemId: js("F.id") }, /not empty/);
  assert.match(msg, /recursive/);
  assert.equal(js("ALL.length"), 2);
});

check("22/25. referenced footage: analysis names the layer and comp; safe AND recursive delete refuse", () => {
  const { ok, refused, js } = load();
  js(`var img = mkFootage("plate"), comp = mkComp("Main"); var L = place(comp, img);`);
  const a = ok("analyze_project_item_deletion", { itemId: js("img.id") });
  assert.deepEqual(a.externalLayers, [{ compId: js("comp.id"), compName: "Main", layerId: js("L.id"), layerName: "plate", sourceItemId: js("img.id") }]);
  assert.deepEqual(a.externalComps, [{ id: js("comp.id"), name: "Main", layersRemoved: 1 }]);
  assert.deepEqual(a.totals, { projectItems: 1, externalLayers: 1, externalComps: 1, renderQueueItems: 0 });
  assert.equal(a.safe.allowed, false);
  assert.equal(a.recursive.allowed, false);
  assert.match(a.summary, /would remove 1 project item\(s\), 1 layer\(s\) in 1 other comp\(s\) and 0 Render Queue item\(s\)/);
  for (const mode of ["safe", "recursive"]) {
    const msg = refused("delete_project_item", { itemId: js("img.id"), mode }, /1 layer\(s\) in 1 other comp/);
    assert.match(msg, /Nothing was changed/);
  }
  assert.equal(js("comp.numLayers"), 1);
  assert.equal(js(`itemByIdOrNull(img.id) === img`), true);
});

check("23. referenced precomp is refused; both comps and the precomp layer remain", () => {
  const { ok, refused, js } = load();
  js(`var inner = mkComp("Inner"), outer = mkComp("Outer"); place(outer, inner);`);
  assert.equal(ok("analyze_project_item_deletion", { itemId: js("inner.id") }).totals.externalLayers, 1);
  refused("delete_project_item", { itemId: js("inner.id") }, /other comp/);
  assert.equal(js("outer.numLayers"), 1);
  assert.equal(js("ALL.length"), 2);
});

check("24. a queued comp is refused; the queue item remains", () => {
  const { ok, refused, js } = load();
  js(`var q = mkComp("Queued"); queue(q);`);
  const a = ok("analyze_project_item_deletion", { itemId: js("q.id") });
  assert.deepEqual(a.renderQueueItems, [{ position: 1, compId: js("q.id"), compName: "Queued", status: "QUEUED" }]);
  refused("delete_project_item", { itemId: js("q.id"), mode: "recursive" }, /Render Queue/);
  assert.equal(js("RQ.length"), 1);
});

check("recursive delete of a self-contained folder removes exactly the analyzed set", () => {
  const { ok, js } = load();
  js(`var T = mkFolder("Test"), sub = mkFolder("sub", T), img = mkFootage("img", sub), c = mkComp("uses img", T), outside = mkComp("outside");
      place(c, img); place(outside, mkSolid("s"));`);
  const a = ok("analyze_project_item_deletion", { itemId: js("T.id") });
  assert.equal(a.safe.allowed, false);
  assert.equal(a.recursive.allowed, true);
  assert.equal(a.totals.projectItems, 4);
  assert.equal(a.totals.externalLayers, 0, "a layer inside a comp that goes too is not external");
  assert.equal(a.layersInsideDeletedComps, 1);
  const r = ok("delete_project_item", { itemId: js("T.id"), mode: "recursive" });
  assert.equal(r.removedItemCount, 4);
  assert.deepEqual(r.verified.layersOutside, { before: 1, after: 1 });
  assert.deepEqual(js("ALL.map(function (x) { return x.name; }).sort()"), ["outside", "s"]);
});

check("recursive delete refuses a folder whose contents are used outside it", () => {
  const { refused, js } = load();
  js(`var T = mkFolder("Test"), img = mkFootage("img", T), out = mkComp("outside"); place(out, img);`);
  refused("delete_project_item", { itemId: js("T.id"), mode: "recursive" }, /outside what is being deleted/);
  assert.equal(js("out.numLayers"), 1);
  assert.equal(js("ALL.length"), 3);
});

check("a deletion that does not land as analyzed is reported, never ok:true", () => {
  const { run, js } = load();
  // A remove() that leaves the item behind.
  js(`var stuck = mkFolder("stuck"); stuck.remove = function () { WRITES++; };`);
  const r = run("delete_project_item", { itemId: js("stuck.id") });
  assert.equal(r.ok, false);
  assert.match(r.error, /still exist/);
});

check("27. duplicate names stay distinct: rename, move and delete act on one id only", () => {
  const { ok, js } = load();
  const f1 = ok("create_project_folder", { name: "Twin" }), f2 = ok("create_project_folder", { name: "Twin" });
  js(`var c1 = mkComp("Twin comp"), c2 = mkComp("Twin comp");`);
  ok("rename_project_item", { itemId: f1.itemId, name: "Twin renamed" });
  assert.equal(js(`app.project.itemByID(${f2.itemId}).name`), "Twin");
  ok("move_project_item", { itemId: js("c1.id"), folderId: f2.itemId });
  assert.equal(js("c2.parentFolder.id"), 0);
  ok("delete_project_item", { itemId: js("c2.id") });
  assert.equal(js("itemByIdOrNull(c1.id) === c1"), true);
  assert.equal(js("c1.parentFolder.id"), f2.itemId);
});

check("28. readback: a rename that does not stick is refused and restored", () => {
  const { run, js } = load();
  js(`var weird = mkFolder("orig"); Object.defineProperty(weird, "name", { get: function () { return "orig"; }, set: function () { WRITES++; } });`);
  const r = run("rename_project_item", { itemId: js("weird.id"), name: "wanted" });
  assert.equal(r.ok, false);
  assert.match(r.error, /reads back "orig", asked "wanted"/);
});

check("32. nothing here saves the project", () => {
  const src = read("project.jsx");
  assert.doesNotMatch(src, /\.save\s*\(|saveWithDialog|\.close\s*\(/);
});

// ---------------------------------------------------------------------------
// schemas, classification and run_batch
// ---------------------------------------------------------------------------
const shared = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "index.js")).href);
const { OpSchemas, OpMutation } = shared.schemas;
const { validateBatchOps, BatchValidationError } = await import(
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "tools", "batchSteps.js")).href
);
const NEW = ["get_project_tree", "create_project_folder", "rename_project_item", "move_project_item", "analyze_project_item_deletion", "delete_project_item"];

check("29. schemas are strict and refuse blank names, negative ids and unknown modes", () => {
  for (const op of NEW) assert.ok(OpSchemas[op], `${op} is registered`);
  assert.equal(OpSchemas.create_project_folder.safeParse({ name: "a", extra: 1 }).success, false);
  assert.equal(OpSchemas.create_project_folder.safeParse({ name: "" }).success, false);
  assert.equal(OpSchemas.create_project_folder.safeParse({ name: " \t" }).success, false);
  assert.equal(OpSchemas.rename_project_item.safeParse({ itemId: -1, name: "x" }).success, false);
  assert.equal(OpSchemas.move_project_item.safeParse({ itemId: 3 }).success, false, "folderId is required");
  assert.equal(OpSchemas.delete_project_item.safeParse({ itemId: 3, mode: "force" }).success, false);
  assert.deepEqual(OpSchemas.delete_project_item.parse({ itemId: 3 }), { itemId: 3, mode: "safe" });
  assert.deepEqual(OpSchemas.get_project_tree.parse({}), { folderId: 0, depth: 16, maxItems: 500 });
});

check("30. reads are reads and every mutation is a write", () => {
  assert.equal(OpMutation.get_project_tree, "read");
  assert.equal(OpMutation.analyze_project_item_deletion, "read");
  for (const op of ["create_project_folder", "rename_project_item", "move_project_item", "delete_project_item"]) assert.equal(OpMutation[op], "write");
  const src = read("project.jsx");
  assert.match(src, /OPS\.get_project_tree = noUndo\(/);
  assert.match(src, /OPS\.analyze_project_item_deletion = noUndo\(/);
});

check("31. run_batch validates project steps whole: a bad later step stops the batch before any is sent", () => {
  const steps = validateBatchOps([
    { op: "create_project_folder", args: { name: "A" } },
    { op: "get_project_tree", args: {} },
    { op: "delete_project_item", args: { itemId: 5 } },
  ]);
  assert.equal(steps.length, 3);
  assert.equal(steps[2].args.mode, "safe");
  assert.throws(
    () => validateBatchOps([
      { op: "create_project_folder", args: { name: "A" } },
      { op: "move_project_item", args: { itemId: 5 } },
    ]),
    (e) => e instanceof BatchValidationError && /step 1 \(move_project_item\)/.test(e.message) && e.problems.length === 1
  );
});

console.log(`project-hierarchy: ${passed} checks passed`);
