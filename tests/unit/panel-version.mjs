// The panel-version decision table.
//
// Worth a test of its own because every branch is a different sentence said to
// a user, and three of the four are only reachable during an upgrade — which is
// exactly when nobody is running the manual verification recipes.
//
// `sourceBundleHash()` used to memoize its result for the life of the process —
// fine for a production install, wrong for development, where `npm run build`
// rewrites bundle.jsx while the long-lived `after-effects-dev` MCP server stays
// connected. Measured live: every check fell through to "the panel is out of
// date" even though the panel, the CEP install and the source bundle on disk
// all already agreed — only the server's cached memory of an earlier build
// disagreed, and nothing short of restarting the server process cleared it.
// The regression test below mutates a real file on disk and calls the loaded
// function again in the same process, which is the one thing re-importing the
// module between calls cannot prove.
//
//   node tests/unit/panel-version.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// pathToFileURL, not the bare path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unsupported URL scheme.
const { assessPanel, sourceBundleHash, unknownOpMessage } = await import(
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "setup", "panelVersion.js")).href
);

const SHIPPED = sourceBundleHash();
assert.ok(SHIPPED, "no source bundle hash — run `npm run build` first");
const OLD = "0".repeat(64);

let passed = 0;
function check(name, actual, expected) {
  assert.equal(actual, expected, `${name}: expected "${expected}", got "${actual}"`);
  passed++;
}

// Running the shipped bundle: forward, say nothing.
check("running current", assessPanel(SHIPPED, SHIPPED).state, "current");
check("running current, disk somehow older", assessPanel(SHIPPED, OLD).state, "current");

// Updated on disk, AE not restarted. The distinction that matters: telling
// someone to run setup_panel again here would waste their time.
const restart = assessPanel(OLD, SHIPPED);
check("updated but not restarted", restart.state, "restart-needed");
assert.match(restart.message, /quit and reopen/i);
assert.match(restart.message, /will not help/i, "must say re-running setup_panel is pointless");

// Never updated.
const update = assessPanel(OLD, OLD);
check("panel predates the server", update.state, "update-needed");
assert.match(update.message, /setup_panel/);
assert.match(update.message, /quit and reopen/i);

// A panel too old to report a hash. Not enforced — the message is advisory and
// the Unknown-op backstop is what actually catches it — but it must not be
// mistaken for a healthy panel.
for (const missing of [undefined, null, ""]) {
  check(`no hash (${JSON.stringify(missing)}), old disk`, assessPanel(missing, OLD).state, "unknown");
  // Disk already refreshed: a restart is the only remaining step, and we can say so.
  check(`no hash (${JSON.stringify(missing)}), fresh disk`, assessPanel(missing, SHIPPED).state, "restart-needed");
}

// A half-updated install. bundle.jsx on disk is current, so every branch above
// reasons its way to "restart-needed" — and a restart cannot fix files that were
// never written. This is the state that cost three restarts in issue #20, so it
// outranks the restart verdict rather than being a special case after it.
const partial = assessPanel(OLD, SHIPPED, { installComplete: false });
check("bundle current but install incomplete", partial.state, "partial-install");
assert.match(partial.message, /will not fix|not fix this/i, "must say a restart is not the remedy");
assert.match(partial.message, /quit after effects/i, "must say to close AE before reinstalling");
assert.match(partial.message, /setup_panel/, "must name the tool that reinstalls");
passed += 3;

// The same incomplete install, from a panel too old to report a hash.
check("no hash, install incomplete", assessPanel(undefined, SHIPPED, { installComplete: false }).state, "partial-install");
check("stale disk, install incomplete", assessPanel(OLD, OLD, { installComplete: false }).state, "partial-install");

// A complete install must be unaffected, whether stated explicitly or left out.
check("explicitly complete", assessPanel(OLD, SHIPPED, { installComplete: true }).state, "restart-needed");
check("unstated defaults to complete", assessPanel(OLD, SHIPPED, {}).state, "restart-needed");
// A running panel that already matches is current regardless — there is nothing
// to reinstall when the code answering calls is the code we ship.
check("running current beats an incomplete disk", assessPanel(SHIPPED, SHIPPED, { installComplete: false }).state, "current");

// Unknown-op is always a version mismatch: server.ts rejects unknown tool names
// before forwarding, so anything the panel rejects is an op this server defines.
const unknown = unknownOpMessage("get_house_style");
assert.match(unknown, /get_house_style/);
assert.match(unknown, /older than these tools/);
assert.match(unknown, /setup_panel/);
passed++;

// ---------------------------------------------------------------------------
// Regression: sourceBundleHash() must reflect a rebuild without a process
// restart. `bundlePath` is a test-only override — every real caller still
// resolves the path itself and gets this same, now-uncached, behaviour.
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-bundle-hash-"));
const tmpBundle = path.join(tmpDir, "bundle.jsx");

try {
  // 1. First call computes the current hash of whatever is on disk right now.
  fs.writeFileSync(tmpBundle, "// build A\nvar OPS = OPS || {};\n");
  const hashA1 = sourceBundleHash(tmpBundle);
  assert.ok(hashA1, "a real file must hash to something");
  passed++;

  // 2. A repeated call against an unchanged file returns the same value —
  // dropping the cache must not mean the hash becomes unstable or random.
  const hashA2 = sourceBundleHash(tmpBundle);
  check("unchanged bundle hashes identically on a second call", hashA2, hashA1);

  // 3 & 4. The critical case: mutate the file — simulating `npm run build`
  // rewriting bundle.jsx — while this same module instance, in this same
  // process, is still loaded. No re-import, no process restart. The very next
  // call must see the new content, which is exactly what stayed broken with
  // the old memoized version (it would have kept returning hashA1 forever).
  fs.writeFileSync(tmpBundle, "// build B — a real rebuild changed this file\nvar OPS = OPS || {};\n");
  const hashB = sourceBundleHash(tmpBundle);
  assert.notEqual(hashB, hashA1, "a rebuilt file in the same process must hash differently, with no restart");
  passed++;

  // assessPanel() only ever compares against sourceBundleHash()'s *default*
  // path (the real shipped bundle) — it has no path parameter of its own, and
  // adding one is out of scope here. What matters is that assessPanel calls
  // the now-uncached sourceBundleHash() internally, so the decision-table
  // block above — built on SHIPPED, itself fetched through this same
  // function — already exercises assessPanel against a freshly-read value on
  // every run of this file, not a value memoized from some earlier call.

  // 5. Missing-bundle behaviour is unchanged: a path that never existed hashes
  // to null, exactly as hashFile's try/catch always returned for the default
  // path resolution — this was never about the caching, only about I/O.
  const missingPath = path.join(tmpDir, "does-not-exist.jsx");
  check("a missing bundle still hashes to null", sourceBundleHash(missingPath), null);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 6. The default (no override) path still resolves and matches what the
// build actually produced — the decision table above already exercises every
// branch of assessPanel against it, so this just confirms the no-argument
// call path itself is untouched by adding the parameter.
check("sourceBundleHash() with no argument still resolves the real shipped bundle", sourceBundleHash(), SHIPPED);

console.log(`panel-version: ${passed} assertions passed`);
