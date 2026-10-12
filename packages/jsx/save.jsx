// save.jsx — save_project and save_project_as: write the open project to disk
// without a dialog, without replacing a file nobody asked to replace, and
// without reporting a save that did not happen.
//
// Measured on 26.5x89 (recipe 68) rather than assumed:
//
//   * `app.project.save(file)` answers with a boolean. A destination folder
//     that does not exist, and a read-only destination file, both come back
//     `false` — no throw, no dialog, nothing written, and the project keeps
//     its old path and stays dirty. So `false` is a refusal AE will not
//     explain, and both causes are checked here first so the refusal can name
//     them.
//   * AE replaces an existing .aep without asking — suppressed or not, there is
//     no "replace?" prompt. The `overwrite` check below is the only protection
//     the user's file has, and it applies to the project's own current file
//     too: Save As onto the open .aep is an overwrite, not a plain save.
//   * A path without `.aep` is saved with `.aep` appended, i.e. somewhere other
//     than where the caller asked. The schema requires the extension; the
//     handler checks it again because a `run_jsx` caller can reach OPS directly.
//   * AE writes `<name>.<n>.<n>.aep` beside the target and renames it into
//     place (its error text named that file once), so a failure can leave one
//     behind. Every attempt lists the folder before and after and reports a
//     new one rather than letting it sit there unmentioned.
//   * `File.modified` has whole-second resolution, and a save of an unchanged
//     project still rewrites the file. A timestamp is reported, never used as
//     the proof: the proof is the project's own path, `dirty` false, and a
//     non-empty file at that path. Matching size and timestamp prove nothing
//     about content either way, and are reported as exactly that. A dirty
//     flag that cannot be read stays null and the save is reported with
//     `verified:false` — never rounded to false.
//   * A save is not undoable, so neither op opens an undo group (noUndo), the
//     same reason export_mogrt runs outside one.
//
// No platform branching (CLAUDE.md): paths are compared as `fsName`s and
// existence is asked of the file system, which is what makes `UP.aep` and
// `UP.AEP` the same existing file on a case-insensitive volume.

// String test, not a regex literal: the jsx sources carry none (jsx-ternary.mjs
// relies on that to tell `/` from a comment).
function __saveHasAepExt(name) {
  return typeof name === "string" && name.length > 4 && name.substring(name.length - 4).toLowerCase() === ".aep";
}

// Absolute, by the string alone: a drive root ("C:\" or "C:/"), a UNC share
// ("\host"), or a POSIX root ("/"). `new File(relative)` resolves against
// Folder.current, which is wherever After Effects last looked — never a
// destination anybody chose. "~" is refused for the same reason.
function __saveIsAbsolute(p) {
  if (typeof p !== "string" || p.length < 2) return false;
  var c0 = p.charAt(0), c1 = p.charAt(1), c2 = p.charAt(2);
  if (c0 === "/") return true;
  if (c0 === "\\" && c1 === "\\") return true;
  var letter = (c0 >= "A" && c0 <= "Z") || (c0 >= "a" && c0 <= "z");
  return letter && c1 === ":" && (c2 === "\\" || c2 === "/");
}

function __saveStat(file) {
  var out = { exists: false, bytes: null, modified: null };
  try {
    var f = new File(file.fsName);
    out.exists = !!f.exists;
    if (out.exists) {
      out.bytes = f.length;
      try { out.modified = f.modified ? f.modified.getTime() : null; } catch (eM) {}
    }
  } catch (e) {}
  return out;
}

// The temp files AE leaves when a save dies between write and rename: same
// folder, `<base>.<anything>.aep`. Names only; nothing is ever removed here.
function __saveTempNames(file) {
  var names = [];
  try {
    var base = file.name.substring(0, file.name.length - 4);
    var found = file.parent.getFiles(base + ".*.aep");
    for (var i = 0; i < found.length; i++) {
      if (found[i] instanceof File && found[i].name.toLowerCase() !== file.name.toLowerCase()) names.push(found[i].fsName);
    }
  } catch (e) {}
  return names;
}
function __saveNewNames(before, after) {
  var out = [];
  for (var i = 0; i < after.length; i++) {
    var seen = false;
    for (var j = 0; j < before.length; j++) if (before[j] === after[i]) { seen = true; break; }
    if (!seen) out.push(after[i]);
  }
  return out;
}

function __saveCurrentPath() {
  try { return app.project.file ? app.project.file.fsName : null; } catch (e) { return null; }
}
// The unsaved-changes flag as After Effects reports it: true, false, or — when
// the getter throws, is missing, or answers something that is not a boolean —
// null with the reason. Unknown is never rounded to false.
function __saveDirty() {
  var v;
  try { v = app.project.dirty; } catch (e) {
    return { value: null, problem: "the unsaved-changes flag could not be read (it threw: " + (e.message || String(e)) + ")" };
  }
  if (v === true || v === false) return { value: v, problem: null };
  if (typeof v === "undefined") return { value: null, problem: "the unsaved-changes flag is not available (undefined)" };
  return { value: null, problem: "the unsaved-changes flag is not a boolean (" + typeof v + ")" };
}

// What happened to the destination, in words a user would check by hand.
function __saveDiskChange(before, after) {
  if (!before.exists && !after.exists) return "nothing was written at the destination";
  if (!before.exists && after.exists) return "a " + after.bytes + "-byte file now exists at the destination, written by this attempt";
  if (before.exists && !after.exists) return "the file that was at the destination is gone";
  if (before.bytes !== after.bytes || before.modified !== after.modified) {
    return "the file at the destination changed (" + before.bytes + " -> " + after.bytes + " bytes) — it was replaced, at least in part";
  }
  // Size and a whole-second timestamp can both match a file that was rewritten
  // in the same second; no hash is taken, so the contents are not known.
  return "the file at the destination has the same size and timestamp as before; whether its contents changed is unknown";
}

// The one place a save happens. Every precondition has already been checked;
// this attempts it, verifies it, and on any failure throws a message that says
// what is now on disk and where the project points.
function __saveTo(opName, target, previousPath) {
  var before = __saveStat(target);
  var tempsBefore = __saveTempNames(target);
  var ret, thrown = null, suppressed = false, restoreError = null;
  try {
    app.beginSuppressDialogs(); suppressed = true;
    ret = app.project.save(target);
  } catch (e) {
    thrown = e;
  } finally {
    // Unconditional: leaving dialogs suppressed silences the user's session.
    // A failure here is kept, not swallowed — and kept apart from the save's
    // own outcome, which it says nothing about.
    if (suppressed) {
      try { app.endSuppressDialogs(false); } catch (eS) { restoreError = eS.message || String(eS); }
    }
  }

  var after = __saveStat(target);
  var nowPath = __saveCurrentPath();
  var dirtyRead = __saveDirty();
  var dirty = dirtyRead.value;
  var leftovers = __saveNewNames(tempsBefore, __saveTempNames(target));

  var problems = [];
  if (thrown) problems.push("After Effects threw: " + (thrown.message || String(thrown)));
  else if (ret !== true) problems.push("After Effects answered " + String(ret) + " and gave no reason");
  if (nowPath !== target.fsName) problems.push("the project's path is " + (nowPath === null ? "none (still unsaved)" : nowPath) + ", not " + target.fsName);
  if (!after.exists) problems.push("there is no file at " + target.fsName);
  else if (!(after.bytes > 0)) problems.push("the file at " + target.fsName + " is empty");
  if (dirty === true) problems.push("the project still reads as having unsaved changes");

  if (problems.length) {
    throw new Error(
      opName + ": the save did not verify — " + problems.join("; ") + ". " +
      "On disk: " + __saveDiskChange(before, after) + ". " +
      "The project now points at " + (nowPath === null ? "no file (unsaved)" : nowPath) +
      (nowPath === previousPath ? " (unchanged)" : " (was " + (previousPath === null ? "unsaved" : previousPath) + ")") + "." +
      (leftovers.length ? " After Effects left " + leftovers.length + " temporary file(s) beside it: " + leftovers.join(", ") + " — nothing was removed." : "") +
      " Do not retry blindly: tell the user what is on disk first." +
      (dirtyRead.problem ? " Also, " + dirtyRead.problem + "." : "") +
      (restoreError ? " Separately, After Effects' dialogs were suppressed for the save and could not be restored " +
        "(endSuppressDialogs: " + restoreError + "), so it may hide warnings until it is restarted — saving again will not fix that." : "")
    );
  }

  // Path and file prove the save; an unreadable dirty flag is one check that
  // could not be made, so the save is reported but not as fully verified.
  var unverified = [];
  if (dirtyRead.problem) unverified.push(dirtyRead.problem);

  var out = {
    saved: true,
    path: nowPath,
    previousPath: previousPath,
    bytes: after.bytes,
    modified: after.modified,
    replacedExisting: before.exists,
    previousBytes: before.exists ? before.bytes : null,
    dirty: dirty,
    verified: unverified.length === 0,
    unverified: unverified,
    dialogsRestored: restoreError === null,
    leftoverTempFiles: leftovers
  };
  if (restoreError !== null) {
    out.dialogRestoreError = restoreError;
    out.warning = "The project was saved" + (out.verified ? " and verified" : "") + ". Separately, After Effects' " +
      "dialogs were suppressed for the save and could not be restored (" + restoreError + "), so After Effects may " +
      "hide warnings until it is restarted. Do not save again — it will not fix this; tell the user.";
  }
  return out;
}

OPS.save_project = noUndo(function (args) {
  var current = null;
  try { current = app.project.file; } catch (e) { current = null; }
  if (!current) {
    throw new Error(
      "save_project: this project has never been saved, so there is no file to save it into. " +
      "Use save_project_as with an absolute .aep path — ask the user where it should go. Nothing was saved."
    );
  }
  var target = new File(current.fsName);
  if (!target.parent.exists) {
    throw new Error(
      "save_project: the project's folder " + target.parent.fsName + " no longer exists, and After Effects " +
      "refuses that save without saying why. Use save_project_as to save it somewhere that exists. Nothing was saved."
    );
  }
  if (target.exists && target.readonly) {
    throw new Error(
      "save_project: " + target.fsName + " is read-only, and After Effects refuses to save over it without " +
      "saying why. Ask the user to make it writable, or use save_project_as. Nothing was saved."
    );
  }
  var out = __saveTo("save_project", target, target.fsName);
  delete out.replacedExisting;   // in place is always a replacement; it says nothing here
  return out;
});

OPS.save_project_as = noUndo(function (args) {
  var p = args.path;
  if (!__saveIsAbsolute(p)) {
    throw new Error(
      "save_project_as: path must be absolute (a drive letter, a UNC share or a / root) — got " + String(p) + ". " +
      "A relative path would land wherever After Effects last looked. Nothing was saved."
    );
  }
  if (!__saveHasAepExt(p)) {
    throw new Error(
      "save_project_as: path must end in .aep — After Effects appends .aep to any other name, which saves " +
      "somewhere other than where you asked. Got " + String(p) + ". Nothing was saved."
    );
  }
  var target = new File(p);
  var folder = target.parent;
  if (!folder || !folder.exists) {
    throw new Error(
      "save_project_as: the destination folder " + (folder ? folder.fsName : "(none)") + " does not exist. " +
      "This tool does not create folders — ask the user for an existing one, or create it first. Nothing was saved."
    );
  }
  var previousPath = __saveCurrentPath();
  var isCurrent = previousPath !== null && previousPath === target.fsName;
  if (target.exists) {
    var st = __saveStat(target);
    if (args.overwrite !== true) {
      throw new Error(
        "save_project_as: " + target.fsName + " already exists (" + st.bytes + " bytes" +
        (isCurrent ? ", and it is the project's own current file" : "") + "). After Effects would replace it " +
        "without asking, so this tool refuses unless overwrite:true is passed — and that needs the user's " +
        "explicit go-ahead to replace this file, not your judgement. Otherwise pick a new name. Nothing was saved."
      );
    }
    if (target.readonly) {
      throw new Error(
        "save_project_as: " + target.fsName + " is read-only, and After Effects refuses to save over it without " +
        "saying why. Ask the user to make it writable, or pick another path. Nothing was saved."
      );
    }
  }
  var out = __saveTo("save_project_as", target, previousPath);
  out.overwrite = args.overwrite === true;
  // house-style.md is read beside the .aep, so moving the project moves it.
  var prevFolder = null;
  try { if (previousPath !== null) prevFolder = new File(previousPath).parent.fsName; } catch (e) {}
  if (prevFolder !== folder.fsName) {
    out.note = "The project now lives in " + folder.fsName + ". Files read beside the .aep — house-style.md — " +
      "are now read from there" + (prevFolder ? ", not from " + prevFolder : "") + ".";
  }
  return out;
});
