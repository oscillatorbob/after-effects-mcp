// timing.jsx — layer timing (startTime, inPoint, outPoint, stretch) and the
// Time Remap structure: set_layer_timing, set_time_remap, and the timing record
// get_layer_structure reports. set_layer's own timing fields go through the
// same planner, so there is one set of rules.
//
// Measured on AE 26.5x89 (docs/fragile-areas-ae.md, "Layer timing and Time
// Remap"; recipe 56), and every rule below follows from one of these:
//
//   - startTime slides the whole layer: inPoint, outPoint and every keyframe
//     (Time Remap's included) move with it. Trims (inPoint/outPoint) move no
//     keys. stretch scales inPoint, outPoint and every key about startTime and
//     leaves startTime where it is.
//   - Setting inPoint DRAGS outPoint by the same amount, on every layer type.
//     Setting outPoint alone moves nothing else — and AE accepts an outPoint at
//     or before the inPoint, which leaves a layer with no visible frames. So
//     the order is fixed: stretch, startTime, inPoint, then outPoint written
//     explicitly, and out > in is checked before anything is written.
//   - A footage, audio or precomp layer WITHOUT Time Remap is bounded by its
//     source: inPoint and outPoint are clamped, silently, to
//     [startTime, startTime + sourceDuration * stretch/100]. With Time Remap on
//     there is no bound. Stills, solids, nulls, text, shapes, cameras and
//     lights are unbounded either way (negative times, past the comp end).
//   - stretch takes -9900..9900 and throws outside it; anything with a
//     magnitude under 1 is stored as ±0.999451 with no error. Negative stretch
//     reverses the layer: AE mirrors inPoint/outPoint (inPoint > outPoint) and
//     every key about startTime with a 1/100-frame offset. Going back to a
//     positive stretch restores the exact original times.
//   - Times are quantized: 0.0123 is stored as 0.012305. Frame multiples of
//     comp.frameDuration read back to 1e-15, 23.976 included.
//   - Every timing write and timeRemapEnabled is refused by AE on a locked
//     layer ("...because the Layer is locked").
//   - timeRemapEnabled: canSetTimeRemapEnabled is true only on footage (video
//     or audio) and precomp layers. Stills, solids, nulls, text and shapes
//     throw; a camera or light has neither property, so the assignment
//     "succeeds" by creating a plain script property and nothing happens.
//   - Enabling creates exactly two LINEAR keys: (startTime, 0) and
//     (startTime + sourceDuration * stretch/100, sourceDuration) — wherever the
//     layer is trimmed. When the inPoint is trimmed and the outPoint is at the
//     source end, enabling moves the outPoint to inPoint + that duration.
//   - Disabling deletes every Time Remap key and clamps the trims back inside
//     the source. The expression is NOT deleted: it stays stored on the hidden
//     property and is live again the moment Time Remap is re-enabled.

var __TIMING_TOL = 1e-4;          // seconds: readback, comparison and bound tolerance (AE quantizes ~5e-6)
var __TIMING_STRETCH_MIN = 1;     // |stretch| under 1 is stored as 0.999451, silently
var __TIMING_STRETCH_MAX = 9900;
var __TIMING_FIELDS = ["stretch", "startTime", "inPoint", "outPoint"];   // the write order

// stretch is stored as a 32-bit float factor (stretch/100): 120 reads back
// 120.000004768372. So its tolerance is relative — float32 keeps ~7
// significant digits.
function __tmStretchTol(s) { return Math.max(1e-6, Math.abs(s) * 1e-6); }
function __tmFieldTol(f, v) { return f === "stretch" ? __tmStretchTol(v) : __TIMING_TOL; }

function __tmIsNum(v) { return typeof v === "number" && isFinite(v); }
function __tmClose(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? __TIMING_TOL : tol); }
function __tmFrameOf(t, fd) {
  var f = t / fd;
  var r = Math.round(f);
  return Math.abs(f - r) < 1e-6 ? r : Math.round(f * 1000) / 1000;
}

// The Time Remap property, or null. `layer.timeRemap` first, the match name as
// a fallback (audio.jsx's __timeRemapProperty, kept separate so this module
// stands alone).
function __tmProp(l) {
  var p = null;
  try { p = l.timeRemap; } catch (e) { p = null; }
  if (p) return p;
  try { p = l.property("ADBE Time Remapping"); } catch (e2) { p = null; }
  return p;
}

function __tmSupported(l) {
  var can;
  try { can = l.canSetTimeRemapEnabled; } catch (e) { return false; }
  return can === true;
}

function __tmEnabled(l) {
  if (!__tmSupported(l)) return false;
  try { return l.timeRemapEnabled === true; } catch (e) { return false; }
}

// The source's duration when it bounds the layer, else null: a still, a solid
// (null layers included) or no source at all has no length to run out of.
function __tmSourceDuration(l) {
  var s = null;
  try { s = l.source; } catch (e) { s = null; }
  if (!s) return null;
  var d = null;
  try { d = s.duration; } catch (e2) { d = null; }
  if (!__tmIsNum(d) || d <= 0) return null;
  try { if (s.mainSource && s.mainSource.isStill === true) return null; } catch (e3) {}
  return d;
}

function __tmKind(l) {
  try { if (typeof __layerKind === "function") return __layerKind(l); } catch (e) {}
  return "layer";
}

function __timingRead(c, l) {
  var fd = c.frameDuration;
  var st = l.startTime, ip = l.inPoint, op = l.outPoint, sx = l.stretch;
  var r = {
    startTime: st, inPoint: ip, outPoint: op, duration: op - ip, stretch: sx,
    startFrame: __tmFrameOf(st, fd), inFrame: __tmFrameOf(ip, fd), outFrame: __tmFrameOf(op, fd),
    sourceDuration: __tmSourceDuration(l),
    timeRemapEnabled: __tmEnabled(l)
  };
  if (sx < 0) r.reversed = true;
  return r;
}

// ---------------------------------------------------------------------------
// Time Remap state: default or custom
// ---------------------------------------------------------------------------
// "Default" is what enabling creates, re-derived from the layer as it is now:
// exactly two keys, (startTime, 0) and (startTime + sourceDuration*stretch/100,
// sourceDuration), both linear on both sides, neither continuous nor
// auto-Bezier, unlabelled, and no expression text at all. The formula follows
// the layer through later startTime and stretch changes, as AE's keys do, and
// trims never touch it. Anything else is custom, and a reversed layer is
// always custom: its default keys sit 1/100 frame off the formula.

function __tmKeys(p, fd, max) {
  var keys = [];
  var n = p.numKeys;
  for (var k = 1; k <= n && k <= max; k++) {
    var t = p.keyTime(k);
    keys.push({ time: t, frame: __tmFrameOf(t, fd), value: p.keyValue(k),
      interpolation: { "in": __tmInterpName(p.keyInInterpolationType(k)), out: __tmInterpName(p.keyOutInterpolationType(k)) } });
  }
  return keys;
}

function __tmInterpName(v) {
  try {
    if (v === KeyframeInterpolationType.LINEAR) return "linear";
    if (v === KeyframeInterpolationType.BEZIER) return "bezier";
    if (v === KeyframeInterpolationType.HOLD) return "hold";
  } catch (e) {}
  return String(v);
}

function __tmCustomReasons(l, p) {
  var why = [];
  var expr = "";
  try { expr = p.expression || ""; } catch (e) { expr = ""; }
  if (expr !== "") why.push("it has an expression");
  var sx = l.stretch;
  if (sx < 0) { why.push("the layer is reversed (negative stretch), where AE's default keys sit off the default times"); return why; }
  var src = __tmSourceDuration(l);
  if (src === null) { why.push("the layer's source has no duration to compare the keys against"); return why; }
  var n = p.numKeys;
  if (n !== 2) { why.push("it has " + n + " key" + (n === 1 ? "" : "s") + " (the default is 2)"); return why; }
  var st = l.startTime;
  var want = [[st, 0], [st + src * sx / 100, src]];
  for (var k = 1; k <= 2; k++) {
    var t = p.keyTime(k), v = p.keyValue(k);
    if (!__tmClose(t, want[k - 1][0]) || !__tmClose(v, want[k - 1][1], 1e-6)) {
      why.push("key " + k + " is at " + t + " s with value " + v + " (the default is " + want[k - 1][0] + " s, value " + want[k - 1][1] + ")");
    }
    var linear = false;
    try { linear = p.keyInInterpolationType(k) === KeyframeInterpolationType.LINEAR && p.keyOutInterpolationType(k) === KeyframeInterpolationType.LINEAR; } catch (e2) {}
    if (!linear) why.push("key " + k + " is not linear on both sides");
    var flags = false;
    try { flags = p.keyTemporalContinuous(k) || p.keyTemporalAutoBezier(k); } catch (e3) {}
    if (flags) why.push("key " + k + " is continuous or auto-Bezier");
    var label = 0;
    try { label = p.keyLabel(k); } catch (e4) { label = 0; }
    if (label) why.push("key " + k + " has a label");
  }
  return why;
}

// {supported, enabled, state, numKeys, hasExpression, expressionEnabled, customReasons?}
// state: "unsupported" | "off" | "default" | "custom".
function __timeRemapInfo(l) {
  var info = { supported: __tmSupported(l), enabled: false, state: "unsupported", numKeys: null, hasExpression: false };
  if (!info.supported) return info;
  info.enabled = __tmEnabled(l);
  var p = __tmProp(l);
  var expr = "";
  try { expr = p ? (p.expression || "") : ""; } catch (e) { expr = ""; }
  info.hasExpression = expr !== "";
  if (info.hasExpression) { try { info.expressionEnabled = p.expressionEnabled === true; } catch (e2) {} }
  if (!info.enabled) {
    info.state = "off";
    if (info.hasExpression) info.storedExpression = "Time Remap is off but an expression is stored on it; enabling Time Remap makes it live again.";
    return info;
  }
  info.numKeys = p ? p.numKeys : 0;
  var why = p ? __tmCustomReasons(l, p) : ["the Time Remap property could not be read"];
  info.state = why.length ? "custom" : "default";
  if (why.length) info.customReasons = why;
  return info;
}

// The compact per-layer record get_layer_structure carries.
function __timingRecord(l) {
  var t = {
    startTime: l.startTime, inPoint: l.inPoint, outPoint: l.outPoint,
    duration: l.outPoint - l.inPoint, stretch: l.stretch,
    sourceDuration: __tmSourceDuration(l)
  };
  var tr = __timeRemapInfo(l);
  t.timeRemap = { state: tr.state, numKeys: tr.numKeys, hasExpression: tr.hasExpression };
  return t;
}

// ---------------------------------------------------------------------------
// The timing planner — shared by set_layer_timing and set_layer
// ---------------------------------------------------------------------------
// `req` holds seconds: {startTime, inPoint, outPoint, stretch}, any subset.
// `opName` prefixes every message. `lockedForTiming` is the lock state the
// writes will meet (set_layer can unlock in the same call). Nothing writes.

function __planLayerTiming(c, l, req, opName, lockedForTiming) {
  var problems = [];
  for (var i = 0; i < __TIMING_FIELDS.length; i++) {
    var f = __TIMING_FIELDS[i];
    if (req[f] !== undefined && !__tmIsNum(req[f])) problems.push(f + " must be a finite number of seconds; got " + String(req[f]));
  }
  if (problems.length) throw new Error(opName + ": " + problems.join("; ") + ". Nothing was changed.");

  var any = false;
  for (var j = 0; j < __TIMING_FIELDS.length; j++) if (req[__TIMING_FIELDS[j]] !== undefined) any = true;
  if (!any) throw new Error(opName + ": pass at least one of startTime, inPoint, outPoint or stretch. Nothing was changed.");

  var locked = (lockedForTiming === undefined) ? l.locked : lockedForTiming;
  if (locked) {
    throw new Error(
      opName + ": layer " + l.id + " (\"" + l.name + "\") is locked, and After Effects refuses every timing write on a locked layer. " +
      "Unlock it with set_layer locked:false first. Nothing was changed."
    );
  }

  var cur = __timingRead(c, l);
  var plan = { layer: l, comp: c, before: cur, req: req, unreverse: false };

  if (req.stretch !== undefined) {
    if (req.stretch < 0) {
      throw new Error(
        opName + ": stretch " + req.stretch + " is negative. A negative stretch reverses the layer, and After Effects then mirrors " +
        "inPoint/outPoint and every key about startTime with a 1/100-frame offset — this tool does not write it. To play a clip " +
        "backwards, enable Time Remap (set_time_remap) and key it from the source end to 0 with set_keyframes. Nothing was changed."
      );
    }
    if (req.stretch < __TIMING_STRETCH_MIN || req.stretch > __TIMING_STRETCH_MAX) {
      throw new Error(
        opName + ": stretch must be between " + __TIMING_STRETCH_MIN + " and " + __TIMING_STRETCH_MAX + " percent; got " + req.stretch +
        " (After Effects refuses past 9900 and silently stores anything under 1 as 0.999451). Nothing was changed."
      );
    }
  }

  if (cur.stretch < 0) {
    // A reversed layer: the only write modelled is going back to a positive
    // stretch on its own, which was measured to restore the exact times.
    if (req.stretch === undefined || req.startTime !== undefined || req.inPoint !== undefined || req.outPoint !== undefined) {
      throw new Error(
        opName + ": layer " + l.id + " (\"" + l.name + "\") is reversed (stretch " + cur.stretch + "), where After Effects mirrors " +
        "inPoint/outPoint about startTime with a 1/100-frame offset this tool does not predict. Set a positive stretch on its own " +
        "first, then the other fields. Nothing was changed."
      );
    }
    plan.unreverse = true;
    plan.target = { stretch: req.stretch };
    plan.changed = true;
    return plan;
  }

  var newSx = req.stretch !== undefined ? req.stretch : cur.stretch;
  var newSt = req.startTime !== undefined ? req.startTime : cur.startTime;
  var k = newSx / cur.stretch;
  // An unspecified trim follows the layer: shifted with startTime, scaled with
  // stretch about it — what After Effects does to it on its own.
  var predIn = newSt + (cur.inPoint - cur.startTime) * k;
  var predOut = newSt + (cur.outPoint - cur.startTime) * k;
  var inP = req.inPoint !== undefined ? req.inPoint : predIn;
  var outP = req.outPoint !== undefined ? req.outPoint : predOut;

  var movedBy = "startTime";
  if (req.startTime !== undefined && req.stretch !== undefined) movedBy = "startTime and stretch";
  else if (req.stretch !== undefined) movedBy = "stretch";
  else if (req.startTime === undefined) movedBy = null;
  var from = function (f, v) {
    if (req[f] !== undefined) return f + " " + v;
    return f + " " + v + " (not passed: the layer's current " + f + (movedBy === null ? "" : " " + cur[f] + ", moved with " + movedBy) + ")";
  };
  if (outP - inP <= __TIMING_TOL) {
    throw new Error(
      opName + ": the layer would end at or before it starts — " + from("inPoint", inP) + ", " + from("outPoint", outP) + ". " +
      "outPoint must be after inPoint (After Effects accepts it and leaves a layer with no frames). Nothing was changed."
    );
  }

  var src = cur.sourceDuration;
  if (src !== null && !cur.timeRemapEnabled) {
    var lo = newSt, hi = newSt + src * newSx / 100;
    var out = [];
    if (inP < lo - __TIMING_TOL) out.push(from("inPoint", inP) + " is before the source starts (" + lo + ")");
    if (outP > hi + __TIMING_TOL) out.push(from("outPoint", outP) + " is past the source's end (" + hi + ")");
    if (out.length) {
      throw new Error(
        opName + ": " + out.join("; ") + ". The source is " + src + " s long at stretch " + newSx + ", so this layer can only show [" + lo + ", " + hi +
        "] and After Effects would clamp the trim there without a word. Move startTime, change stretch, or enable Time Remap " +
        "(set_time_remap) to hold or loop past the source. Nothing was changed."
      );
    }
  }

  plan.target = { stretch: newSx, startTime: newSt, inPoint: inP, outPoint: outP };
  plan.changed = !(__tmClose(newSx, cur.stretch, __tmStretchTol(newSx)) && __tmClose(newSt, cur.startTime) &&
    __tmClose(inP, cur.inPoint) && __tmClose(outP, cur.outPoint));
  return plan;
}

// Write `t` in the measured order. Trims are written against what AE actually
// holds after stretch/startTime, and outPoint last, because inPoint drags it.
function __writeTiming(l, t) {
  if (t.stretch !== undefined && !__tmClose(l.stretch, t.stretch, __tmStretchTol(t.stretch))) l.stretch = t.stretch;
  if (t.startTime !== undefined && !__tmClose(l.startTime, t.startTime)) l.startTime = t.startTime;
  if (t.inPoint !== undefined && !__tmClose(l.inPoint, t.inPoint)) l.inPoint = t.inPoint;
  if (t.outPoint !== undefined && !__tmClose(l.outPoint, t.outPoint)) l.outPoint = t.outPoint;
}

function __timingMismatches(l, t) {
  var bad = [];
  for (var i = 0; i < __TIMING_FIELDS.length; i++) {
    var f = __TIMING_FIELDS[i];
    if (t[f] === undefined) continue;
    var got = l[f];
    if (!__tmClose(got, t[f], __tmFieldTol(f, t[f]))) bad.push(f + ": asked " + t[f] + ", After Effects reads " + got);
  }
  return bad;
}

// Apply a plan, read every field back, and restore the original timing when
// anything did not land. Returns the after-state; throws on failure.
function __applyLayerTiming(plan, opName) {
  var l = plan.layer, c = plan.comp, b = plan.before;
  if (!plan.changed) return __timingRead(c, l);
  var failure = null;
  try {
    __writeTiming(l, plan.target);
    var bad = __timingMismatches(l, plan.target);
    if (bad.length) failure = "the write did not land — " + bad.join("; ");
  } catch (e) {
    failure = (e && e.message) ? e.message : String(e);
  }
  if (failure === null) return __timingRead(c, l);

  var orig = { stretch: b.stretch, startTime: b.startTime, inPoint: b.inPoint, outPoint: b.outPoint };
  if (plan.unreverse) orig = { stretch: b.stretch };
  var restored;
  try {
    __writeTiming(l, orig);
    var still = __timingMismatches(l, orig);
    restored = still.length ? "The restore did not land either (" + still.join("; ") + ") — use Undo" : "The original timing was restored and read back";
  } catch (e2) {
    restored = "Restoring the original timing failed too (" + ((e2 && e2.message) || e2) + ") — use Undo";
  }
  throw new Error(opName + ": " + failure + ". " + restored + ".");
}

function __timingChangedFields(b, a) {
  var out = [];
  for (var i = 0; i < __TIMING_FIELDS.length; i++) {
    var f = __TIMING_FIELDS[i];
    if (!__tmClose(b[f], a[f], __tmFieldTol(f, b[f]))) out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// set_layer_timing
// ---------------------------------------------------------------------------

OPS.set_layer_timing = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var fd = c.frameDuration;
  var req = {};
  var pairs = [["startTime", "startFrame"], ["inPoint", "inFrame"], ["outPoint", "outFrame"]];
  for (var i = 0; i < pairs.length; i++) {
    var sec = args[pairs[i][0]], fr = args[pairs[i][1]];
    if (sec !== undefined && fr !== undefined) {
      throw new Error("set_layer_timing: pass " + pairs[i][0] + " (seconds) or " + pairs[i][1] + " (frames), not both. Nothing was changed.");
    }
    if (fr !== undefined) {
      if (!__tmIsNum(fr) || Math.round(fr) !== fr) throw new Error("set_layer_timing: " + pairs[i][1] + " must be a whole number of frames; got " + String(fr) + ". Nothing was changed.");
      req[pairs[i][0]] = fr * fd;
    } else if (sec !== undefined) req[pairs[i][0]] = sec;
  }
  if (args.stretch !== undefined) req.stretch = args.stretch;

  var plan = __planLayerTiming(c, l, req, "set_layer_timing");
  var after = __applyLayerTiming(plan, "set_layer_timing");
  var out = {
    layerId: l.id,
    changed: plan.changed,
    changedFields: __timingChangedFields(plan.before, after),
    before: plan.before,
    after: after,
    frameDuration: fd
  };
  if (plan.unreverse) out.note = "The layer was reversed; it now plays forwards and its in/out points are AE's own, read back.";
  return out;
};

// ---------------------------------------------------------------------------
// set_time_remap
// ---------------------------------------------------------------------------

function __tmTrimMatches(l, b) { return __tmClose(l.inPoint, b.inPoint) && __tmClose(l.outPoint, b.outPoint); }

function __tmStateReport(c, l, maxKeys) {
  var info = __timeRemapInfo(l);
  var r = { state: info.state, numKeys: info.numKeys, hasExpression: info.hasExpression, path: ["ADBE Time Remapping"] };
  if (info.expressionEnabled !== undefined) r.expressionEnabled = info.expressionEnabled;
  if (info.customReasons) r.customReasons = info.customReasons;
  if (info.enabled) {
    var p = __tmProp(l);
    r.keys = __tmKeys(p, c.frameDuration, maxKeys);
    if (p.numKeys > maxKeys) r.keysNotListed = p.numKeys - maxKeys;
    if (info.hasExpression) { try { r.expression = p.expression; } catch (e) {} }
  }
  return r;
}

OPS.set_time_remap = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var want = args.enabled === true;
  var discard = args.discardTimeRemap === true;
  var who = "layer " + l.id + " (\"" + l.name + "\")";

  if (discard && want) {
    throw new Error("set_time_remap: discardTimeRemap only applies when disabling (enabled:false). Nothing was changed.");
  }
  if (!__tmSupported(l)) {
    throw new Error(
      "set_time_remap: " + who + " is a " + __tmKind(l) + " layer, and After Effects supports Time Remap only on footage (video or audio) " +
      "and precomp layers — not on stills, solids, nulls, text, shapes, cameras or lights. (A camera or light even appears to accept it " +
      "from a script and does nothing.) Nothing was changed."
    );
  }
  var was = __tmEnabled(l);
  if (was === want) {
    return { layerId: l.id, enabled: was, previousEnabled: was, changed: false,
      timing: __timingRead(c, l), timeRemap: __tmStateReport(c, l, 10) };
  }
  if (l.locked) {
    throw new Error(
      "set_time_remap: " + who + " is locked, and After Effects refuses timeRemapEnabled on a locked layer. " +
      "Unlock it with set_layer locked:false first. Nothing was changed."
    );
  }
  var before = __timingRead(c, l);
  return want ? __tmEnable(c, l, before, who) : __tmDisable(c, l, before, who, discard);
};

function __tmEnable(c, l, before, who) {
  if (before.stretch < 0) {
    throw new Error(
      "set_time_remap: " + who + " is reversed (stretch " + before.stretch + "). After Effects puts the default Time Remap keys 1/100 frame " +
      "off on a reversed layer, so they could never be told apart from custom ones later. Set a positive stretch with set_layer_timing " +
      "first — Time Remap is how to play a clip backwards anyway. Nothing was changed."
    );
  }
  var p0 = __tmProp(l);
  var stored = "";
  try { stored = p0 ? (p0.expression || "") : ""; } catch (e) { stored = ""; }

  l.timeRemapEnabled = true;
  var problem = null, moved = null, restored = false;
  if (l.timeRemapEnabled !== true) problem = "timeRemapEnabled still reads false after enabling";
  if (!problem && !__tmTrimMatches(l, before)) {
    // AE re-derives the out point when the in point is trimmed; put the
    // visible extent back where the caller had it. With Time Remap on there is
    // no source bound, so the original trim is always writable.
    moved = { inPoint: { from: before.inPoint, to: l.inPoint }, outPoint: { from: before.outPoint, to: l.outPoint } };
    try {
      l.inPoint = before.inPoint;
      l.outPoint = before.outPoint;
    } catch (eW) { problem = "restoring the trim failed: " + ((eW && eW.message) || eW); }
    if (!problem && !__tmTrimMatches(l, before)) problem = "the trim could not be restored (reads " + l.inPoint + " to " + l.outPoint + ")";
    restored = !problem;
  }
  var p = __tmProp(l);
  if (!problem && (!p || p.numKeys < 2)) problem = "After Effects created " + (p ? p.numKeys : "no") + " Time Remap keys (it creates 2)";
  if (problem) {
    var back = "";
    try { l.timeRemapEnabled = false; l.inPoint = before.inPoint; l.outPoint = before.outPoint; back = "Time Remap was turned off again and the trim restored"; }
    catch (eR) { back = "turning it back off failed (" + ((eR && eR.message) || eR) + ") — use Undo"; }
    throw new Error("set_time_remap: enabling on " + who + " went wrong: " + problem + ". " + back + ".");
  }
  var out = {
    layerId: l.id, enabled: true, previousEnabled: false, changed: true,
    timing: __timingRead(c, l), timingBefore: before,
    timeRemap: __tmStateReport(c, l, 10)
  };
  if (moved) {
    out.trimRestored = true;
    out.aeMovedTrim = moved;
    out.trimNote = "After Effects moved the trim when Time Remap was enabled; it was put back to where it was. Use set_layer_timing to change it.";
  }
  if (stored !== "") {
    out.expressionReactivated = stored;
    out.expressionNote = "An expression stored on Time Remap from before it was last disabled is live again and overrides the keys. clear_expression removes it.";
  }
  out.next = "Animate it with set_keyframes at path [\"ADBE Time Remapping\"] (values are source seconds); inspect_property_tree with that path and includeKeys shows the keys.";
  return out;
}

function __tmDisable(c, l, before, who, discard) {
  var info = __timeRemapInfo(l);
  var p = __tmProp(l);
  var expr = "";
  try { expr = p ? (p.expression || "") : ""; } catch (e) { expr = ""; }
  if (info.state !== "default" && !discard) {
    var keys = p ? __tmKeys(p, c.frameDuration, 5) : [];
    var shown = [];
    for (var i = 0; i < keys.length; i++) shown.push(keys[i].time + "s=" + keys[i].value);
    throw new Error(
      "set_time_remap: " + who + "'s Time Remap is customized (" + (info.customReasons || []).join("; ") + "). Disabling Time Remap DELETES every " +
      "Time Remap key — " + info.numKeys + " here" + (shown.length ? " (" + shown.join(", ") + (info.numKeys > shown.length ? ", …" : "") + ")" : "") +
      (expr !== "" ? " — and the expression \"" + expr + "\" stops rendering (After Effects keeps its text stored and revives it if Time Remap is enabled again)" : "") +
      ". Pass discardTimeRemap:true to disable it anyway; Undo is the only way back. Nothing was changed."
    );
  }
  var discardedKeys = (info.state !== "default" && p) ? __tmKeys(p, c.frameDuration, 50) : null;

  l.timeRemapEnabled = false;
  if (l.timeRemapEnabled !== false) {
    throw new Error("set_time_remap: timeRemapEnabled still reads true after disabling " + who + ". Nothing else was changed.");
  }
  // Without Time Remap the trim is bounded by the source again; AE clamps it.
  // Within the bounds, put back anything AE moved.
  var after = __timingRead(c, l);
  var clamped = null;
  if (!__tmTrimMatches(l, before)) {
    var src = before.sourceDuration;
    var lo = before.startTime, hi = src === null ? null : before.startTime + src * before.stretch / 100;
    var fits = hi === null || (before.inPoint >= lo - __TIMING_TOL && before.outPoint <= hi + __TIMING_TOL);
    if (fits) {
      try { l.inPoint = before.inPoint; l.outPoint = before.outPoint; } catch (eW) {}
      after = __timingRead(c, l);
    }
    if (!__tmTrimMatches(l, before)) {
      clamped = { inPoint: { from: before.inPoint, to: after.inPoint }, outPoint: { from: before.outPoint, to: after.outPoint },
        note: "Without Time Remap the layer cannot run past its source, so After Effects clamped the trim to [" + lo + ", " + hi + "]." };
    }
  }
  var out = {
    layerId: l.id, enabled: false, previousEnabled: true, changed: true,
    timing: after, timingBefore: before,
    timeRemap: __tmStateReport(c, l, 10)
  };
  if (clamped) out.trimClamped = clamped;
  if (discardedKeys) {
    out.discarded = { numKeys: info.numKeys, keys: discardedKeys, customReasons: info.customReasons };
    if (info.numKeys > discardedKeys.length) out.discarded.keysNotListed = info.numKeys - discardedKeys.length;
    if (expr !== "") {
      out.discarded.expression = expr;
      out.discarded.expressionNote = "The expression stopped rendering but After Effects keeps its text; it is live again if Time Remap is re-enabled.";
    }
    out.note = "Customized Time Remap was discarded at your request. Undo restores it.";
  }
  return out;
}
