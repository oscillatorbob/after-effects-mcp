// Shared loader so the dev scripts reuse the same platform logic the
// check_setup / setup_panel tools use, instead of keeping a second, drifting
// copy of the CEP paths and the PlayerDebugMode handling.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distDir = path.join(root, "packages", "mcp-server", "dist", "setup");

// Dynamic import() resolves an absolute-path specifier as a URL, and a bare
// Windows path (`C:\...`) is not a valid one — pathToFileURL is what every
// test in tests/unit/ already uses for this same dist-loading pattern.
// Exported so tests/unit/dev-scripts-esm.mjs can check the conversion itself
// rather than only the dynamic import it feeds.
export function toImportUrl(absolutePath) {
  return pathToFileURL(absolutePath).href;
}

function importDist(name) {
  return import(toImportUrl(path.join(distDir, name)));
}

export async function loadSetup() {
  if (!fs.existsSync(path.join(distDir, "paths.js"))) {
    console.error("The TypeScript build is missing. Run `npm run build:ts` first.");
    process.exit(1);
  }
  const [paths, platform, install, check] = await Promise.all([
    importDist("paths.js"),
    importDist("platform.js"),
    importDist("install.js"),
    importDist("check.js"),
  ]);
  return { ...paths, ...platform, ...install, ...check };
}
