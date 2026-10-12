// save_project / save_project_as against a mock After Effects and file system.
//
// What the mock reproduces is what recipe 68 measured on 26.5x89:
// `app.project.save(file)` answers a boolean; a missing folder and a read-only
// file come back `false` with nothing written and nothing thrown; an existing
// file is replaced without any prompt; AE writes `<name>.<n>.<n>.aep` and renames
// it into place. What the live run could not produce on demand — a save that
// throws half way, one that claims success and writes nothing, one that leaves
// the project pointing somewhere else — is driven here, because those are the
// cases where an honest error matters most.
//
// What this locks in:
//   - Every refusal (unsaved, relative path, no .aep, missing folder, existing
//     file without overwrite — the current file included — read-only) happens
//     before `save` is called, and leaves the disk exactly as it was.
//   - overwrite:true is what replaces a file, and the result says it did.
//   - Success is proven by the project's path, `dirty` and a non-empty file,
//     never by AE's boolean alone, and never by a timestamp.
//   - A failure says what is now on disk and where the project points, names
//     any temp file AE left, and removes nothing.
//   - Dialogs are suppressed for the save and always restored, throw or not.
//
//   node tests/unit/save-project.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(root, "packages", "jsx", "save.jsx"), "utf8");

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (e) { console.error(`save-project FAILED: ${name}`); throw e; }
  passed++;
}

// ---------- the mock file system ----------

/** path -> { bytes, modified, readonly } */
let FILES;
/** existing folders */
let DIRS;
let LOG;
let CLOCK;

function dirnameOf(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i < 0) return ".";
  if (i === 0) return s.charAt(0);
  return s.substring(0, i);
}
function basenameOf(p) {
  const s = String(p);
  return s.substring(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1);
}
// The volume is case-insensitive, like the default on Windows and macOS.
const key = (p) => String(p).toLowerCase();
function lookup(p) {
  for (const [k, v] of FILES) if (key(k) === key(p)) return [k, v];
  return null;
}

class MockFile {
  constructor(p) { this.path = String(p); }
  get fsName() { return this.path; }
  get name() { return basenameOf(this.path); }
  get exists() { return !!lookup(this.path); }
  get length() { const hit = lookup(this.path); return hit ? hit[1].bytes : -1; }
  get modified() { const hit = lookup(this.path); return hit ? new Date(hit[1].modified) : null; }
  get readonly() { const hit = lookup(this.path); return hit ? !!hit[1].readonly : false; }
  get parent() { return new MockFolder(dirnameOf(this.path)); }
}
class MockFolder {
  constructor(p) { this.path = String(p); }
  get fsName() { return this.path; }
  get exists() { return DIRS.has(key(this.path)); }
  getFiles(mask) {
    // Only the shape save.jsx asks for: "<base>.*.aep".
    const star = mask.indexOf("*");
    const pre = key(mask.substring(0, star)), post = key(mask.substring(star + 1));
    const out = [];
    for (const k of FILES.keys()) {
      if (key(dirnameOf(k)) !== key(this.path)) continue;
      const b = key(basenameOf(k));
      if (b.startsWith(pre) && b.endsWith(post) && b.length >= pre.length + post.length) out.push(new MockFile(k));
    }
    return out;
  }
}

// ---------- the mock After Effects ----------

/**
 * @param opts.current   the project's current .aep path, or null for unsaved
 * @param opts.save      how app.project.save behaves:
 *   "measured" — AE as measured: false for a missing folder or a read-only
 *                file, otherwise writes the file and repoints the project
 *   "false"    — returns false, writes nothing
 *   "liar"     — returns true, writes nothing, changes nothing
 *   "throws"   — writes a temp file beside the target, then throws
 *   "replaceThenFalse" — rewrites the target, then returns false
 *   "wrongPath" — writes the file but leaves the project pointing elsewhere
 */
function makeContext(opts) {
  FILES = new Map();
  DIRS = new Set(["/", "/proj", "/other", "c:"].map(key));
  LOG = [];
  CLOCK = 1_700_000_000_000;
  for (const [p, f] of Object.entries(opts.files || {})) FILES.set(p, { modified: CLOCK - 60_000, readonly: false, ...f });
  let current = opts.current === undefined ? "/proj/show.aep" : opts.current;
  let dirty = true;
  const mode = opts.save || "measured";

  const project = {
    get file() { return current === null ? null : new MockFile(current); },
    get dirty() {
      if (opts.dirty === "throws") throw new Error("dirty is not available");
      if (opts.dirty === "missing") return undefined;
      if (opts.dirty === "string") return "no";
      return dirty;
    },
    save(file) {
      const target = file ? file.fsName : current;
      LOG.push("save:" + target);
      CLOCK += 1000;
      const write = () => {
        const hit = lookup(target);
        FILES.set(hit ? hit[0] : target, { bytes: 64000 + LOG.length, modified: CLOCK, readonly: false });
      };
      if (mode === "false") return false;
      if (mode === "liar") return true;
      if (mode === "throws") {
        FILES.set(dirnameOf(target) + "/" + basenameOf(target).replace(/\.aep$/i, "") + ".35256.4284.aep", { bytes: 1234, modified: CLOCK });
        throw new Error("After Effects error: File couldn't be opened for writing");
      }
      if (mode === "replaceThenFalse") { write(); return false; }
      if (mode === "sameMetaThenFalse") {
        // Rewritten within the same second to the same length: size and
        // timestamp both match what was there, and say nothing about content.
        const hit = lookup(target);
        FILES.set(hit[0], { ...hit[1] });
        return false;
      }
      if (!DIRS.has(key(dirnameOf(target)))) return false;
      const hit = lookup(target);
      if (hit && hit[1].readonly) return false;
      write();
      if (mode !== "wrongPath") current = target;
      dirty = false;
      return true;
    },
  };
  const ctx = {
    OPS: {},
    noUndo: (fn) => { fn.__meta = { noUndo: true }; return fn; },
    File: MockFile,
    Folder: MockFolder,
    String,
    Error,
    app: {
      project,
      beginSuppressDialogs() { LOG.push("beginSuppressDialogs"); },
      endSuppressDialogs(alert) {
        LOG.push("endSuppressDialogs:" + String(alert));
        if (opts.endSuppressThrows) throw new Error("endSuppressDialogs failed");
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "save.jsx" });
  return ctx;
}

function refusal(fn) {
  try { fn(); } catch (e) { return String(e.message); }
  throw new assert.AssertionError({ message: "expected a refusal, got a result" });
}
const snapshot = () => JSON.stringify([...FILES.entries()].sort());
const saves = () => LOG.filter((l) => l.startsWith("save:"));
const dialogsBalanced = () => {
  const begins = LOG.filter((l) => l === "beginSuppressDialogs").length;
  const ends = LOG.filter((l) => l === "endSuppressDialogs:false").length;
  return begins === ends;
};

// ---------- save_project ----------

check("save_project and save_project_as never open an undo group", () => {
  const ctx = makeContext({});
  assert.equal(ctx.OPS.save_project.__meta.noUndo, true);
  assert.equal(ctx.OPS.save_project_as.__meta.noUndo, true);
});

check("an unsaved project is refused with Save As as the way forward, and nothing is saved", () => {
  const ctx = makeContext({ current: null });
  const m = refusal(() => ctx.OPS.save_project({}));
  assert.match(m, /never been saved/);
  assert.match(m, /save_project_as/);
  assert.match(m, /Nothing was saved/);
  assert.deepEqual(saves(), []);
});

check("save_project saves in place and proves it by path, dirty and size", () => {
  const ctx = makeContext({ files: { "/proj/show.aep": { bytes: 50000 } } });
  const r = ctx.OPS.save_project({});
  assert.equal(r.saved, true);
  assert.equal(r.path, "/proj/show.aep");
  assert.equal(r.previousPath, "/proj/show.aep");
  assert.equal(r.dirty, false);
  assert.ok(r.bytes > 0);
  assert.equal(r.previousBytes, 50000);
  assert.equal(typeof r.modified, "number");
  assert.equal("replacedExisting" in r, false, "in place is always a replacement; the flag says nothing there");
  assert.deepEqual([...r.leftoverTempFiles], []);
  assert.deepEqual(saves(), ["save:/proj/show.aep"]);
  assert.ok(dialogsBalanced());
});

check("save_project on a read-only file is refused before AE declines it silently", () => {
  const ctx = makeContext({ files: { "/proj/show.aep": { bytes: 50000, readonly: true } } });
  const before = snapshot();
  const m = refusal(() => ctx.OPS.save_project({}));
  assert.match(m, /read-only/);
  assert.deepEqual(saves(), []);
  assert.equal(snapshot(), before);
});

check("save_project whose folder has gone is refused", () => {
  const ctx = makeContext({ current: "/gone/show.aep" });
  const m = refusal(() => ctx.OPS.save_project({}));
  assert.match(m, /no longer exists/);
  assert.deepEqual(saves(), []);
});

check("save_project whose file was deleted from disk recreates it — the folder is what matters", () => {
  const ctx = makeContext({});
  const r = ctx.OPS.save_project({});
  assert.equal(r.previousBytes, null);
  assert.ok(r.bytes > 0);
});

// ---------- save_project_as: refusals before anything is written ----------

for (const [label, p] of [
  ["a relative path", "show_v2.aep"],
  ["a home-relative path", "~/show_v2.aep"],
  ["a drive-relative path", "C:show_v2.aep"],
]) {
  check(`${label} is refused, nothing saved`, () => {
    const ctx = makeContext({});
    const m = refusal(() => ctx.OPS.save_project_as({ path: p }));
    assert.match(m, /must be absolute/);
    assert.deepEqual(saves(), []);
  });
}

for (const p of ["/proj/show_v2", "/proj/show_v2.aepx", "/proj/show_v2.aep.bak"]) {
  check(`a path without the .aep extension (${p}) is refused — AE would append one`, () => {
    const ctx = makeContext({});
    const m = refusal(() => ctx.OPS.save_project_as({ path: p }));
    assert.match(m, /must end in \.aep/);
    assert.deepEqual(saves(), []);
  });
}

check("drive-letter, UNC and POSIX roots all pass the absolute check", () => {
  for (const p of ["C:\\nowhere\\x.aep", "c:/nowhere/x.aep", "\\\\host\\share\\x.aep", "/nowhere/x.aep"]) {
    const ctx = makeContext({});
    const m = refusal(() => ctx.OPS.save_project_as({ path: p }));
    assert.match(m, /destination folder .* does not exist/, `${p}: ${m}`);
  }
});

check("a missing destination folder is refused and not created", () => {
  const ctx = makeContext({});
  const before = snapshot();
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/proj/new/show.aep" }));
  assert.match(m, /does not exist/);
  assert.match(m, /does not create folders/);
  assert.equal(snapshot(), before);
  assert.equal(DIRS.has("/proj/new"), false);
});

check("an existing destination without overwrite is refused, untouched, naming the user's go-ahead", () => {
  const ctx = makeContext({ files: { "/other/keep.aep": { bytes: 777 } } });
  const before = snapshot();
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/keep.aep" }));
  assert.match(m, /already exists \(777 bytes\)/);
  assert.match(m, /overwrite:true/);
  assert.match(m, /explicit go-ahead/);
  assert.deepEqual(saves(), []);
  assert.equal(snapshot(), before);
});

check("the existence check is the file system's, so a case variant of an existing file is refused too", () => {
  const ctx = makeContext({ files: { "/other/KEEP.AEP": { bytes: 777 } } });
  refusal(() => ctx.OPS.save_project_as({ path: "/other/keep.aep" }));
  assert.deepEqual(saves(), []);
});

check("Save As onto the project's own current file follows the same rule — no redirect to a plain save", () => {
  const ctx = makeContext({ files: { "/proj/show.aep": { bytes: 50000 } } });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/proj/show.aep" }));
  assert.match(m, /project's own current file/);
  assert.deepEqual(saves(), []);
  const r = ctx.OPS.save_project_as({ path: "/proj/show.aep", overwrite: true });
  assert.equal(r.replacedExisting, true);
  assert.equal(r.overwrite, true);
  assert.equal(r.note, undefined, "same folder: nothing moves");
});

check("overwrite:true onto a read-only file is still refused", () => {
  const ctx = makeContext({ files: { "/other/keep.aep": { bytes: 777, readonly: true } } });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/keep.aep", overwrite: true }));
  assert.match(m, /read-only/);
  assert.deepEqual(saves(), []);
});

// ---------- save_project_as: saves ----------

check("a new path saves, repoints the project, and says house-style now reads from the new folder", () => {
  const ctx = makeContext({});
  const r = ctx.OPS.save_project_as({ path: "/other/show_v2.aep" });
  assert.equal(r.saved, true);
  assert.equal(r.path, "/other/show_v2.aep");
  assert.equal(r.previousPath, "/proj/show.aep");
  assert.equal(r.replacedExisting, false);
  assert.equal(r.previousBytes, null);
  assert.equal(r.overwrite, false);
  assert.equal(r.dirty, false);
  assert.match(r.note, /house-style\.md/);
  assert.match(r.note, /not from \/proj/);
  assert.ok(dialogsBalanced());
});

check("an unsaved project can be saved as, and the note does not invent a previous folder", () => {
  const ctx = makeContext({ current: null });
  const r = ctx.OPS.save_project_as({ path: "/proj/first.aep" });
  assert.equal(r.previousPath, null);
  assert.match(r.note, /house-style\.md/);
  assert.doesNotMatch(r.note, /not from/);
});

check("overwrite:true replaces an existing file and reports it", () => {
  const ctx = makeContext({ files: { "/other/keep.aep": { bytes: 777 } } });
  const r = ctx.OPS.save_project_as({ path: "/other/keep.aep", overwrite: true });
  assert.equal(r.replacedExisting, true);
  assert.equal(r.previousBytes, 777);
  assert.notEqual(r.bytes, 777);
});

check("a timestamp that did not move is not a failure — the proof is path, dirty and size", () => {
  const ctx = makeContext({ files: { "/proj/show.aep": { bytes: 50000 } } });
  const sameSecond = CLOCK + 1000;       // what the mock's save will stamp
  FILES.get("/proj/show.aep").modified = sameSecond;
  const r = ctx.OPS.save_project({});
  assert.equal(r.saved, true);
  assert.equal(r.modified, sameSecond, "the timestamp did not move, and that is fine");
});

// ---------- failures: say what is on disk ----------

check("AE answering false is a failure that says nothing was written and the project did not move", () => {
  const ctx = makeContext({ save: "false" });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/show_v2.aep" }));
  assert.match(m, /answered false/);
  assert.match(m, /nothing was written at the destination/);
  assert.match(m, /\/proj\/show\.aep \(unchanged\)/);
  assert.ok(dialogsBalanced());
});

check("a throw mid-save restores dialogs, names the temp file AE left, and removes nothing", () => {
  const ctx = makeContext({ save: "throws" });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/show_v2.aep" }));
  assert.match(m, /After Effects threw: After Effects error: File couldn't be opened for writing/);
  assert.match(m, /temporary file\(s\).*show_v2\.35256\.4284\.aep/);
  assert.match(m, /nothing was removed/);
  assert.ok(FILES.has("/other/show_v2.35256.4284.aep"), "the leftover must still be there");
  assert.ok(dialogsBalanced(), "endSuppressDialogs must run when save throws");
});

check("a temp file that was already there is not blamed on this attempt", () => {
  const ctx = makeContext({ files: { "/other/show_v2.1.2.aep": { bytes: 9 } } });
  const r = ctx.OPS.save_project_as({ path: "/other/show_v2.aep" });
  assert.deepEqual([...r.leftoverTempFiles], []);
});

check("true with nothing written is a failure, not a success", () => {
  const ctx = makeContext({ save: "liar" });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/show_v2.aep" }));
  assert.match(m, /no file at \/other\/show_v2\.aep/);
  assert.match(m, /the project's path is \/proj\/show\.aep/);
  assert.match(m, /unsaved changes/);
});

check("a replaced file followed by false says the old file was replaced", () => {
  const ctx = makeContext({ save: "replaceThenFalse", files: { "/other/keep.aep": { bytes: 777 } } });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/keep.aep", overwrite: true }));
  assert.match(m, /changed \(777 -> \d+ bytes\)/);
  assert.match(m, /replaced, at least in part/);
});

check("a file written while the project still points elsewhere is a failure naming both", () => {
  const ctx = makeContext({ save: "wrongPath" });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/show_v2.aep" }));
  assert.match(m, /the project's path is \/proj\/show\.aep, not \/other\/show_v2\.aep/);
  assert.match(m, /a \d+-byte file now exists at the destination/);
});

// ---------- reporting gaps (C6 review) ----------

check("matching size and timestamp is reported as matching metadata, content unknown — never 'unchanged'", () => {
  const ctx = makeContext({ save: "sameMetaThenFalse", files: { "/other/keep.aep": { bytes: 777 } } });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/keep.aep", overwrite: true }));
  assert.match(m, /same size and timestamp/);
  assert.match(m, /whether its contents changed is unknown/);
  assert.doesNotMatch(m, /unchanged \(same size/);
});

check("a successful save reports itself verified, with dialogs restored", () => {
  const ctx = makeContext({});
  const r = ctx.OPS.save_project_as({ path: "/other/show_v2.aep" });
  assert.equal(r.verified, true);
  assert.deepEqual([...r.unverified], []);
  assert.equal(r.dirty, false);
  assert.equal(r.dialogsRestored, true);
  assert.equal(r.warning, undefined);
});

for (const [mode, why] of [["throws", /threw: dirty is not available/], ["missing", /not available \(undefined\)/], ["string", /not a boolean \(string\)/]]) {
  check(`a dirty flag that ${mode === "throws" ? "throws" : mode === "missing" ? "is missing" : "is not a boolean"} stays unknown and the save is not called fully verified`, () => {
    const ctx = makeContext({ dirty: mode });
    const r = ctx.OPS.save_project_as({ path: "/other/show_v2.aep" });
    assert.equal(r.saved, true, "path and file still show the save happened");
    assert.equal(r.dirty, null, "unknown, never false");
    assert.equal(r.verified, false);
    assert.equal(r.unverified.length, 1);
    assert.match(r.unverified[0], /unsaved-changes flag/);
    assert.match(r.unverified[0], why);
  });
}

check("dialogs that could not be restored after a good save: saved and verified, a separate warning, no second save", () => {
  const ctx = makeContext({ endSuppressThrows: true });
  const r = ctx.OPS.save_project_as({ path: "/other/show_v2.aep" });
  assert.equal(r.saved, true);
  assert.equal(r.verified, true, "the file's verification is not the dialog state's");
  assert.equal(r.dialogsRestored, false);
  assert.match(r.dialogRestoreError, /endSuppressDialogs failed/);
  assert.match(r.warning, /The project was saved/);
  assert.match(r.warning, /do not save again/i);
  assert.equal(saves().length, 1);
});

check("dialogs that could not be restored after a failed save: the save failure leads, the dialog problem follows", () => {
  const ctx = makeContext({ save: "false", endSuppressThrows: true });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/show_v2.aep" }));
  assert.match(m, /^save_project_as: the save did not verify — After Effects answered false/);
  assert.match(m, /nothing was written at the destination/);
  assert.match(m, /Separately.*dialogs.*could not be restored.*endSuppressDialogs failed/);
  assert.ok(m.indexOf("answered false") < m.indexOf("Separately"));
});

check("dialogs that could not be restored after a save that threw keep AE's own error", () => {
  const ctx = makeContext({ save: "throws", endSuppressThrows: true });
  const m = refusal(() => ctx.OPS.save_project_as({ path: "/other/show_v2.aep" }));
  assert.match(m, /After Effects threw: After Effects error: File couldn't be opened for writing/);
  assert.match(m, /Separately.*endSuppressDialogs failed/);
});

// ---------- the schema ----------

const shared = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href);

check("the schema takes absolute .aep paths on every root, any case of the extension", () => {
  for (const p of ["C:\\Projects\\a.aep", "c:/Projects/a.AEP", "\\\\host\\share\\a.Aep", "/Users/me/a.aep", "/Users/me/sp ace ü日本.aep"]) {
    assert.ok(shared.SaveProjectAs.safeParse({ path: p }).success, p);
  }
});
check("the schema refuses relative, home-relative and non-.aep paths, and unknown keys", () => {
  for (const p of ["a.aep", "~/a.aep", "C:a.aep", "/Users/me/a", "/Users/me/a.aepx", ""]) {
    assert.equal(shared.SaveProjectAs.safeParse({ path: p }).success, false, p);
  }
  assert.equal(shared.SaveProjectAs.safeParse({ path: "/a.aep", force: true }).success, false);
  assert.equal(shared.SaveProject.safeParse({ path: "/a.aep" }).success, false);
});
check("overwrite defaults to false", () => {
  assert.equal(shared.SaveProjectAs.parse({ path: "/a.aep" }).overwrite, false);
});
check("both are classified as writes", () => {
  assert.equal(shared.OpMutation.save_project, "write");
  assert.equal(shared.OpMutation.save_project_as, "write");
});

console.log(`save-project: ${passed} checks passed`);
