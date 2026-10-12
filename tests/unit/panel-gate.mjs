// The panel-version gate's cache, and its agreement with check_setup.
//
// panel-version.mjs covers assessPanel — what a /health answer means. This
// covers how long the gate remembers that meaning, which is where C4 found the
// bug: After Effects was restarted onto the current panel, came back on the same
// port, check_setup reported panelRunningCurrent passing — and every op was
// still refused as "still running the previous version", because the stale
// verdict was cached for the life of the process. Only setup_panel cleared it.
//
// Part 1 drives createPanelGate directly with a fake bridge and a fake clock.
// Part 2 drives the real server over an in-memory transport against a stub
// bridge on an ephemeral port whose bundleHash the test switches, so the
// restart-on-the-same-port case is exactly what the server meets.
//
//   node tests/unit/panel-gate.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));
const CURRENT = sourceBundleHash();
assert.ok(CURRENT, "the checkout must have a built bundle.jsx (npm run build:jsx)");
const STALE = "0".repeat(64);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`FAIL: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// Part 1 — the gate alone
// ---------------------------------------------------------------------------

const { createPanelGate } = await import(dist("server.js"));

function fakeBridge(hash) {
  const b = {
    hash,
    healthCalls: 0,
    unreachable: false,
    listeners: [],
    async health() {
      b.healthCalls++;
      if (b.unreachable) throw new Error("fetch failed");
      return { ok: true, port: 1, bundleLoaded: true, bundleHash: b.hash };
    },
    onPortChange(fn) {
      b.listeners.push(fn);
    },
    movePort() {
      for (const fn of b.listeners) fn(2, 1);
    },
  };
  return b;
}
function fakeClock() {
  const c = { t: 1_000_000, now: () => c.t };
  return c;
}

await check("1-2. a stale panel is refused, and the verdict is cached", async () => {
  const b = fakeBridge(STALE);
  const clock = fakeClock();
  const gate = createPanelGate(b, { recheckMs: 60_000, staleRecheckMs: 5_000, now: clock.now });
  assert.ok(await gate.check(), "a stale panel must be refused");
  assert.equal(b.healthCalls, 1);
  clock.t += 4_999;
  assert.ok(await gate.check(), "still refused inside the stale window");
  assert.equal(b.healthCalls, 1, "inside the window the cached verdict is served, /health is not asked");
});

await check("3-4. the panel becomes current on the SAME port: the gate recovers by itself", async () => {
  const b = fakeBridge(STALE);
  const clock = fakeClock();
  const gate = createPanelGate(b, { recheckMs: 60_000, staleRecheckMs: 5_000, now: clock.now });
  assert.ok(await gate.check());
  b.hash = CURRENT; // AE restarted onto the current panel; no port change fires
  clock.t += 5_000;
  assert.equal(await gate.check(), null, "after the stale window the gate must ask again and let the op through");
  assert.equal(b.healthCalls, 2);
});

await check("5. a genuinely stale panel is still refused after every re-check", async () => {
  const b = fakeBridge(STALE);
  const clock = fakeClock();
  const gate = createPanelGate(b, { recheckMs: 60_000, staleRecheckMs: 5_000, now: clock.now });
  for (let i = 0; i < 4; i++) {
    assert.match(String(await gate.check()), /panel/i, `re-check ${i} let a stale panel through`);
    clock.t += 5_000;
  }
  assert.equal(b.healthCalls, 4, "one /health per stale window, not one per call");
});

await check("6. a healthy verdict is still cached for the long interval, then re-checked", async () => {
  const b = fakeBridge(CURRENT);
  const clock = fakeClock();
  const gate = createPanelGate(b, { recheckMs: 60_000, staleRecheckMs: 5_000, now: clock.now });
  assert.equal(await gate.check(), null);
  for (let i = 0; i < 20; i++) {
    clock.t += 2_000;
    if (clock.t - 1_000_000 >= 60_000) break;
    assert.equal(await gate.check(), null);
  }
  assert.equal(b.healthCalls, 1, "a healthy verdict must not re-ask /health inside its window");
  // A panel replaced mid-session is noticed once the healthy window lapses.
  b.hash = STALE;
  clock.t = 1_000_000 + 60_000;
  assert.ok(await gate.check(), "a panel that went stale must be noticed after the healthy window");
  assert.equal(b.healthCalls, 2);
});

await check("7. a port change drops either verdict at once", async () => {
  const b = fakeBridge(STALE);
  const clock = fakeClock();
  const gate = createPanelGate(b, { recheckMs: 60_000, staleRecheckMs: 3_600_000, now: clock.now });
  assert.ok(await gate.check());
  b.hash = CURRENT;
  b.movePort();
  assert.equal(await gate.check(), null, "the panel on the new port must be asked, not the old verdict served");
  // …and the other way round: a healthy verdict does not survive a move either.
  b.hash = STALE;
  b.movePort();
  assert.ok(await gate.check());
});

await check("8. invalidate() (what setup_panel and check_setup call) drops a stale verdict at once", async () => {
  const b = fakeBridge(STALE);
  const clock = fakeClock();
  const gate = createPanelGate(b, { recheckMs: 60_000, staleRecheckMs: 3_600_000, now: clock.now });
  assert.ok(await gate.check());
  b.hash = CURRENT;
  assert.ok(await gate.check(), "precondition: inside the window the stale verdict stands");
  gate.invalidate();
  assert.equal(await gate.check(), null);
});

await check("an unreachable bridge lets the op through to report itself, and drops the stale verdict", async () => {
  const b = fakeBridge(STALE);
  const clock = fakeClock();
  const gate = createPanelGate(b, { recheckMs: 60_000, staleRecheckMs: 5_000, now: clock.now });
  assert.ok(await gate.check());
  b.unreachable = true; // AE quit
  clock.t += 5_000;
  assert.equal(await gate.check(), null, "runOp reports unreachable better than this gate can");
  b.unreachable = false;
  b.hash = CURRENT; // and came back current
  assert.equal(await gate.check(), null, "nothing stale may be remembered across the outage");
});

// ---------------------------------------------------------------------------
// Part 2 — through tools/call, against a stub bridge
// ---------------------------------------------------------------------------

const stub = { hash: STALE, ops: [] };
const bridgeServer = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: stub.hash, auth: false }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { op } = JSON.parse(body || "{}");
    stub.ops.push(op);
    res.end(JSON.stringify({ ok: true, result: [{ id: 7, name: "stub comp" }] }));
  });
});
const wss = new WebSocketServer({ server: bridgeServer, path: "/events" });
await new Promise((r) => bridgeServer.listen(0, "127.0.0.1", r));
const port = bridgeServer.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

async function connect(panelGate) {
  const server = createServer({ panelGate });
  const client = new Client({ name: "panel-gate-test", version: "0" }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { server, client };
}
const text = (res) => res.content.map((c) => c.text ?? "").join("\n");
const isStaleRefusal = (res) => res.isError && /previous version|out of date|mix of two versions/i.test(text(res));

await check("C4 reproduction: check_setup proves the panel current, so the next op goes through", async () => {
  // A stale window far longer than the test, so only check_setup can be what
  // clears it — this is the disagreement C4 met, minus the setup_panel escape.
  const { client, server } = await connect({ staleRecheckMs: 3_600_000 });
  stub.hash = STALE;
  stub.ops.length = 0;
  const refused = await client.callTool({ name: "list_comps", arguments: {} });
  assert.ok(isStaleRefusal(refused), `expected the stale refusal, got: ${text(refused)}`);
  assert.deepEqual(stub.ops, [], "a refused op must never reach the bridge");

  stub.hash = CURRENT; // AE restarted onto the current panel, same port
  const still = await client.callTool({ name: "list_comps", arguments: {} });
  assert.ok(isStaleRefusal(still), "precondition: the cached stale verdict is still being served");

  const setup = JSON.parse(text(await client.callTool({ name: "check_setup", arguments: {} })));
  const running = setup.checks.find((c) => c.name === "panelRunningCurrent");
  assert.equal(running?.ok, true, `check_setup must see the current panel: ${JSON.stringify(running)}`);

  const after = await client.callTool({ name: "list_comps", arguments: {} });
  assert.equal(after.isError, undefined, `check_setup said current, the gate still refused: ${text(after)}`);
  assert.deepEqual(stub.ops, ["list_comps"]);
  await server.close();
});

await check("C4 reproduction: with no check_setup and no setup_panel, the next op eventually succeeds", async () => {
  const { client, server } = await connect({ staleRecheckMs: 150 });
  stub.hash = STALE;
  stub.ops.length = 0;
  assert.ok(isStaleRefusal(await client.callTool({ name: "list_comps", arguments: {} })));
  stub.hash = CURRENT;
  await new Promise((r) => setTimeout(r, 200));
  const after = await client.callTool({ name: "list_comps", arguments: {} });
  assert.equal(after.isError, undefined, `the stale verdict outlived its window: ${text(after)}`);
  assert.deepEqual(stub.ops, ["list_comps"]);
  await server.close();
});

await check("a genuinely stale panel is still refused through tools/call, check_setup or not", async () => {
  const { client, server } = await connect({ staleRecheckMs: 100 });
  stub.hash = STALE;
  stub.ops.length = 0;
  assert.ok(isStaleRefusal(await client.callTool({ name: "list_comps", arguments: {} })));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(isStaleRefusal(await client.callTool({ name: "list_comps", arguments: {} })), "re-check let a stale panel through");
  const setup = JSON.parse(text(await client.callTool({ name: "check_setup", arguments: {} })));
  assert.equal(setup.checks.find((c) => c.name === "panelRunningCurrent")?.ok, false);
  assert.ok(isStaleRefusal(await client.callTool({ name: "list_comps", arguments: {} })), "check_setup must not open the gate for a stale panel");
  assert.deepEqual(stub.ops, [], "nothing may reach a stale panel");
  await server.close();
});

await check("9. unrelated behaviour: a current panel's op result is untouched, server-side tools ignore the gate", async () => {
  const { client, server } = await connect({});
  stub.hash = CURRENT;
  stub.ops.length = 0;
  const res = await client.callTool({ name: "list_comps", arguments: {} });
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(text(res)), [{ id: 7, name: "stub comp" }]);
  // While stale, a tool that never reaches After Effects still answers.
  stub.hash = STALE;
  const { client: c2, server: s2 } = await connect({});
  const guide = await c2.callTool({ name: "ae_guide", arguments: { topic: "after-effects" } });
  assert.equal(guide.isError, undefined, `ae_guide was gated: ${text(guide)}`);
  await server.close();
  await s2.close();
});

wss.close();
bridgeServer.close();
console.log(`panel-gate: ${passed} checks passed`);
process.exit(0);
