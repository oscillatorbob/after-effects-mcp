// propwrite.jsx — set_property_values: the static-write counterpart to
// inspect_property_tree. A path that tool returns is accepted here unchanged.
//
// Static only. A property with keys is refused, never flattened: setValue on a
// keyed property throws in AE anyway, and removing keys to make room would
// destroy animation the caller did not mention. B2's set_keyframes owns that.
//
// Measured on 26.5x89 before this was written (docs/fragile-areas-ae.md,
// "Static property writes"); the facts that decide its shape:
//
//   * A throw is not the only failure. A 2D layer's Position/Scale/Anchor Point
//     take a Z and keep their own; a 3-number colour resets alpha to 1; some
//     integer parameters round (Fractal Type 2.5 -> 3) while others store the
//     float (Fill Rule 1.6). So every write is read back, and a value that did
//     not land is a failure, not a success.
//   * Out-of-range numbers throw ("Value 150 out of range 0 to 100") rather
//     than clamp, as do wrong shapes (scalar for vector and back). Both are
//     checked here first so a multi-update call does not fail half-way.
//   * `hidden` (canSetExpression false + canVaryOverTime true, numeric types)
//     has no false positive and is refused up front. It misses whole classes —
//     every property of a layer style that is off says canSetExpression true and
//     still throws "hidden" — so a write can still fail at runtime, which is
//     what the rollback is for.
//   * With an expression enabled, setValue changes the underlying value and
//     leaves the expression alone; `.value` is the evaluated result, and
//     `valueAtTime(t, true)` the pre-expression one. Readback uses the latter,
//     so the check is about what was written, and the result says the
//     expression still decides what renders.
//   * Restoring a saved value with setValue round-trips exactly for every type
//     written here, a mask Shape's feather points included — which makes the
//     rollback below reliable for what this tool accepts. It is still not a
//     transaction: a restore that throws is reported, never assumed.
//   * Property handles from two lookups are never ===, so "two updates aim at
//     one property" is decided on the index chain from the layer down.

var __PW_VECTOR_DIMS = { TwoD: 2, TwoD_SPATIAL: 2, ThreeD: 3, ThreeD_SPATIAL: 3 };

var __PW_REFUSED = {
  NO_VALUE: "has no value — in an effect this is a section marker or a button",
  CUSTOM_VALUE: "holds plugin-defined data After Effects does not expose to scripts, so there is no generic value to write",
  TEXT_DOCUMENT: "is a Source Text document; write text with set_text, which reads back the fields After Effects is known to reset (justification, issues #93/#94)",
  MARKER: "is the layer's marker track — markers are keys at times, not a static value; use add_marker / remove_marker"
};

// The Transform properties whose Z a 2D layer silently ignores (measured: the
// write succeeds and Z keeps its old value).
var __PW_2D_Z = { "ADBE Anchor Point": true, "ADBE Position": true, "ADBE Scale": true };

function __pwMsg(e) { return String(e && e.message ? e.message : e); }
function __pwIsNum(x) { return typeof x === "number" && !isNaN(x) && isFinite(x); }
function __pwIsInt(x) { return __pwIsNum(x) && Math.floor(x) === x; }
function __pwIsArray(x) { return x !== null && typeof x === "object" && x instanceof Array; }

function __pwJson(v) {
  var s;
  try { s = JSON.stringify(v); } catch (e) { s = String(v); }
  return s.length > 160 ? s.substring(0, 157) + "..." : s;
}

// Index chain from the layer down — the identity two differently spelled paths
// to one property share.
function __pwIdentity(p) {
  var chain = [];
  var cur = p;
  while (cur && cur.propertyDepth > 0) { chain.unshift(cur.propertyIndex); cur = cur.parentProperty; }
  return chain.join("/");
}

// matchName of the property's top-level group (Transform, Effects, …).
function __pwTopGroup(p) {
  var cur = p;
  while (cur && cur.propertyDepth > 1) cur = cur.parentProperty;
  return cur ? cur.matchName : null;
}

// Numbers compare within float32 storage error: AE stores 0.2 as
// 0.20000000298023 and 1.6 as 1.60000002384186.
function __pwClose(a, b) {
  var tol = 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tol;
}

// Structural comparison of two serialized values, numbers within tolerance.
function __pwSame(a, b) {
  if (typeof a === "number" && typeof b === "number") return __pwClose(a, b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (__pwIsArray(a) !== __pwIsArray(b)) return false;
  if (__pwIsArray(a)) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!__pwSame(a[i], b[i])) return false;
    return true;
  }
  var k;
  for (k in a) { if (a.hasOwnProperty(k) && !__pwSame(a[k], b[k])) return false; }
  for (k in b) { if (b.hasOwnProperty(k) && !a.hasOwnProperty(k)) return false; }
  return true;
}

// The value the readback is checked against, in inspect_property_tree's form.
function __pwSerialize(vt, raw) {
  var s = __itSerializeValue(vt, raw);
  return s.ok ? s.value : null;
}

// With an expression on, `.value` is what the expression made of the value;
// the value that was written is the pre-expression one.
function __pwRead(p, exprOn, t) {
  return exprOn ? p.valueAtTime(t, true) : p.value;
}

function __pwExpressionOn(p) {
  try { return !!(p.canSetExpression && p.expression && p.expressionEnabled); } catch (e) { return false; }
}

// Bounds a component against hasMin/hasMax. AE throws on out-of-range rather
// than clamping, so a value it would refuse is refused here first.
function __pwRange(p, v) {
  try { if (p.hasMin && v < p.minValue) return "is below this property's minimum " + p.minValue; } catch (e1) {}
  try { if (p.hasMax && v > p.maxValue) return "is above this property's maximum " + p.maxValue; } catch (e2) {}
  return null;
}

// Every numeric component, finite and in range. Returns a problem or null.
function __pwNumbers(p, arr) {
  for (var i = 0; i < arr.length; i++) {
    if (!__pwIsNum(arr[i])) return "element " + i + " (" + String(arr[i]) + ") is not a finite number";
    var r = __pwRange(p, arr[i]);
    if (r) return "element " + i + " (" + arr[i] + ") " + r;
  }
  return null;
}

// A Shape built on the value AE handed out (a copy), never a fresh `new
// Shape()`: a mask path carries variable-width feather points a fresh Shape
// would drop (the A1 set_mask fix). Returns {shape} or {problem}.
function __pwBuildShape(p, current, v) {
  if (!v || typeof v !== "object" || __pwIsArray(v)) {
    return { problem: "takes a Shape value {vertices, inTangents, outTangents, closed[, feather]}" };
  }
  var verts = v.vertices, inT = v.inTangents, outT = v.outTangents;
  if (!__pwIsArray(verts) || !verts.length) return { problem: "a Shape needs at least one vertex" };
  if (!__pwIsArray(inT) || !__pwIsArray(outT)) return { problem: "a Shape needs inTangents and outTangents, one per vertex" };
  if (typeof v.closed !== "boolean") return { problem: "a Shape needs `closed` (true or false)" };
  // AE pads a short tangent list with zeros rather than refusing it (measured),
  // so a mismatch would land as a different path than the one asked for.
  if (inT.length !== verts.length || outT.length !== verts.length) {
    return { problem: "has " + verts.length + " vertices but " + inT.length + " inTangents and " + outT.length + " outTangents — one of each per vertex" };
  }
  var lists = [["vertices", verts], ["inTangents", inT], ["outTangents", outT]];
  for (var li = 0; li < lists.length; li++) {
    for (var pi = 0; pi < lists[li][1].length; pi++) {
      var pt = lists[li][1][pi];
      if (!__pwIsArray(pt) || pt.length !== 2 || !__pwIsNum(pt[0]) || !__pwIsNum(pt[1])) {
        return { problem: lists[li][0] + "[" + pi + "] is not a pair of finite numbers" };
      }
    }
  }
  var segments = v.closed ? verts.length : verts.length - 1;
  var isMask = p.matchName === "ADBE Mask Shape";
  if (v.feather !== undefined && v.feather !== null) {
    if (!isMask) return { problem: "`feather` is a mask path's variable-width feather; this path is not a mask's" };
    var f = v.feather;
    var keys = ["segLocs", "relSegLocs", "radii", "types", "interps", "tensions", "relCornerAngles"];
    var n = -1;
    for (var fk = 0; fk < keys.length; fk++) {
      var arr = f[keys[fk]];
      if (!__pwIsArray(arr)) return { problem: "feather." + keys[fk] + " is missing — pass all seven arrays" };
      if (n < 0) n = arr.length;
      if (arr.length !== n) return { problem: "feather arrays differ in length (" + keys[0] + " has " + n + ", " + keys[fk] + " has " + arr.length + ")" };
      for (var fi = 0; fi < arr.length; fi++) {
        if (!__pwIsNum(arr[fi])) return { problem: "feather." + keys[fk] + "[" + fi + "] is not a finite number" };
      }
    }
    // AE does not check these (measured: a feather point on a segment the path
    // no longer has is kept), so a bad one would land as garbage.
    for (var si = 0; si < f.segLocs.length; si++) {
      if (!__pwIsInt(f.segLocs[si]) || f.segLocs[si] < 0 || f.segLocs[si] >= segments) {
        return { problem: "feather.segLocs[" + si + "] = " + f.segLocs[si] + " is not a segment of a " + (v.closed ? "closed" : "open") + " path with " + verts.length + " vertices (0.." + (segments - 1) + ")" };
      }
      if (!__pwIsInt(f.types[si]) || !__pwIsInt(f.interps[si])) {
        return { problem: "feather.types and feather.interps are integers" };
      }
    }
  } else if (isMask) {
    var kept = [];
    try { kept = current.featherSegLocs || []; } catch (eK) { kept = []; }
    for (var ki = 0; ki < kept.length; ki++) {
      if (kept[ki] >= segments) {
        return { problem: "the mask's existing feather point on segment " + kept[ki] + " would sit past the end of a path with " + segments + " segment(s) — pass `feather` explicitly (empty arrays remove them)" };
      }
    }
  }
  var s = current;
  s.vertices = verts;
  s.inTangents = inT;
  s.outTangents = outT;
  s.closed = v.closed;
  if (v.feather !== undefined && v.feather !== null) {
    s.featherSegLocs = v.feather.segLocs;
    s.featherRelSegLocs = v.feather.relSegLocs;
    s.featherRadii = v.feather.radii;
    s.featherTypes = v.feather.types;
    s.featherInterps = v.feather.interps;
    s.featherTensions = v.feather.tensions;
    s.featherRelCornerAngles = v.feather.relCornerAngles;
  }
  return { shape: s };
}

// Why After Effects would refuse a value on `p` (the measured `hidden` rule),
// or null. Shared with set_keyframes (keywrite.jsx), which hits the same rule
// on setValueAtTime; only the Time Remap wording differs between the two.
function __pwHiddenReason(l, p, vt, timeRemapWhy) {
  var hidden = false;
  try { hidden = __IT_HIDDEN_MEASURED[vt] && !p.canSetExpression && p.canVaryOverTime; } catch (eH) { hidden = false; }
  if (!hidden) return null;
  var why = "After Effects refuses a value there in the layer's current state (hidden)";
  try {
    if (p.dimensionsSeparated) why = "its dimensions are separated, so it takes no value as a whole — write its X/Y/Z followers (e.g. ADBE Position_0) instead";
    else if (p.isSeparationFollower) why = "its leader's dimensions are not separated — write the leader (e.g. ADBE Position) instead";
    else if (p.matchName === "ADBE Time Remapping") why = timeRemapWhy;
    else if (!__layerIs3D(l) && __pwTopGroup(p) === "ADBE Transform Group") why = "the layer is 2D — this property needs threeDLayer:true";
  } catch (eY) {}
  return why;
}

// Check one update and decide what to write. Returns {problem} or a plan
// entry. Nothing here writes.
function __pwPlan(c, l, u) {
  var path = u.path;
  var p;
  try { p = walkProperty(l, path); } catch (eW) { return { problem: __pwMsg(eW) }; }
  if (__itIsGroup(p)) {
    return { problem: "is a group (\"" + p.name + "\", " + p.matchName + "), not a property — inspect_property_tree with this path lists the properties inside it" };
  }
  var vt = __pvtName(p.propertyValueType);
  var label = "\"" + p.name + "\" (" + p.matchName + ", " + vt + ")";
  if (__PW_REFUSED[vt]) return { problem: label + " " + __PW_REFUSED[vt] };
  var isVector = __PW_VECTOR_DIMS[vt] !== undefined;
  var known = vt === "OneD" || vt === "COLOR" || vt === "SHAPE" || vt === "LAYER_INDEX" || vt === "MASK_INDEX" || isVector;
  if (!known) {
    return { problem: label + " is a value type static writes have not been measured on, so this tool does not write it" };
  }

  var numKeys = 0;
  try { numKeys = p.numKeys; } catch (eN) { numKeys = 0; }
  if (numKeys > 0) {
    return { problem: label + " has " + numKeys + " keyframe" + (numKeys === 1 ? "" : "s") + ", so it has no single static value — this tool never removes keys; animation is for keyframe tools (the future set_keyframes)" };
  }

  if (__isAmbientLight(l) && __pwTopGroup(p) === "ADBE Transform Group") {
    return { problem: label + " is on an ambient light, whose Transform takes no values (it reports canSetExpression on X/Y Rotation and still refuses)" };
  }

  var why = __pwHiddenReason(l, p, vt, "Time Remap is off on this layer (and once on, it is keyed, which this static tool refuses too)");
  if (why) return { problem: label + ": " + why };

  var exprOn = __pwExpressionOn(p);
  var t = c.time;
  var currentRaw;
  try { currentRaw = __pwRead(p, exprOn, t); } catch (eR) { return { problem: label + " cannot be read (" + __pwMsg(eR) + "), so a write could not be verified" }; }

  var v = u.value;
  var write;
  if (vt === "OneD" || vt === "LAYER_INDEX" || vt === "MASK_INDEX") {
    if (!__pwIsNum(v)) return { problem: label + " takes a single number, got " + __pwJson(v) };
    var dd = false;
    try { dd = !!p.isDropdownEffect; } catch (eD) {}
    if ((dd || vt !== "OneD") && !__pwIsInt(v)) return { problem: label + " takes a whole number, got " + v };
    if (vt === "LAYER_INDEX") {
      if (v < 0 || v > c.numLayers) return { problem: label + " is a layer index: 0 for none, or 1.." + c.numLayers + " in this comp — got " + v };
      if (v > 0 && typeof AVLayer !== "undefined" && !(c.layer(v) instanceof AVLayer)) {
        return { problem: label + ": layer " + v + " (\"" + c.layer(v).name + "\") is not an AV layer (a camera or light), which After Effects refuses here" };
      }
    } else if (vt === "MASK_INDEX") {
      var nm = 0;
      try { nm = l.property("ADBE Mask Parade").numProperties; } catch (eM) { nm = 0; }
      if (v < 0 || v > nm) return { problem: label + " is a mask index: 0 for none, or 1.." + nm + " on this layer — got " + v };
    } else {
      var rr = __pwRange(p, v);
      if (rr) return { problem: label + ": " + v + " " + rr };
    }
    write = v;
  } else if (isVector || vt === "COLOR") {
    var dims = isVector ? __PW_VECTOR_DIMS[vt] : 4;
    if (!__pwIsArray(v)) return { problem: label + " takes an array of " + (vt === "COLOR" ? "3 or 4" : dims) + " numbers, got " + __pwJson(v) };
    if (vt === "COLOR") {
      if (v.length !== 3 && v.length !== 4) return { problem: label + " takes [r, g, b] or [r, g, b, a], got " + v.length + " numbers" };
    } else if (v.length !== dims) {
      return { problem: label + " takes exactly " + dims + " numbers (as inspect_property_tree reports it), got " + v.length };
    }
    var np = __pwNumbers(p, v);
    if (np) return { problem: label + ": " + np };
    write = v.slice(0);
    if (vt === "COLOR" && write.length === 3) {
      // AE resets alpha to 1 on a 3-number write (measured); "3 numbers" here
      // means "keep the alpha", so it is sent explicitly.
      write.push(currentRaw && currentRaw.length === 4 ? currentRaw[3] : 1);
    }
    if (isVector && dims === 3 && __PW_2D_Z[p.matchName] && __pwTopGroup(p) === "ADBE Transform Group" && !__layerIs3D(l)) {
      if (!__pwClose(write[2], currentRaw[2])) {
        return { problem: label + ": the layer is 2D, and After Effects ignores the Z of " + p.name + " on a 2D layer (it would keep " + currentRaw[2] + ") — pass " + currentRaw[2] + " as the third number, or make the layer 3D first" };
      }
    }
  } else {
    // A second read: AE hands out a copy each time, and this one is edited in
    // place, so the first stays the untouched original the rollback restores.
    var built = __pwBuildShape(p, __pwRead(p, exprOn, t), v);
    if (built.problem) return { problem: label + ": " + built.problem };
    write = built.shape;
  }

  return {
    path: path,
    label: label,
    identity: __pwIdentity(p),
    name: p.name,
    matchName: p.matchName,
    vt: vt,
    exprOn: exprOn,
    previousRaw: currentRaw,
    previous: __pwSerialize(vt, currentRaw),
    write: write,
    want: __pwSerialize(vt, write)
  };
}

// Put back what the earlier writes changed, newest first, each read back.
function __pwRollback(l, t, done) {
  var notes = [];
  var clean = true;
  for (var i = done.length - 1; i >= 0; i--) {
    var e = done[i];
    var where = __propertyPathLabel(e.path);
    try {
      var p = walkProperty(l, e.path);
      p.setValue(e.previousRaw);
      var back = __pwSerialize(e.vt, __pwRead(walkProperty(l, e.path), e.exprOn, t));
      if (__pwSame(e.previous, back)) notes.push(where + " restored");
      else { clean = false; notes.push(where + " NOT restored: it reads " + __pwJson(back) + ", it was " + __pwJson(e.previous)); }
    } catch (eR) {
      clean = false;
      notes.push(where + " NOT restored (" + __pwMsg(eR) + "); it was " + __pwJson(e.previous));
    }
  }
  return { clean: clean, notes: notes };
}

OPS.set_property_values = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var updates = args.updates;
  if (!__pwIsArray(updates) || updates.length < 1 || updates.length > 50) {
    throw new Error("set_property_values: `updates` must hold 1 to 50 entries. Nothing was changed.");
  }

  // ---- Preflight: every update checked, nothing written ----
  var plan = [];
  var problems = [];
  var seen = {};
  for (var i = 0; i < updates.length; i++) {
    var u = updates[i] || {};
    var where = "update " + (i + 1) + " (" + (__pwIsArray(u.path) ? __propertyPathLabel(u.path) : "no path") + ")";
    if (!__pwIsArray(u.path) || !u.path.length) { problems.push(where + ": needs a non-empty `path`"); continue; }
    var entry = __pwPlan(c, l, u);
    if (entry.problem) { problems.push(where + ": " + entry.problem); continue; }
    if (seen[entry.identity] !== undefined) {
      problems.push(where + ": resolves to the same property as update " + (seen[entry.identity] + 1) + " — the later one would silently win; pass one");
      continue;
    }
    seen[entry.identity] = i;
    plan.push(entry);
  }
  if (problems.length) {
    throw new Error("set_property_values on layer " + l.id + " (\"" + l.name + "\"): " + problems.join("; ") + ". Nothing was changed.");
  }

  // ---- Write, read back, and roll back on the first failure ----
  var t = c.time;
  var done = [];
  var out = [];
  for (var w = 0; w < plan.length; w++) {
    var e = plan[w];
    var failure = null;
    var landed = false;
    try {
      walkProperty(l, e.path).setValue(e.write);
      landed = true;
      var actual = __pwSerialize(e.vt, __pwRead(walkProperty(l, e.path), e.exprOn, t));
      if (!__pwSame(e.want, actual)) {
        failure = "the write did not land: requested " + __pwJson(e.want) + ", After Effects reads " + __pwJson(actual);
      } else {
        e.actual = actual;
      }
    } catch (eW) {
      failure = (landed ? "reading it back failed: " : "After Effects refused the value: ") + __pwMsg(eW);
    }
    if (failure) {
      var undo = landed ? done.concat([e]) : done;
      var rb = __pwRollback(l, t, undo);
      throw new Error(
        "set_property_values: update " + (w + 1) + " (" + __propertyPathLabel(e.path) + ", " + e.label + ") failed — " + failure + ". " +
        (undo.length === 0 ? "Nothing had been written, so nothing changed." :
          (rb.clean ? "Rolled back every write this call made (" + rb.notes.join("; ") + "), so nothing changed." :
            "Rollback was INCOMPLETE: " + rb.notes.join("; ") + ". Read the layer with inspect_property_tree before retrying; Edit > Undo reverts the whole call."))
      );
    }
    done.push(e);
    var item = {
      path: e.path,
      name: e.name,
      matchName: e.matchName,
      valueType: e.vt,
      previousValue: e.previous,
      actualValue: e.actual,
      changed: !__pwSame(e.previous, e.actual)
    };
    if (e.exprOn) {
      // The value written is under an enabled expression, which still decides
      // what renders. Reported, not hidden, and the expression is left alone.
      item.expressionEnabled = true;
      try { item.evaluatedValue = __pwSerialize(e.vt, walkProperty(l, e.path).value); } catch (eV) {}
    }
    out.push(item);
  }

  return {
    compId: c.id,
    layerId: l.id,
    updateCount: updates.length,
    appliedCount: out.length,
    updates: out
  };
};
