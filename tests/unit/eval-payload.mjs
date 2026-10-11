// How a request becomes the script CSInterface.evalScript runs.
//
// ExtendScript's native JSON.parse is quadratic on a large request (6.9 s for
// 98 KB on AE 26.5), so the panel now writes each request into the script as a
// data literal the compiler builds directly, and calls dispatchValue() with it.
// That is a request becoming *source code*, so the property this file guards
// is that it can only ever be data: whatever strings a caller sends, the
// script evaluates to exactly the value that was sent and runs nothing else.
//
// Checked here, against client/evalpayload.js and core.jsx:
//   - the literal is pure printable ASCII and strict JSON;
//   - adversarial strings arrive byte-for-byte, and no trap in the script's
//     scope is ever touched while it evaluates;
//   - the literal path never calls JSON.parse inside ExtendScript (the
//     structural form of the performance fix), the legacy path exactly once;
//   - "__proto__" keys and a bundle without dispatchValue take the JSON path;
//   - dispatch(json) and dispatchValue(obj) answer identically, errors included.
//
//   node tests/unit/eval-payload.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const evalPayload = require(path.join(root, "packages", "ae-panel", "client", "evalpayload.js"));
const core = fs.readFileSync(path.join(root, "packages", "jsx", "core.jsx"), "utf8");

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ---------------------------------------------------------------------------
// A stand-in for the ExtendScript global scope: core.jsx loaded, a JSON whose
// parse calls are counted, an echo op, and traps on everything an injected
// script would reach for. Any trap firing is a failure.
// ---------------------------------------------------------------------------
function makeHost() {
  const trips = [];
  const trap = (name) => function () { trips.push(name); return undefined; };
  const counts = { parse: 0 };
  const json = {
    parse: (s) => { counts.parse++; return JSON.parse(s); },
    stringify: (v) => JSON.stringify(v),
  };
  const ctx = {
    JSON: json,
    app: { beginUndoGroup() {}, endUndoGroup() {}, quit: trap("app.quit"), executeCommand: trap("app.executeCommand") },
    alert: trap("alert"),
    $: { evalFile: trap("$.evalFile"), sleep: trap("$.sleep") },
    File: trap("File"),
    system: { callSystem: trap("system.callSystem") },
    pwned: trap("pwned"),
  };
  vm.createContext(ctx);
  vm.runInContext(core, ctx, { filename: "core.jsx" });
  vm.runInContext(
    "OPS.echo = noUndo(function (args) { return args; });" +
    "OPS.boom = function (args) { throw new Error(args.message); };" +
    "OPS.soft = noUndo(function (args) { return { ok: false, reason: args.reason }; });",
    ctx,
  );
  // Never let a script reach the real eval/Function through the context.
  const run = (script) => {
    const raw = vm.runInContext(script, ctx, { filename: "evalScript" });
    return JSON.parse(raw);
  };
  return { ctx, run, trips, counts };
}

// ---------------------------------------------------------------------------
// The adversarial corpus. Every one of these must arrive as the same string.
// ---------------------------------------------------------------------------
const nasty = [
  `"`, `'`, `\\`, `\\\\server\\share\\file.aep`, `C:\\Users\\Johnny\\Desktop\\new folder\\x.png`,
  "line1\nline2", "cr\rcr", "tab\tbed", "\b\f\v\0",
  "unicode: déjà vu — ñ — 日本語 — Ελληνικά", "emoji: 🎬🎞️👩🏽‍💻", "\ud83d", "\udc00 lone low surrogate",
  "U+2028:\u2028:U+2029:\u2029:", "NEL:\u0085:", "BOM:\ufeff:", "\u007f del", "\u0001\u001f",
  "</script><script>pwned()</script>", "{}[](),;:", "]}){",
  `"); app.quit(); //`, `'); app.quit(); //`, `\\"); pwned(); //`, `"+pwned()+"`, `\\u0022); pwned(); //`,
  "eval('pwned()')", "Function('pwned()')()", "*/ pwned(); /*", "<!-- pwned() -->", "--> pwned()",
  "#include \"evil.jsx\"", "\n#target aftereffects\npwned()", "${pwned()}", "`${pwned()}`",
  "__proto__", "constructor", "toString", "x".repeat(200000),
];

const payloadOf = (args) => ({ op: "echo", args });

check("literal output is printable ASCII for every adversarial string", () => {
  for (const s of nasty) {
    const lit = evalPayload.toLiteral({ s });
    assert.ok(/^[\x20-\x7e]*$/.test(lit), `non-ASCII or control character in literal for ${JSON.stringify(s.slice(0, 40))}`);
  }
});

check("literal output is strict JSON that parses back to the same value", () => {
  for (const s of nasty) assert.deepEqual(JSON.parse(evalPayload.toLiteral({ s })), { s });
});

check("U+2028 / U+2029 never appear raw in a script", () => {
  const { script } = evalPayload.buildDispatchScript(payloadOf({ s: "a\u2028b\u2029c" }), true);
  assert.ok(!/[\u2028\u2029]/.test(script));
  assert.ok(script.includes("\\u2028") && script.includes("\\u2029"));
});

check("every adversarial string arrives as data through the literal path, and nothing runs", () => {
  const host = makeHost();
  for (const s of nasty) {
    const built = evalPayload.buildDispatchScript(payloadOf({ s, inArray: [s], nested: { deeper: { s } } }), true);
    assert.equal(built.mode, "literal");
    const out = host.run(built.script);
    assert.equal(out.ok, true, `op failed for ${JSON.stringify(s.slice(0, 40))}: ${out.error}`);
    assert.equal(out.result.s, s);
    assert.equal(out.result.inArray[0], s);
    assert.equal(out.result.nested.deeper.s, s);
  }
  assert.deepEqual(host.trips, [], `script reached ${host.trips.join(", ")}`);
});

check("every adversarial string arrives as data through the legacy JSON path, and nothing runs", () => {
  const host = makeHost();
  for (const s of nasty) {
    const built = evalPayload.buildDispatchScript(payloadOf({ s }), false);
    assert.equal(built.mode, "json");
    assert.equal(host.run(built.script).result.s, s);
  }
  assert.deepEqual(host.trips, []);
});

check("adversarial strings as object KEYS arrive as data too", () => {
  const host = makeHost();
  const args = {};
  for (const s of nasty.slice(0, -1)) if (s !== "__proto__") args[s] = s;
  const out = host.run(evalPayload.buildDispatchScript(payloadOf(args), true).script);
  assert.deepEqual(out.result, args);
  assert.deepEqual(host.trips, []);
});

check("null, booleans, numbers, empty containers and deep nesting round-trip exactly", () => {
  const host = makeHost();
  let deep = { leaf: [1, "two", null] };
  for (let i = 0; i < 60; i++) deep = { d: deep, a: [deep.leaf ?? i] };
  const args = {
    n: null, t: true, f: false, zero: 0, neg: -12.5, tiny: 5e-324, big: 1.7976931348623157e308,
    exp: 1e21, frac: 0.1 + 0.2, ints: [0, 1, -1, 2147483647, -2147483648, 9007199254740991],
    emptyObj: {}, emptyArr: [], arrOfEmpty: [[], {}, [[]]], deep,
  };
  const out = host.run(evalPayload.buildDispatchScript(payloadOf(args), true).script);
  assert.deepEqual(out.result, args);
});

check("undefined and non-finite values serialize as JSON.stringify would", () => {
  const host = makeHost();
  const out = host.run(evalPayload.buildDispatchScript(payloadOf({ u: undefined, nan: NaN, inf: Infinity, arr: [undefined] }), true).script);
  assert.deepEqual(out.result, { nan: null, inf: null, arr: [null] });
});

check("a 10,000-key set_keyframes-shaped request round-trips through the literal path", () => {
  const host = makeHost();
  const tracks = [];
  for (let t = 0; t < 6; t++) {
    const keys = [];
    for (let i = 0; i < 1667; i++) keys.push({ frame: i, value: [i * 0.5, 0 - i, 0], easeIn: [{ speed: 0, influence: 33.3 }], label: i % 16 });
    tracks.push({ layerId: t, path: ["ADBE Transform Group", "ADBE Position"], mode: "replace", keys });
  }
  const args = { compId: 1, tracks };
  const built = evalPayload.buildDispatchScript(payloadOf(args), true);
  assert.ok(built.bytes > 800000, `expected a request of ~0.85 MB, got ${built.bytes}`);
  assert.deepEqual(host.run(built.script).result, args);
});

// The performance fix, stated structurally rather than in milliseconds: on the
// literal path ExtendScript never runs JSON.parse over the request.
check("the literal path calls JSON.parse zero times inside ExtendScript; the legacy path once", () => {
  const host = makeHost();
  host.run(evalPayload.buildDispatchScript(payloadOf({ big: "x".repeat(50000) }), true).script);
  assert.equal(host.counts.parse, 0);
  host.run(evalPayload.buildDispatchScript(payloadOf({ big: "x".repeat(50000) }), false).script);
  assert.equal(host.counts.parse, 1);
});

check("a \"__proto__\" key is never sent as a literal, and arrives as an own property", () => {
  const host = makeHost();
  const payload = JSON.parse('{"op":"echo","args":{"__proto__":{"polluted":true},"x":1}}');
  const built = evalPayload.buildDispatchScript(payload, true);
  assert.equal(built.mode, "json");
  const out = host.run(built.script);
  assert.equal(out.result.x, 1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(out.result, "__proto__")?.value, { polluted: true });
  assert.equal(vm.runInContext("({}).polluted", host.ctx), undefined);
});

check("hasProtoKey sees a nested \"__proto__\" key but not a \"__proto__\" string value", () => {
  assert.equal(evalPayload.hasProtoKey(evalPayload.toLiteral(JSON.parse('{"a":[{"b":{"__proto__":1}}]}'))), true);
  assert.equal(evalPayload.hasProtoKey(evalPayload.toLiteral({ a: "__proto__", b: ["__proto__"], c: '"__proto__":' })), false);
});

check("a bundle without dispatchValue is sent the legacy dispatch(json) script", () => {
  const built = evalPayload.buildDispatchScript(payloadOf({ a: 1 }), false);
  assert.match(built.script, /^JSON\.stringify\(dispatch\("/);
  assert.equal(built.mode, "json");
});

check("the literal script is exactly JSON.stringify(dispatchValue(<literal>))", () => {
  const payload = payloadOf({ a: [1, "b"] });
  const built = evalPayload.buildDispatchScript(payload, true);
  assert.equal(built.script, "JSON.stringify(dispatchValue(" + JSON.stringify(payload) + "))");
});

// ---------------------------------------------------------------------------
// dispatch(json) and dispatchValue(obj) must be one dispatcher.
// ---------------------------------------------------------------------------
function both(payload) {
  const host = makeHost();
  return [true, false].map((lit) => host.run(evalPayload.buildDispatchScript(payload, lit).script));
}

check("unknown op answers the same through both paths", () => {
  const [a, b] = both({ op: "no_such_op", args: {} });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { ok: false, error: "Unknown op: no_such_op" });
});

check("a throwing handler round-trips its message — quotes, backslashes, Unicode — through both paths", () => {
  const message = `bad "path" C:\\Temp\\x — 日本 🎬 \u2028 '); app.quit(); //`;
  const [a, b] = both({ op: "boom", args: { message } });
  assert.equal(a.ok, false);
  assert.equal(a.error, message);
  assert.equal(b.error, message);
  assert.equal(typeof a.stack, "string");
});

check("a handler's own error object is a normal result through both paths", () => {
  const [a, b] = both({ op: "soft", args: { reason: `can't "do" that` } });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { ok: true, result: { ok: false, reason: `can't "do" that` } });
});

check("a large handler result comes back whole", () => {
  const big = Array.from({ length: 20000 }, (_, i) => ({ i, s: `k${i}` }));
  const [a] = both({ op: "echo", args: { big } });
  assert.deepEqual(a.result.big, big);
});

check("dispatch still reports unparseable JSON, and dispatchValue a non-object", () => {
  const host = makeHost();
  const bad = JSON.parse(vm.runInContext(`JSON.stringify(dispatch("{not json"))`, host.ctx));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^Bad payload JSON: /);
  for (const v of ["null", "5", '"str"']) {
    const r = JSON.parse(vm.runInContext(`JSON.stringify(dispatchValue(${v}))`, host.ctx));
    assert.deepEqual(r, { ok: false, error: "Bad payload: expected an object {op, args}" });
  }
});

// ---------------------------------------------------------------------------
// The panel builds every op script through this module and nowhere else.
// ---------------------------------------------------------------------------
check("main.js builds op scripts only through evalpayload and probes dispatchValue after a bundle load", () => {
  const main = fs.readFileSync(path.join(root, "packages", "ae-panel", "client", "main.js"), "utf8");
  assert.match(main, /evalPayload\.buildDispatchScript\(/);
  assert.doesNotMatch(main, /"JSON\.stringify\(dispatch\("\s*\+/, "main.js still concatenates a dispatch script by hand");
  assert.match(main, /typeof dispatchValue/);
});

console.log(`eval-payload: ${passed} checks passed`);
