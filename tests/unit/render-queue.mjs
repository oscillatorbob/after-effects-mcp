// get_render_queue / queue_comp — Phase 1 of Render Queue support: inspect
// and enqueue, never render.
//
// Three things measured live against a real disposable AE queue item (see
// packages/jsx/renderqueue.jsx's header and docs/fragile-areas-ae.md) are
// worth a dedicated mock rather than trust:
//
//   - RenderQueueItem has no `.id` and no working `.index`. The mock's queue
//     is a plain array, and `queueIndex` is only ever the caller's current
//     position in it — proven here by removing an earlier item and checking
//     that a later one's reported index actually shifts.
//   - `om.file = ...` silently rewrites the extension to match the active
//     output-module template. The mock reproduces exactly that, so a test
//     proving the response reports the rewritten extension — not an echo of
//     the request — is testing real behavior, not a fiction of the mock.
//   - `app.project.renderQueue` has no `.render()` in this mock and
//     `app.project` has no `.save()` — either one being called at all is a
//     ReferenceError that fails the suite immediately, which is the whole
//     point: Phase 1 must never render or save, and this is what makes that
//     provable rather than merely claimed.
//
//   node tests/unit/render-queue.mjs

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

    var RQItemStatus = {
      WILL_CONTINUE: 3012, NEEDS_OUTPUT: 3013, UNQUEUED: 3014, QUEUED: 3015,
      RENDERING: 3016, USER_STOPPED: 3017, ERR_STOPPED: 3018, DONE: 3019
    };

    var EXISTING_DIRS = {};
    function Folder(p) {
      this.fsName = p;
      Object.defineProperty(this, "exists", { get: function () { return !!EXISTING_DIRS[p]; } });
    }
    function File(p) { this.fsName = p; }

    var NEXT_ID = 1000;
    var ITEMS = [];
    function addItem(it) { ITEMS.push(it); return it; }
    function mkComp(name, opts) {
      var o = opts || {};
      var c = new CompItem();
      c.id = ++NEXT_ID; c.name = name;
      c.numLayers = o.numLayers === undefined ? 3 : o.numLayers;
      c.duration = o.duration === undefined ? 10 : o.duration;
      return addItem(c);
    }
    function mkFolder(name) {
      var f = new FolderItem();
      f.id = ++NEXT_ID; f.name = name;
      return addItem(f);
    }

    function mkOutputModule(name, activeExt) {
      var _file = null;
      var om = {
        name: name,
        throwOnSet: null,
        get file() { return _file; },
        set file(f) {
          if (om.throwOnSet) throw new Error(om.throwOnSet);
          var p = f.fsName;
          var dot = p.lastIndexOf(".");
          // Reproduces the measured behaviour: AE rewrites the extension to
          // match the active output-module template, regardless of request.
          _file = new File((dot >= 0 ? p.substring(0, dot) : p) + "." + activeExt);
        }
      };
      return om;
    }

    var QUEUE = [];
    function mkRQItem(comp, opts) {
      var o = opts || {};
      var om = mkOutputModule(o.omName || "H.264 - Match Render Settings", o.activeExt || "mp4");
      if (o.inheritedPath) om.file = new File(o.inheritedPath);
      var item = {
        comp: comp,
        status: o.status !== undefined ? o.status : RQItemStatus.QUEUED,
        render: o.render !== undefined ? o.render : true,
        timeSpanStart: 0,
        timeSpanDuration: comp ? comp.duration : 0,
        numOutputModules: 1,
        outputModule: function (i) { return om; },
        remove: function () {
          var idx = QUEUE.indexOf(item);
          if (idx >= 0) QUEUE.splice(idx, 1);
        }
      };
      return item;
    }

    var THROW_ON_ADD = null;
    var app = {
      project: {
        itemByID: function (id) {
          for (var i = 0; i < ITEMS.length; i++) { if (ITEMS[i].id === id) return ITEMS[i]; }
          return null;
        },
        renderQueue: {
          get numItems() { return QUEUE.length; },
          item: function (i) { return QUEUE[i - 1]; },
          items: {
            add: function (comp) {
              if (THROW_ON_ADD) throw new Error(THROW_ON_ADD);
              var item = mkRQItem(comp, ADD_OPTS);
              QUEUE.push(item);
              return item;
            }
          }
        }
      }
    };
    var ADD_OPTS = {};
    `,
    ctx,
  );
  for (const f of ["core.jsx", "ids.jsx", "renderqueue.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const get = (expr) => vm.runInContext(expr, ctx);
  const data = (expr) => JSON.parse(JSON.stringify(get(expr)));
  const call = (op, args) => JSON.parse(JSON.stringify(get("dispatch")(JSON.stringify({ op, args }))));
  const success = (r) => { assert.equal(r.ok, true, `expected success, got: ${r.error}`); return r.result; };
  const failure = (r) => { assert.equal(r.ok, false, `expected a failure, got: ${JSON.stringify(r.result)}`); return r.error; };
  return { ctx, get, data, call, success, failure };
}

// ---------------------------------------------------------------------------
// get_render_queue
// ---------------------------------------------------------------------------

// 1. empty queue
{
  const { call, success } = load();
  const r = success(call("get_render_queue", {}));
  eq(r.numItems, 0);
  eq(r.items, []);
}

// 2. one queued comp
{
  const { get, call, success } = load();
  get(`var c = mkComp("Comp A"); QUEUE.push(mkRQItem(c, {}));`);
  const r = success(call("get_render_queue", {}));
  eq(r.numItems, 1);
  eq(r.items[0].compId, get("c.id"));
  eq(r.items[0].compName, "Comp A");
  eq(r.items[0].queueIndex, 1);
}

// 3. multiple queued comps, index shifts after an earlier one is removed
{
  const { get, call, success } = load();
  get(`
    var c1 = mkComp("Comp A");
    var c2 = mkComp("Comp B");
    var c3 = mkComp("Comp C");
    var i1 = mkRQItem(c1, {}); QUEUE.push(i1);
    var i2 = mkRQItem(c2, {}); QUEUE.push(i2);
    var i3 = mkRQItem(c3, {}); QUEUE.push(i3);
  `);
  let r = success(call("get_render_queue", {}));
  eq(r.numItems, 3);
  eq(r.items.map((it) => it.compName), ["Comp A", "Comp B", "Comp C"]);
  eq(r.items.map((it) => it.queueIndex), [1, 2, 3]);

  get(`i1.remove();`);
  r = success(call("get_render_queue", {}));
  eq(r.numItems, 2, "removing the first item drops the count");
  eq(r.items.map((it) => it.compName), ["Comp B", "Comp C"], "the remaining items keep their relative order");
  eq(r.items.map((it) => it.queueIndex), [1, 2], "queueIndex is current position, not a persistent id — it shifted");
}

// 4 & 6. output-module file path and multiple output modules serialized
{
  const { get, call, success } = load();
  get(`
    var c = mkComp("Comp A");
    var item = mkRQItem(c, { inheritedPath: "C:\\\\out\\\\old-project\\\\render.mp4" });
    QUEUE.push(item);
  `);
  const r = success(call("get_render_queue", {}));
  const om = r.items[0].outputs[0];
  eq(om.outputModuleIndex, 1);
  eq(om.filePath, "C:\\out\\old-project\\render.mp4");
  eq(om.fileName, "render.mp4");
  eq(om.extension, "mp4");
  eq(om.hasOutputPath, true);
  eq(r.items[0].numOutputModules, 1);
}

// 5. render flag / status serialized, using every measured enum value
{
  const { get, call, success } = load();
  get(`
    var c = mkComp("Comp A");
    QUEUE.push(mkRQItem(c, { status: RQItemStatus.NEEDS_OUTPUT, render: false }));
  `);
  const r = success(call("get_render_queue", {}));
  eq(r.items[0].render, false);
  eq(r.items[0].statusCode, get("RQItemStatus.NEEDS_OUTPUT"));
  eq(r.items[0].status, "NEEDS_OUTPUT", "the numeric code is translated to After Effects' own enum name");
}

// 7. tool classified read-only (schema half, below, checks OpMutation directly too)

// ---------------------------------------------------------------------------
// queue_comp
// ---------------------------------------------------------------------------

// 8, 9, 10. valid comp added exactly once, correct id/name, count +1
{
  const { get, call, success } = load();
  get(`var c = mkComp("MCP Test");`);
  const compId = get("c.id");
  const before = get("QUEUE.length");
  const r = success(call("queue_comp", { compId }));
  eq(get("QUEUE.length"), before + 1, "queue count incremented by exactly one");
  eq(r.compId, compId);
  eq(r.compName, "MCP Test");
}

// 11 & 12. outputPath applied to Output Module 1; a Windows path with spaces
// survives, and the READBACK (not an echo) is what is returned.
{
  const { get, call, success } = load();
  get(`
    var c = mkComp("MCP Test");
    EXISTING_DIRS["C:\\\\Users\\\\Johnny\\\\My Renders"] = true;
  `);
  const compId = get("c.id");
  const r = success(call("queue_comp", { compId, outputPath: "C:\\Users\\Johnny\\My Renders\\preview.mov" }));
  eq(
    r.outputs[0].filePath,
    "C:\\Users\\Johnny\\My Renders\\preview.mp4",
    "the response reports AE's readback (extension rewritten to the active template), not the requested path verbatim — proving this is not merely echoed",
  );
  eq(r.outputs[0].fileName, "preview.mp4");
  ok(r.outputs[0].filePath.indexOf("My Renders") >= 0, "a Windows path containing spaces survives untouched");
}

// 13. existing queue items untouched by adding a new one
{
  const { get, call, success } = load();
  get(`
    var existing = mkComp("Existing Comp");
    QUEUE.push(mkRQItem(existing, { status: RQItemStatus.DONE }));
    var newComp = mkComp("New Comp");
  `);
  const newCompId = get("newComp.id");
  success(call("queue_comp", { compId: newCompId }));
  eq(get("QUEUE.length"), 2);
  eq(get("QUEUE[0].comp.name"), "Existing Comp", "the pre-existing item is untouched");
  eq(get("QUEUE[0].status"), get("RQItemStatus.DONE"), "its status is untouched too");
}

// 14. same comp may be queued twice — no deduplication
{
  const { get, call, success } = load();
  get(`var c = mkComp("MCP Test");`);
  const compId = get("c.id");
  const r1 = success(call("queue_comp", { compId }));
  const r2 = success(call("queue_comp", { compId }));
  eq(get("QUEUE.length"), 2, "two separate queue items, not deduplicated");
  eq(r1.compId, r2.compId, "both reference the same comp");
  ok(r1.queueIndex !== r2.queueIndex, "each gets its own queue position");
  eq(r1.queueIndex, 1);
  eq(r2.queueIndex, 2);
}

// 15. nonexistent comp rejected
{
  const { call, failure } = load();
  const err = failure(call("queue_comp", { compId: 999999 }));
  assert.match(err, /No project item with id 999999/);
  passed++;
}

// 15b. Measured live against real AE 2026: itemByID does not return null for
// a missing id at all — it throws its own cryptic internal error ("internal
// verification failure, sorry! {Item Not Found}") for every id tried. The
// handler must normalize that into the same friendly message, not let the
// raw AE error reach the caller, and still queue nothing.
{
  const { get, call, failure } = load();
  get(`
    app.project.itemByID = function (id) {
      throw new Error("After Effects error: internal verification failure, sorry! {Item Not Found}");
    };
  `);
  const before = get("QUEUE.length");
  const err = failure(call("queue_comp", { compId: 42 }));
  assert.match(err, /No project item with id 42/, "the raw AE throw is normalized to the same friendly message as a null return");
  passed++;
  eq(get("QUEUE.length"), before, "nothing was queued");
}

// 16. non-comp project item rejected
{
  const { get, call, failure } = load();
  get(`var f = mkFolder("Assets");`);
  const folderId = get("f.id");
  const before = get("QUEUE.length");
  const err = failure(call("queue_comp", { compId: folderId }));
  assert.match(err, /is not a comp/);
  passed++;
  eq(get("QUEUE.length"), before, "a rejected target never reaches the queue");
}

// 17. bad output path rejected — nonexistent parent directory, before any queue mutation
{
  const { get, call, failure } = load();
  get(`var c = mkComp("MCP Test");`);
  const compId = get("c.id");
  const before = get("QUEUE.length");
  const err = failure(call("queue_comp", { compId, outputPath: "C:\\does\\not\\exist\\out.mov" }));
  assert.match(err, /parent directory does not exist/);
  passed++;
  eq(get("QUEUE.length"), before, "the parent-directory check runs before items.add(), so nothing was queued at all");
}

// 18. failure to set the output file does not silently report success, and
// leaves no half-configured item behind
{
  const { get, call, failure } = load();
  get(`
    var c = mkComp("MCP Test");
    EXISTING_DIRS["C:\\\\ok"] = true;
    ADD_OPTS = {};
  `);
  const compId = get("c.id");
  const before = get("QUEUE.length");
  // Simulate AE refusing the output-module assignment after the item already exists.
  get(`
    var _realAdd = app.project.renderQueue.items.add;
    app.project.renderQueue.items.add = function (comp) {
      var item = _realAdd(comp);
      item.outputModule(1).throwOnSet = "Output module refused this file";
      return item;
    };
  `);
  const err = failure(call("queue_comp", { compId, outputPath: "C:\\ok\\out.mov" }));
  assert.match(err, /Output module refused this file/, "the original AE error reaches the caller, not a generic failure");
  passed++;
  eq(get("QUEUE.length"), before, "the queue item created just before the failure was removed again — no half-configured item survives");
}

// 19. tool classified write; 20. never invokes render() or renderQueue.render()
// covered structurally: the mocks above define no `.render()` method on
// renderQueue at all (only the per-item boolean flag `.render`), and no
// `app.project.save`. Either being called would throw ReferenceError/TypeError
// and fail the suite — which none of the above did.
{
  const { get } = load();
  ok(typeof get("app.project.renderQueue.render") === "undefined", "the mock renderQueue has no render() to call — nothing here could have called it");
  ok(typeof get("app.project.save") === "undefined", "the mock project has no save() — nothing here could have called it either");
}

// ---------------------------------------------------------------------------
// The schema half
// ---------------------------------------------------------------------------
const sharedDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;
const { OpSchemas, OpMutation } = await import(sharedDist("schemas.js"));

{
  const GetRenderQueue = OpSchemas.get_render_queue;
  ok(GetRenderQueue, "get_render_queue is registered in OpSchemas");
  ok(GetRenderQueue.safeParse({}).success, "an empty object parses");
  eq(GetRenderQueue.safeParse({ compId: 1 }).success, false, "the schema is strict — no input is accepted");

  const QueueComp = OpSchemas.queue_comp;
  ok(QueueComp, "queue_comp is registered in OpSchemas");
  ok(QueueComp.safeParse({ compId: 1 }).success, "compId alone parses");
  ok(QueueComp.safeParse({ compId: 1, outputPath: "C:\\out\\file.mov" }).success, "compId with outputPath parses");
  eq(QueueComp.safeParse({}).success, false, "compId is required");
  eq(QueueComp.safeParse({ compId: 1, outputPath: "" }).success, false, "an empty outputPath must be refused");
  eq(QueueComp.safeParse({ compId: 1, extra: true }).success, false, "the schema is strict");
}

eq(OpMutation.get_render_queue, "read", "get_render_queue is classified as a read");
eq(OpMutation.queue_comp, "write", "queue_comp is classified as a write, so it serializes behind other writes");

console.log(`render-queue: ${passed} assertions passed`);
