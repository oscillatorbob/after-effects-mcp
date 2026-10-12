// run_batch validates every step, whole, before any of it reaches After Effects.
//
// Until Phase A1 a batch step was `{op, args: unknown}` and its args went to
// the panel exactly as written — no defaults, no cross-field rules, no enum
// checks, and an unknown key was a field nobody read. The same call behaved
// differently made directly and made inside a batch, and the batch is the path
// every bulk build goes through. Worse, nothing in a batch rolls back, so an
// invalid step 50 found by After Effects left steps 0-49 applied.
//
// This drives the real MCP server over an in-memory transport against a stub
// bridge that records every /op it receives. "Nothing reached After Effects"
// is asserted as "the stub saw no /op", which is the property that matters.
//
//   node tests/unit/batch-validation.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));
const { validateBatchOps, parseOpArgs, BatchValidationError, NESTED_BATCH_INLINE_MAX } = await import(
  dist("tools", "batchSteps.js")
);
const { schemas } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "index.js")).href);

// ---------------------------------------------------------------------------
// Stub bridge — never 7777.
// ---------------------------------------------------------------------------
const posts = [];
const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = JSON.parse(body || "{}");
    posts.push(msg);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { ok: true, echoed: msg.op } }));
  });
});
new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
assert.notEqual(bridge.address().port, 7777);
process.env.AE_MCP_PORT = String(bridge.address().port);

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const server = createServer();
const client = new Client({ name: "batch-validation-test", version: "0" }, { capabilities: {} });
const [c, s] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(s), client.connect(c)]);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    throw e;
  }
}
const callRaw = (name, args) => client.callTool({ name, arguments: args });
const text = (res) => res.content.map((x) => x.text).join("\n");
const opPosts = () => posts.filter((p) => p.op);

const solid = (i) => ({ op: "create_solid_layer", args: { compId: 1, color: [1, 0, 0], name: `s${i}` } });

// ---------------------------------------------------------------------------
// The pure validator.
// ---------------------------------------------------------------------------

await check("unknown field in a step is refused, naming step and op", async () => {
  assert.throws(
    () => validateBatchOps([{ op: "set_layer", args: { compId: 1, layerId: 2, blendMode: "ADD" } }]),
    (e) => e instanceof BatchValidationError && /step 0 \(set_layer\)/.test(e.message) && /blendMode/.test(e.message)
  );
});

await check("an unknown key nested inside an object is refused too", async () => {
  assert.throws(
    () => validateBatchOps([{ op: "set_transform", args: { compId: 1, layerId: 2, properties: { opactiy: 50 } } }]),
    /opactiy/
  );
});

await check("missing required field is refused", async () => {
  assert.throws(() => validateBatchOps([{ op: "set_layer", args: { compId: 1 } }]), /step 0 \(set_layer\)[\s\S]*layerId/);
});

await check("invalid enum is refused", async () => {
  assert.throws(
    () => validateBatchOps([{ op: "set_layer", args: { compId: 1, layerId: 2, blendingMode: "TOTALLY_FAKE_MODE" } }]),
    /blendingMode/
  );
});

await check("cross-field rule is enforced inside a batch", async () => {
  assert.throws(
    () => validateBatchOps([{ op: "reorder_layer", args: { compId: 1, layerId: 2, toIndex: 1, beforeLayerId: 3 } }]),
    /exactly one of/
  );
});

await check("defaults are applied to batch steps exactly as to direct calls", async () => {
  const [light, mask, xf] = validateBatchOps([
    { op: "create_light_layer", args: { compId: 1 } },
    { op: "add_mask", args: { compId: 1, layerId: 2, vertices: [[0, 0], [1, 0], [1, 1]] } },
    { op: "set_transform", args: { compId: 1, layerId: 2, properties: { opacity: 10 } } },
  ]);
  // A bare `.default()` fills the field in.
  assert.equal(light.args.lightType, "point");
  assert.equal(light.args.oneNode, undefined);
  // And every step is exactly what a direct call parses to — including the
  // `.default(x).optional()` fields, which zod 3 leaves absent on both paths.
  assert.deepEqual(light.args, parseOpArgs("create_light_layer", { compId: 1 }));
  assert.deepEqual(mask.args, parseOpArgs("add_mask", { compId: 1, layerId: 2, vertices: [[0, 0], [1, 0], [1, 1]] }));
  assert.deepEqual(xf.args, parseOpArgs("set_transform", { compId: 1, layerId: 2, properties: { opacity: 10 } }));
});

await check("invalid op name, server-only ops and server-assembled ops are refused", async () => {
  assert.throws(() => validateBatchOps([{ op: "set_lyer", args: {} }]), /Unknown op "set_lyer"/);
  for (const op of ["await_job", "check_setup", "setup_panel", "log_issue", "ae_guide"]) {
    assert.throws(() => validateBatchOps([{ op, args: {} }]), /cannot run inside a batch/, op);
  }
  for (const op of ["snapshot_comp", "diff_comp"]) {
    assert.throws(() => validateBatchOps([{ op, args: { compId: 1, since: "x" } }]), /cannot run inside a batch/, op);
  }
  // Every server-classified op is refused, not just the ones named above.
  for (const [op, kind] of Object.entries(schemas.OpMutation)) {
    if (kind !== "server") continue;
    assert.throws(() => validateBatchOps([{ op, args: {} }]), /cannot run inside a batch/, op);
  }
});

await check("every invalid step is reported at once, by index", async () => {
  const ops = [solid(0), { op: "set_layer", args: { compId: 1 } }, solid(2), { op: "nope", args: {} }];
  try {
    validateBatchOps(ops);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof BatchValidationError);
    assert.deepEqual(e.problems.map((p) => p.index), [1, 3]);
    assert.match(e.message, /2 of 4 steps failed validation/);
    assert.match(e.message, /Nothing was sent to After Effects/);
  }
});

await check("nested batches are validated recursively, and an oversized one is refused", async () => {
  assert.throws(
    () => validateBatchOps([{ op: "run_batch", args: { ops: [solid(0), { op: "set_layer", args: { compId: 1 } }] } }]),
    /step 0\.1 \(set_layer\)/
  );
  const big = Array.from({ length: NESTED_BATCH_INLINE_MAX + 1 }, (_, i) => solid(i));
  assert.throws(() => validateBatchOps([{ op: "run_batch", args: { ops: big } }]), /nested run_batch/);
  // singleUndo keeps it inline, so it is allowed.
  validateBatchOps([{ op: "run_batch", args: { ops: big, singleUndo: true } }]);
});

await check("a run_jsx step gets scriptPath resolved like a direct call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-batch-"));
  const f = path.join(dir, "s.jsx");
  fs.writeFileSync(f, "return 7;");
  const [step] = validateBatchOps([{ op: "run_jsx", args: { scriptPath: f } }]);
  assert.equal(step.args.code, "return 7;");
  assert.throws(() => validateBatchOps([{ op: "run_jsx", args: { scriptPath: path.join(dir, "missing.jsx") } }]), /step 0 \(run_jsx\)/);
});

// ---------------------------------------------------------------------------
// Through the server: nothing is sent when any step is invalid.
// ---------------------------------------------------------------------------

await check("invalid step 50 prevents steps 0-49 from reaching After Effects", async () => {
  posts.length = 0;
  const ops = Array.from({ length: 50 }, (_, i) => solid(i));
  ops.push({ op: "set_layer", args: { compId: 1, layerId: 9, blendingMode: "TOTALLY_FAKE_MODE" } });
  const res = await callRaw("run_batch", { ops });
  assert.equal(res.isError, true);
  assert.match(text(res), /step 50 \(set_layer\)/);
  assert.equal(opPosts().length, 0, "nothing may reach the bridge");
});

await check("the same holds for a singleUndo batch and a chunked (>500) batch", async () => {
  for (const extra of [{ singleUndo: true }, {}]) {
    posts.length = 0;
    const ops = Array.from({ length: 600 }, (_, i) => solid(i));
    ops[599] = { op: "set_layer", args: { compId: 1, layerId: 9, typo: true } };
    const res = await callRaw("run_batch", { ops, ...extra });
    assert.equal(res.isError, true);
    assert.match(text(res), /step 599 \(set_layer\)/);
    assert.equal(opPosts().length, 0, `nothing may reach the bridge (${JSON.stringify(extra)})`);
  }
});

await check("a valid batch is forwarded with parsed, defaulted args and its flags unchanged", async () => {
  for (const transactional of [true, false]) {
    posts.length = 0;
    const res = await callRaw("run_batch", {
      transactional,
      ops: [
        { op: "create_light_layer", args: { compId: 1 } },
        { op: "set_layer", args: { compId: 1, layerId: 2, blendingMode: "SCREEN" } },
      ],
    });
    assert.notEqual(res.isError, true, text(res));
    const sent = opPosts();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].op, "run_batch");
    assert.equal(sent[0].args.transactional, transactional);
    assert.equal(sent[0].args.ops[0].args.lightType, "point", "the default must reach JSX");
    assert.equal(sent[0].args.ops[1].args.blendingMode, "SCREEN");
  }
});

await check("a chunked-size valid batch is forwarded whole", async () => {
  posts.length = 0;
  const ops = Array.from({ length: 600 }, (_, i) => solid(i));
  const res = await callRaw("run_batch", { ops });
  assert.notEqual(res.isError, true, text(res));
  assert.equal(opPosts()[0].args.ops.length, 600);
});

await check("direct calls refuse unknown keys too (parity)", async () => {
  posts.length = 0;
  const res = await callRaw("set_layer", { compId: 1, layerId: 2, blendMode: "ADD" });
  assert.equal(res.isError, true);
  assert.match(text(res), /blendMode/);
  assert.equal(opPosts().length, 0);
});

await check("create_shape_layer no longer accepts the fields it ignored", async () => {
  for (const k of ["shapes", "fill", "stroke", "strokeWidth"]) {
    assert.throws(() => parseOpArgs("create_shape_layer", { compId: 1, [k]: k === "shapes" ? [] : k === "strokeWidth" ? 2 : [1, 1, 1] }), new RegExp(k));
  }
  parseOpArgs("create_shape_layer", { compId: 1, position: "center" });
});

// ---------------------------------------------------------------------------
// Defaults that are actually applied — `.default(x).optional()` never was.
// ---------------------------------------------------------------------------

await check("no field anywhere in the registry wraps a default in .optional()", async () => {
  // The structural fact behind the behaviour below: zod 3's ZodOptional
  // returns undefined for an absent key without consulting the ZodDefault
  // inside it, so every such default was advertised and never applied.
  const found = [];
  const walk = (node, at) => {
    const def = node?._def;
    if (!def) return;
    if (def.typeName === "ZodOptional" && def.innerType?._def?.typeName === "ZodDefault") found.push(at);
    if (def.typeName === "ZodEffects") return walk(def.schema, at);
    if (["ZodOptional", "ZodDefault", "ZodNullable"].includes(def.typeName)) return walk(def.innerType, at);
    if (def.typeName === "ZodObject") for (const [k, v] of Object.entries(def.shape())) walk(v, `${at}.${k}`);
    if (def.typeName === "ZodArray") walk(def.type, `${at}[]`);
  };
  for (const [op, s] of Object.entries(schemas.OpSchemas)) walk(s, op);
  assert.deepEqual(found, []);
});

const DEFAULT_CASES = [
  ["add_mask", { compId: 1, layerId: 2, vertices: [[0, 0], [1, 0], [1, 1]] }, { mode: "ADD", closed: true }, { mode: "SUBTRACT", closed: false }],
  ["set_transform", { compId: 1, layerId: 2, properties: { opacity: 10 } }, { keyframe: false }, { keyframe: true, time: 1 }],
  ["duplicate_layer", { compId: 1, layerId: 2 }, { count: 1 }, { count: 3 }],
  ["parent_layer", { compId: 1, layerId: 2, parentLayerId: null }, { preserveTransform: true }, { preserveTransform: false }],
  ["create_text_layer", { compId: 1, text: "x" }, { anchorAlign: "left" }, { anchorAlign: "none" }],
  ["get_comp_tree", { compId: 1 }, { depth: 2 }, { depth: 5 }],
];

await check("direct calls deliver the defaulted value to After Effects, and explicit values win", async () => {
  for (const [op, args, defaults, explicit] of DEFAULT_CASES) {
    posts.length = 0;
    const d = await callRaw(op, args);
    assert.notEqual(d.isError, true, `${op}: ${text(d)}`);
    for (const [k, v] of Object.entries(defaults)) assert.deepEqual(opPosts()[0].args[k], v, `${op}.${k} default`);
    posts.length = 0;
    const e = await callRaw(op, { ...args, ...explicit });
    assert.notEqual(e.isError, true, `${op}: ${text(e)}`);
    for (const [k, v] of Object.entries(explicit)) assert.deepEqual(opPosts()[0].args[k], v, `${op}.${k} explicit`);
  }
});

await check("run_batch delivers exactly the args a direct call delivers", async () => {
  for (const [op, args, , explicit] of DEFAULT_CASES) {
    if (op === "get_comp_tree") continue; // a read; batching it is legal but pointless
    for (const a of [args, { ...args, ...explicit }]) {
      posts.length = 0;
      await callRaw(op, a);
      const direct = opPosts()[0].args;
      posts.length = 0;
      const b = await callRaw("run_batch", { ops: [{ op, args: a }] });
      assert.notEqual(b.isError, true, text(b));
      assert.deepEqual(opPosts()[0].args.ops[0].args, direct, `${op} batch vs direct`);
    }
  }
});

await check("the published schema still advertises the same defaults and still does not require them", async () => {
  const { toolInputSchema } = await import(dist("server.js"));
  for (const [op, , defaults] of DEFAULT_CASES) {
    const js = toolInputSchema(op);
    for (const [k, v] of Object.entries(defaults)) {
      assert.deepEqual(js.properties[k].default, v, `${op}.${k} default in the JSON Schema`);
      assert.ok(!(js.required ?? []).includes(k), `${op}.${k} must stay optional`);
    }
  }
});

// ---------------------------------------------------------------------------
// time and keyframe:true go together
// ---------------------------------------------------------------------------

const TIME_CASES = [
  ["set_transform", { compId: 1, layerId: 2, properties: { opacity: 10 } }],
  ["set_effect_param", { compId: 1, layerId: 2, effect: { effectIndex: 1, matchName: "ADBE Gaussian Blur 2" }, paramName: "Blurriness", value: 5 }],
  ["set_shape_property", { compId: 1, layerId: 2, contentPath: ["Contents", "Fill 1"], property: "Opacity", value: 50 }],
];

await check("time without keyframe:true, or keyframe:true without time, is refused directly with nothing sent", async () => {
  for (const [op, args] of TIME_CASES) {
    for (const bad of [{ time: 1 }, { time: 1, keyframe: false }, { keyframe: true }]) {
      posts.length = 0;
      const r = await callRaw(op, { ...args, ...bad });
      assert.equal(r.isError, true, `${op} ${JSON.stringify(bad)}`);
      assert.match(text(r), /go together/);
      assert.equal(opPosts().length, 0, `${op} ${JSON.stringify(bad)} reached the bridge`);
    }
    for (const good of [{}, { time: 1, keyframe: true }, { keyframe: false }]) {
      posts.length = 0;
      const r = await callRaw(op, { ...args, ...good });
      assert.notEqual(r.isError, true, `${op} ${JSON.stringify(good)}: ${text(r)}`);
      assert.equal(opPosts().length, 1);
    }
  }
});

await check("the same combinations inside a batch are refused before any step is sent", async () => {
  for (const [op, args] of TIME_CASES) {
    for (const bad of [{ time: 1 }, { keyframe: true }]) {
      posts.length = 0;
      const r = await callRaw("run_batch", { ops: [solid(0), { op, args: { ...args, ...bad } }] });
      assert.equal(r.isError, true);
      assert.match(text(r), new RegExp(`step 1 \\(${op}\\)`));
      assert.equal(opPosts().length, 0, "the solid in step 0 must not have been sent");
    }
  }
});

// ---------------------------------------------------------------------------
// Screenshots are direct-only
// ---------------------------------------------------------------------------

await check("screenshot ops are refused as batch steps, nested too, before anything is sent", async () => {
  for (const step of [
    { op: "screenshot_frame", args: { compId: 1 } },
    { op: "screenshot_frame", args: { compId: 1, times: [0, 1] } },
    { op: "screenshot_layer", args: { compId: 1, layerId: 2 } },
  ]) {
    posts.length = 0;
    const r = await callRaw("run_batch", { ops: [solid(0), step] });
    assert.equal(r.isError, true);
    assert.match(text(r), /cannot run inside a batch/);
    assert.match(text(r), new RegExp(`Call ${step.op} directly`));
    assert.equal(opPosts().length, 0);
    posts.length = 0;
    const n = await callRaw("run_batch", { ops: [{ op: "run_batch", args: { ops: [step] } }] });
    assert.equal(n.isError, true);
    assert.equal(opPosts().length, 0);
  }
});

await check("direct screenshot calls still reach the panel unchanged", async () => {
  posts.length = 0;
  await callRaw("screenshot_frame", { compId: 1, time: 0 });
  await callRaw("screenshot_layer", { compId: 1, layerId: 2 });
  assert.deepEqual(opPosts().map((p) => p.op), ["screenshot_frame", "screenshot_layer"]);
});

console.log(`batch-validation: ${passed} checks passed`);
// Settle before exiting — see write-queue-server.mjs (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
