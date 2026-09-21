// scripts/lib/setup.mjs's toImportUrl — the dev scripts (doctor, install-panel,
// uninstall-panel, enable-debug) all load the compiled setup/ dist modules
// through it before dynamic import() ever sees the path.
//
// Worth a dedicated test because the failure mode is Windows-only and CI's
// windows-latest runner is the only place that would ever catch a regression:
// passing an absolute Windows path (`C:\Users\...`) straight to import()
// throws ERR_UNSUPPORTED_ESM_URL_SCHEME, since import() resolves an
// absolute-path specifier as a URL and `C:` is not a valid URL scheme. A
// fixture path is used rather than any real machine's username so the test
// means the same thing on every runner.
//
//   node tests/unit/dev-scripts-esm.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { toImportUrl } = await import(
  pathToFileURL(path.join(root, "scripts", "lib", "setup.mjs")).href
);

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); passed++; };

// toImportUrl must always hand back something import() accepts: a valid URL
// whose protocol is "file:". Proven directly against the global URL parser
// rather than trusting the string shape.
function assertValidFileUrl(url, label) {
  let parsed;
  assert.doesNotThrow(() => { parsed = new URL(url); }, `${label}: not a valid URL: ${url}`);
  passed++;
  eq(parsed.protocol, "file:", `${label}: wrong protocol`);
}

// pathToFileURL/fileURLToPath are themselves platform-aware — a POSIX-style
// fixture does not round-trip on win32, and a Windows drive-letter fixture
// has no native meaning on POSIX — so each fixture is only asserted on the
// platform it is actually shaped for, the same split CI runs the whole suite
// under (macos-latest and windows-latest each catch their own half).
if (process.platform === "win32") {
  // The regression itself: a representative Windows drive-letter path, not
  // tied to any one machine's username.
  const winPath = "C:\\Users\\example-user\\Documents\\after-effects-mcp\\engine-room\\packages\\mcp-server\\dist\\setup\\paths.js";
  const url = toImportUrl(winPath);
  assertValidFileUrl(url, "drive-letter path");
  ok(url.startsWith("file:///C:/"), `drive-letter path lost its scheme: ${url}`);
  eq(fileURLToPath(url), winPath, "drive-letter path: round-trips back to the original path");

  // Spaces are common in this project's own real paths (issue class covered
  // by scripts/diagnose-spaces.mjs) and must survive as %20, not break the URL.
  const spacedPath = "C:\\Users\\example user\\My Projects\\engine-room\\packages\\mcp-server\\dist\\setup\\check.js";
  const spacedUrl = toImportUrl(spacedPath);
  assertValidFileUrl(spacedUrl, "path with spaces");
  ok(spacedUrl.includes("%20"), `space was not percent-encoded: ${spacedUrl}`);
  eq(fileURLToPath(spacedUrl), spacedPath, "path with spaces: round-trips back to the original path");
} else {
  // No regression for POSIX paths: toImportUrl is the same pathToFileURL()
  // call either way, so the macOS/Linux path this already worked on must
  // keep working. Same fixture shape as the Windows case above, minus the
  // drive letter, so the two branches read as one behaviour split by OS.
  const posixPath = "/Users/example-user/Documents/after-effects-mcp/engine-room/packages/mcp-server/dist/setup/install.js";
  const posixUrl = toImportUrl(posixPath);
  assertValidFileUrl(posixUrl, "posix path");
  eq(fileURLToPath(posixUrl), posixPath, "posix path: round-trips back to the original path");
}

// Dogfoods the actual production callsite: distDir/paths.js under this
// checkout's own root, in the running OS's native path format — proves the
// real scripts/lib/setup.mjs usage round-trips on whichever platform the
// suite is running on, no fixture involved.
const realPath = path.join(root, "packages", "mcp-server", "dist", "setup", "paths.js");
const realUrl = toImportUrl(realPath);
assertValidFileUrl(realUrl, "repo dist path");
eq(fileURLToPath(realUrl), realPath, "repo dist path: round-trips back to the original path");

console.log(`dev-scripts-esm: ${passed} assertions passed`);
