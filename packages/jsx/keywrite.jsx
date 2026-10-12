// keywrite.jsx — set_keyframes: bulk keyframe animation at the paths
// inspect_property_tree returns, across several properties and layers in one
// call. The animated counterpart to set_property_values (propwrite.jsx), whose
// value checks it reuses.
//
// Measured on 26.5x89 before this was written (docs/fragile-areas-ae.md,
// "Keyframe writes"); the facts that decide its shape:
//
//   * Key times are composition seconds, and frame * comp.frameDuration lands
//     on the frame: AE makes a 23.976 comp's frameDuration 1/23.976
//     (0.04170837504171 — given 23.976 or 24000/1001 alike), and keyTime/
//     frameDuration reads back the integer to 1e-13 at 23.976, 24, 29.97, 30,
//     25 and 59.94. frameRate is float32 (23.9759979248047) and is never used.
//   * AE merges two keys closer than ~2.5e-5 s into one, keeps any fractional
//     time it is given, and accepts negative times and times past the end.
//   * Every AE call that sets metadata can silently change OTHER metadata:
//     setting an ease turns both sides Bezier, setting temporal continuous or
//     auto-Bezier turns both sides Bezier, auto-Bezier recomputes the ease and
//     forces continuous, continuous copies the in speed onto the out side, a
//     later ease turns auto-Bezier off, Linear resets continuous, explicit
//     spatial tangents turn spatial auto-Bezier off. Hence one fixed order per
//     key (__kwApplyMeta) and a readback of every key afterwards.
//   * A new key copies its neighbour's interpolation, and inserting one
//     rescales its Bezier neighbours' influence (AE's own curve-preserving
//     behaviour). So nothing is left to AE's default: every new key gets the
//     documented defaults explicitly, and untouched keys are compared on
//     everything but ease.
//   * Ease arrays have 2 entries on TwoD, 3 on ThreeD, 1 on everything else —
//     COLOR and SHAPE included, which report isSpatial:true but refuse every
//     spatial call. Influence outside 0.1..100 throws.
//   * Spatial tangents on Orientation rewrite the VALUE ([90,0,0] read back
//     [90,350,10]), so spatial options are refused there.
//   * Roving moves a key's time whenever a neighbour changes and zeroes its
//     neighbours' influence (0, below what any setter takes), so a roving
//     track can be neither left alone by a merge nor rebuilt by a rollback —
//     measured: restored, the roving key came back 0.15 s off. This tool never
//     sets roving and refuses any track that has roving keys.
//   * Removing a Time Remap's last key turns Time Remap off, after which the
//     property is hidden. Key sets are therefore reconciled by writing the
//     target keys first and removing the leftovers second — a track never
//     passes through zero keys unless it ends there.
//   * setValuesAtTimes keeps an existing key's metadata, as setValueAtTime
//     does; keyValue() is the pre-expression value, so readback is unaffected
//     by an enabled expression, which is never touched.
//
// Cost, measured on 2,000-key properties, decides the rest. Reads are cheap
// (~0.03 ms a key for everything). setValueAtTime on an existing key costs
// 27 ms, removeKey 4.4 ms, nearestKeyIndex 1.4 ms, and spatial auto-Bezier,
// roving and temporal auto-Bezier setters ~1.5 ms each — all linear in the
// property's length. setValuesAtTimes writes 2,000 values in 64-160 ms. And
// ExtendScript makes every object kept alive expensive: pushing 5,000 small
// objects into an array took 3.8 s, while making and dropping them is free.
// So: one setValuesAtTimes per track, key indices computed rather than looked
// up, a setter only where the key differs, keys checked as they are read
// rather than collected, and new keys with no metadata sharing one spec.

// Slack for the comp-range check only (a last frame × frameDuration can exceed
// the duration by a rounding error). Never used to decide that two times are
// one key — see "Stored key times" below.
var __KW_RANGE_EPS = 1e-9;
var __KW_MAX_TRACKS = 100;
var __KW_MAX_KEYS_PER_TRACK = 5000;
var __KW_MAX_TOTAL_KEYS = 10000;
var __KW_MAX_PROBLEMS = 25;

var __KW_SUPPORTED = { OneD: true, TwoD: true, TwoD_SPATIAL: true, ThreeD: true, ThreeD_SPATIAL: true, COLOR: true, SHAPE: true };
var __KW_REFUSED = {
  NO_VALUE: "has no value — in an effect this is a section marker or a button",
  CUSTOM_VALUE: "holds plugin-defined data After Effects does not expose to scripts, so there is no generic value to key",
  TEXT_DOCUMENT: "is a Source Text document: its keys are HOLD-only and a rebuilt TextDocument resets style fields (issues #93/#94), so this tool does not key it — use set_text, or animate a text animator's properties",
  MARKER: "is the layer's marker track — markers are not interpolated values; use add_marker / remove_marker",
  LAYER_INDEX: "is a layer index; every one measured has canVaryOverTime false and refuses keys — set it statically with set_property_values",
  MASK_INDEX: "is a mask index; every one measured has canVaryOverTime false and refuses keys — set it statically with set_property_values"
};
var __KW_INTERPS = { linear: true, bezier: true, hold: true };
// The Z After Effects stores in every key of these Transform properties on a
// 2D layer, whatever it is given (measured: [x, y, 7] reads back [x, y, 0] on
// Position and Anchor Point, and [x, y, 100] on Scale).
var __KW_2D_Z = { "ADBE Anchor Point": 0, "ADBE Position": 0, "ADBE Scale": 100 };
var __KW_META_FIELDS = ["interpolation", "easeIn", "easeOut", "temporalContinuous", "temporalAutoBezier", "spatialTangents", "spatialContinuous", "spatialAutoBezier", "label"];

function __kwIsSpatialType(vt) { return vt === "TwoD_SPATIAL" || vt === "ThreeD_SPATIAL"; }
function __kwEaseDims(vt) {
  if (vt === "TwoD") return 2;
  if (vt === "ThreeD") return 3;
  return 1;
}

// Index of the entry of `list` whose stored time (read by `field`) is exactly
// t, or -1. Exact, because both sides are times After Effects itself stored
// (see below). Every key list here is sorted — AE keeps keys in time order —
// so lookups are binary searches.
function __kwSearch(list, t, field) {
  var lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var d = list[mid][field] - t;
    if (d === 0) return mid;
    if (d < 0) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}
// The same over a plain sorted array of times.
function __kwHasTime(times, t) {
  var lo = 0, hi = times.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (times[mid] === t) return true;
    if (times[mid] < t) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

// ---------------------------------------------------------------- stored key times
// Where After Effects stores a key time — measured on 26.5x89 (recipe 61). It
// rounds the time to float32, then to a grid whose step depends on the comp's
// frame rate (24576 steps/s at 12/24/48 fps, 25600 at 25/50/100, 30720 at
// 15/30/60/120, 32768 at 1, 35840 at 17.5, and 23976 — a step of 1/23976 s,
// frameDuration/1000 at 23.976 — at every NTSC rate) and on the layer's stretch (not its start time). A time on
// an existing key's step updates that key; one step away is a different key —
// at 30 fps, 1 s and 1 + 2/30720 s are two keys. No formula covers every rate,
// and the fixed 1e-4 s this module used to match with took those two for one
// (a merge silently overwrote the key at 1 s). So two times are never judged
// the same key by distance: After Effects is asked. A scratch comp with the
// target comp's frameDuration, holding a text layer with the target layer's
// start time and stretch, stores exactly the doubles the target stores
// (144/144 bit-identical across 23.976/25/30/60 fps, stretch 61–250%,
// times to 900 s). "Same key" is "stored at the same time there". The scratch
// comp lives for one set_keyframes call and is removed before it returns.
function __kwOracleOpen(c) {
  var o = { comp: null, layer: null, prop: null, st: null, sx: null };
  o.comp = app.project.items.addComp("__ae_mcp_key_time_probe__", 4, 4, 1, Math.max(c.duration, 1), 30);
  try {
    o.comp.frameDuration = c.frameDuration;
    if (o.comp.frameDuration !== c.frameDuration) {
      throw new Error("a scratch comp took frameDuration " + o.comp.frameDuration + " for this comp's " + c.frameDuration + ", so where After Effects stores key times here could not be determined");
    }
    o.layer = o.comp.layers.addText("key time probe");
    o.prop = o.layer.property("ADBE Transform Group").property("ADBE Rotate Z");
  } catch (e) {
    var left = __kwOracleClose(o);
    if (left) e.cleanup = left;
    throw e;
  }
  return o;
}
// Remove the scratch comp. Returns null once it is gone, or — when After
// Effects would not remove it — a sentence naming it, so the caller can say so
// rather than leave an unexplained comp in the user's project.
function __kwOracleClose(o) {
  if (!o || !o.comp) return null;
  var cmp = o.comp, id = null, name = "__ae_mcp_key_time_probe__";
  o.comp = null;
  try { id = cmp.id; name = cmp.name; } catch (eI) {}
  var why = null;
  try { cmp.remove(); } catch (e) { why = __pwMsg(e); }
  if (why === null) {
    // Confirmed, not assumed: the item must be gone from the project.
    var still = false;
    try { still = id !== null && itemByIdOrNull(id) !== null; } catch (eL) { still = false; }
    if (!still) return null;
    why = "After Effects accepted remove() but the item is still in the project";
  }
  return "Cleanup FAILED: the scratch comp \"" + name + "\"" + (id !== null ? " (project item id " + id + ")" : "") +
    " that this call made to check where After Effects stores key times could not be removed (" + why + ") and is still in the project. " +
    "It holds no animation of yours — delete it with delete_project_item" + (id !== null ? "({itemId: " + id + "})" : "") +
    ". Do not re-send this set_keyframes request because of it.";
}
// What happened to the requested animation, for a message that also has to
// report a cleanup failure.
function __kwOutcomeSentence(outcome) {
  if (outcome === "refused") return "None of your animation was changed: the request was refused before anything was written.";
  if (outcome === "rolled back") return "Your animation is as it was: what this call wrote was rolled back.";
  if (outcome === "rollback incomplete") return "Your animation was NOT fully restored, as described above.";
  return "The state of your animation is as the error above describes.";
}
function __kwOracleTiming(o, l) {
  var st = l.startTime, sx = l.stretch;
  if (o.st === st && o.sx === sx) return;
  o.layer.startTime = st;
  o.layer.stretch = sx;
  if (o.layer.startTime !== st || o.layer.stretch !== sx) {
    throw new Error("a scratch layer could not take this layer's start time " + st + " and stretch " + sx + ", so where After Effects stores its key times could not be determined");
  }
  o.st = st; o.sx = sx;
}
// Where After Effects stores each of `times` (ascending) on layer l: result[i]
// is that stored time, or null when a later entry of the same list lands on
// the same key (After Effects keeps one key per stored time).
function __kwStoredTimes(o, l, times) {
  __kwOracleTiming(o, l);
  var p = o.prop;
  while (p.numKeys > 0) p.removeKey(p.numKeys);
  var vals = [], out = [], i;
  for (i = 0; i < times.length; i++) { vals.push(i); out.push(null); }
  if (times.length) p.setValuesAtTimes(times, vals);
  // Each key's value is the index of the request it holds. Rounded: on a
  // stretched layer After Effects can read a value back a hair off (Rotation 2
  // at 599.37 s, stretch 61%, read 1.99999986734146 — recipe 61), and an exact
  // lookup then took two distinct keys for one.
  for (var k = 1; k <= p.numKeys; k++) {
    var j = Math.round(p.keyValue(k));
    if (j >= 0 && j < out.length) out[j] = p.keyTime(k);
  }
  while (p.numKeys > 0) p.removeKey(p.numKeys);
  return out;
}
// A time After Effects stores exactly at kt on layer l, or null. Usually kt
// itself; but on a stretched layer far from 0, writing a key's own stored time
// can land one step away (measured: 30 fps, stretch 61%, 599.37 s), so a
// restore searches — the stored time never decreases as the requested one grows.
function __kwWriteTimeFor(o, l, kt) {
  var s = __kwStoredTimes(o, l, [kt])[0];
  if (s === kt) return kt;
  var d = Math.abs(s - kt) || 1e-6;
  var lo = s < kt ? kt : kt - d, hi = s < kt ? kt + d : kt;
  for (var w = 0; w < 12; w++) {
    var sl = __kwStoredTimes(o, l, [lo])[0], sh = __kwStoredTimes(o, l, [hi])[0];
    if (sl === kt) return lo;
    if (sh === kt) return hi;
    if (sl < kt && sh > kt) break;
    if (sl >= kt) lo -= d;
    if (sh <= kt) hi += d;
    d *= 2;
  }
  for (var b = 0; b < 64; b++) {
    var mid = (lo + hi) / 2;
    var sm = __kwStoredTimes(o, l, [mid])[0];
    if (sm === kt) return mid;
    if (sm < kt) lo = mid; else hi = mid;
  }
  return null;
}

// Eases are kept flat — [speed0, influence0, speed1, influence1, …] — one
// array per side instead of one object per dimension.
function __kwEaseFlat(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push(arr[i].speed, arr[i].influence);
  return out;
}
function __kwEaseObjects(flat) {
  var out = [];
  for (var i = 0; i < flat.length; i += 2) out.push(new KeyframeEase(flat[i], flat[i + 1]));
  return out;
}
function __kwEaseShow(flat) {
  var out = [];
  for (var i = 0; i < flat.length; i += 2) out.push({ speed: flat[i], influence: flat[i + 1] });
  return out;
}

// Tolerances. Times and eases are doubles AE hands back as given; tangents
// are float32 (-33.3333320617676), hence the looser bound.
function __kwNear(a, b, tol) { return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)); }
function __kwSameFlat(a, b, tol) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (!__kwNear(a[i], b[i], tol)) return false;
  return true;
}
function __kwSameEase(a, b) { return __kwSameFlat(a, b, 1e-6); }
function __kwSameVec(a, b) { return __kwSameFlat(a, b, 1e-5); }

// The frame a time sits on, when it sits on one; otherwise the fractional frame.
function __kwFrameOf(t, fd) {
  var f = t / fd;
  var r = Math.round(f);
  return Math.abs(f - r) < 1e-6 ? r : f;
}

// Everything AE reports about one key, plus the raw value the rollback writes
// back. Cheap to make; the callers that loop over keys check each one and
// drop it rather than keeping a list.
function __kwReadKey(p, k, spatial) {
  var s = {
    t: p.keyTime(k),
    raw: p.keyValue(k),
    inI: __invInterp(p.keyInInterpolationType(k)),
    outI: __invInterp(p.keyOutInterpolationType(k)),
    easeIn: __kwEaseFlat(p.keyInTemporalEase(k)),
    easeOut: __kwEaseFlat(p.keyOutTemporalEase(k)),
    tc: !!p.keyTemporalContinuous(k),
    tab: !!p.keyTemporalAutoBezier(k),
    label: p.keyLabel(k)
  };
  if (spatial) {
    s.inT = p.keyInSpatialTangent(k);
    s.outT = p.keyOutSpatialTangent(k);
    s.sc = !!p.keySpatialContinuous(k);
    s.sab = !!p.keySpatialAutoBezier(k);
    s.roving = !!p.keyRoving(k);
  }
  return s;
}

function __kwExpressionState(p) {
  try { return { text: p.canSetExpression ? String(p.expression || "") : "", enabled: p.canSetExpression ? !!p.expressionEnabled : false }; }
  catch (e) { return { text: "", enabled: false }; }
}

// The full animation of one property, enough to put it back.
function __kwCapture(p, vt, spatial, exprOn, t) {
  var cap = { numKeys: p.numKeys, keys: [], expression: __kwExpressionState(p) };
  if (cap.numKeys === 0) {
    cap.staticRaw = __pwRead(p, exprOn, t);
    cap.staticValue = __pwSerialize(vt, cap.staticRaw);
  }
  for (var k = 1; k <= cap.numKeys; k++) cap.keys.push(__kwReadKey(p, k, spatial));
  return cap;
}

// ---------------------------------------------------------------- values

// Check one key value and decide what to write. Returns {problem} or
// {write, want}; `want` (the serialized form to compare the readback with) is
// only made for a Shape — a number or an array is compared as written.
function __kwValue(l, p, vt, v, t, rangeCache) {
  var write;
  if (vt === "OneD") {
    if (!__pwIsNum(v)) return { problem: "takes a single number, got " + __pwJson(v) };
    if (rangeCache.dropdown && !__pwIsInt(v)) return { problem: "is a dropdown and takes a whole number, got " + v };
    if (rangeCache.hasMin && v < rangeCache.min) return { problem: v + " is below this property's minimum " + rangeCache.min };
    if (rangeCache.hasMax && v > rangeCache.max) return { problem: v + " is above this property's maximum " + rangeCache.max };
    write = v;
  } else if (__PW_VECTOR_DIMS[vt] !== undefined || vt === "COLOR") {
    var dims = vt === "COLOR" ? 4 : __PW_VECTOR_DIMS[vt];
    if (!__pwIsArray(v)) return { problem: "takes an array of " + dims + " numbers, got " + __pwJson(v) };
    if (v.length !== dims) {
      return { problem: vt === "COLOR"
        ? "takes [r, g, b, a] — four numbers, the alpha included (a key has no \"current alpha\" to keep) — got " + v.length
        : "takes exactly " + dims + " numbers (as inspect_property_tree reports it), got " + v.length };
    }
    for (var i = 0; i < v.length; i++) {
      if (!__pwIsNum(v[i])) return { problem: "element " + i + " (" + String(v[i]) + ") is not a finite number" };
      if (rangeCache.hasMin && v[i] < rangeCache.min) return { problem: "element " + i + " (" + v[i] + ") is below this property's minimum " + rangeCache.min };
      if (rangeCache.hasMax && v[i] > rangeCache.max) return { problem: "element " + i + " (" + v[i] + ") is above this property's maximum " + rangeCache.max };
    }
    if (rangeCache.flatZ !== null && v[2] !== rangeCache.flatZ) {
      return { problem: "the layer is 2D, and After Effects stores every " + p.name + " key's Z as " + rangeCache.flatZ + " on a 2D layer — pass " + rangeCache.flatZ + " as the third number, or make the layer 3D first" };
    }
    write = v;
  } else {
    // SHAPE. Built on the property's own value at that time (a copy), so a
    // mask key with no `feather` keeps the feather points the mask has there.
    var built = __pwBuildShape(p, p.valueAtTime(t, true), v);
    if (built.problem) return { problem: built.problem };
    return { write: built.shape, want: __pwSerialize(vt, built.shape) };
  }
  return { write: write };
}

// Property facts every key's value check needs, read once per track.
function __kwRangeCache(l, p, vt) {
  var rc = { dropdown: false, hasMin: false, hasMax: false, flatZ: null };
  try { rc.dropdown = !!p.isDropdownEffect; } catch (eD) {}
  try { if (p.hasMin) { rc.hasMin = true; rc.min = p.minValue; } } catch (e1) {}
  try { if (p.hasMax) { rc.hasMax = true; rc.max = p.maxValue; } } catch (e2) {}
  if (__PW_VECTOR_DIMS[vt] === 3 && __KW_2D_Z[p.matchName] !== undefined && __pwTopGroup(p) === "ADBE Transform Group" && !__layerIs3D(l)) rc.flatZ = __KW_2D_Z[p.matchName];
  return rc;
}

// ---------------------------------------------------------------- metadata

function __kwCheckEase(arr, dims, side) {
  if (!__pwIsArray(arr)) return side + " must be an array of {speed, influence}";
  if (arr.length !== dims) {
    return side + " has " + arr.length + " entr" + (arr.length === 1 ? "y" : "ies") + "; this property's ease has " + dims + " (one per temporal dimension: 2 on TwoD, 3 on ThreeD, 1 on everything else — spatial, colour and Shape properties included)";
  }
  for (var i = 0; i < arr.length; i++) {
    var e = arr[i];
    if (!e || !__pwIsNum(e.speed) || !__pwIsNum(e.influence)) return side + "[" + i + "] needs a finite speed and influence";
    if (e.influence < 0.1 || e.influence > 100) return side + "[" + i + "].influence " + e.influence + " is outside 0.1..100, which After Effects refuses";
  }
  return null;
}

function __kwCheckTangent(arr, dims, side, flatZ) {
  if (!__pwIsArray(arr) || arr.length !== dims) return "spatialTangents." + side + " takes " + dims + " numbers on this property";
  for (var i = 0; i < arr.length; i++) if (!__pwIsNum(arr[i])) return "spatialTangents." + side + "[" + i + "] is not a finite number";
  if (flatZ && dims === 3 && arr[2] !== 0) return "spatialTangents." + side + " has a Z of " + arr[2] + " on a 2D layer, where a motion path has no depth — pass 0";
  return null;
}

// The spec every new key with no metadata gets — one object per track, shared.
function __kwDefaultSpec(info) {
  var spec = { inI: "linear", outI: "linear", tab: false, tc: false, label: 0 };
  if (info.spatialOptions) {
    var zero = info.vt === "ThreeD_SPATIAL" ? [0, 0, 0] : [0, 0];
    spec.sab = false; spec.sc = true; spec.inT = zero; spec.outT = zero; spec.roving = false;
  }
  return spec;
}

// Resolve what one key's metadata must end up as. `existing` is the state of
// the key it updates in a merge, null for a new key. A field left undefined
// in the spec is left alone (merge only); a new key has every field defined.
// Specs are never modified once made — new keys with no metadata share one.
function __kwMeta(key, info, existing) {
  var isNew = !existing;
  var any = false;
  for (var f = 0; f < __KW_META_FIELDS.length; f++) if (key[__KW_META_FIELDS[f]] !== undefined) { any = true; break; }
  if (isNew && !any) return info.defaultMeta;
  var spec = {};
  var dims = __kwEaseDims(info.vt);
  if (key.easeIn !== undefined) { var e1 = __kwCheckEase(key.easeIn, dims, "easeIn"); if (e1) return { problem: e1 }; }
  if (key.easeOut !== undefined) { var e2 = __kwCheckEase(key.easeOut, dims, "easeOut"); if (e2) return { problem: e2 }; }
  var tab = key.temporalAutoBezier, tc = key.temporalContinuous;
  if (tab === true && (key.easeIn !== undefined || key.easeOut !== undefined)) {
    return { problem: "temporalAutoBezier:true makes After Effects compute the ease, so easeIn/easeOut cannot be given with it (AE turns auto-Bezier off the moment an ease is set)" };
  }
  if (tab === true && tc === false) return { problem: "temporalAutoBezier:true is always continuous in After Effects — drop temporalContinuous:false" };
  if (tab === true) tc = true;
  if (tc === true && (key.easeIn !== undefined || key.easeOut !== undefined)) {
    if (key.easeIn === undefined || key.easeOut === undefined) {
      return { problem: "a temporalContinuous key has one speed through it — give both easeIn and easeOut, with equal speeds" };
    }
    for (var d = 0; d < dims; d++) {
      if (!__kwNear(key.easeIn[d].speed, key.easeOut[d].speed, 1e-9)) {
        return { problem: "a temporalContinuous key has one speed through it, but easeIn[" + d + "].speed is " + key.easeIn[d].speed + " and easeOut[" + d + "].speed is " + key.easeOut[d].speed + " (After Effects would overwrite one with the other)" };
      }
    }
  }

  // Interpolation. Explicit wins and is checked against the rest; omitted
  // means: a side with an ease, or a continuous/auto-Bezier key, is Bezier;
  // otherwise linear on a new key and unchanged on a merged one.
  var inI, outI;
  if (key.interpolation !== undefined) {
    var ip = key.interpolation;
    if (!ip || !__KW_INTERPS[ip["in"]] || !__KW_INTERPS[ip.out]) return { problem: "interpolation needs `in` and `out`, each \"linear\", \"bezier\" or \"hold\"" };
    inI = ip["in"]; outI = ip.out;
    if (key.easeIn !== undefined && inI !== "bezier") return { problem: "easeIn shapes a Bezier in-side, but interpolation.in is \"" + inI + "\" (After Effects would switch it to Bezier)" };
    if (key.easeOut !== undefined && outI !== "bezier") return { problem: "easeOut shapes a Bezier out-side, but interpolation.out is \"" + outI + "\" (After Effects would switch it to Bezier)" };
    if (tc === true && (inI !== "bezier" || outI !== "bezier")) return { problem: (tab === true ? "temporalAutoBezier" : "temporalContinuous") + " needs Bezier on both sides, but interpolation is " + inI + "/" + outI + " (After Effects would switch both to Bezier)" };
  } else {
    inI = isNew ? "linear" : existing.inI;
    outI = isNew ? "linear" : existing.outI;
    if (key.easeIn !== undefined || tc === true) inI = "bezier";
    if (key.easeOut !== undefined || tc === true) outI = "bezier";
  }
  spec.inI = inI; spec.outI = outI;
  if (key.easeIn !== undefined) spec.easeIn = __kwEaseFlat(key.easeIn);
  if (key.easeOut !== undefined) spec.easeOut = __kwEaseFlat(key.easeOut);
  spec.tab = tab !== undefined ? tab : (isNew ? false : undefined);
  spec.tc = tc !== undefined ? tc : (isNew ? false : undefined);
  // A merged key whose stored auto-Bezier would fight a new ease or a new
  // non-Bezier side: AE turns it off anyway, so it is turned off on purpose
  // and checked.
  if (!isNew && spec.tab === undefined && existing.tab && (key.easeIn !== undefined || key.easeOut !== undefined || inI !== "bezier" || outI !== "bezier")) spec.tab = false;
  if (!isNew && spec.tc === undefined && existing.tc && (inI !== "bezier" || outI !== "bezier")) spec.tc = false;

  var spatialGiven = key.spatialTangents !== undefined || key.spatialContinuous !== undefined || key.spatialAutoBezier !== undefined;
  if (spatialGiven && !info.spatialOptions) {
    return { problem: info.spatialWhy };
  }
  if (info.spatialOptions) {
    var tdims = info.vt === "ThreeD_SPATIAL" ? 3 : 2;
    if (key.spatialAutoBezier === true && key.spatialTangents !== undefined) {
      return { problem: "spatialAutoBezier:true makes After Effects compute the tangents, so spatialTangents cannot be given with it (setting tangents turns auto-Bezier off)" };
    }
    if (key.spatialTangents !== undefined) {
      var st = key.spatialTangents;
      if (!st || typeof st !== "object") return { problem: "spatialTangents takes {in, out}" };
      var t1 = __kwCheckTangent(st["in"], tdims, "in", info.flatZ); if (t1) return { problem: t1 };
      var t2 = __kwCheckTangent(st.out, tdims, "out", info.flatZ); if (t2) return { problem: t2 };
      spec.inT = st["in"]; spec.outT = st.out;
    }
    spec.sab = key.spatialAutoBezier !== undefined ? key.spatialAutoBezier : (isNew ? false : undefined);
    spec.sc = key.spatialContinuous !== undefined ? key.spatialContinuous : (isNew ? true : undefined);
    if (isNew) {
      if (!spec.inT && spec.sab !== true) { spec.inT = info.defaultMeta.spec.inT; spec.outT = info.defaultMeta.spec.outT; }
      spec.roving = false;
    } else if (spec.inT && existing.sab && spec.sab === undefined) {
      spec.sab = false;
    }
  }
  if (key.label !== undefined) {
    if (!__pwIsInt(key.label) || key.label < 0 || key.label > 16) return { problem: "label is a label colour index, 0 (none) to 16 — got " + __pwJson(key.label) };
    spec.label = key.label;
  } else if (isNew) {
    spec.label = 0;
  }
  return { spec: spec };
}

// Apply a resolved spec to key k, in the one order measured not to undo
// itself. A setter runs only where the key differs (several cost ~1.5 ms on a
// long property), and the state is re-read after each step that can change
// another field.
function __kwApplyMeta(p, k, spec, info) {
  var BZ = KeyframeInterpolationType.BEZIER;
  if (spec.tab === true) {
    if (p.keyInInterpolationType(k) !== BZ || p.keyOutInterpolationType(k) !== BZ) p.setInterpolationTypeAtKey(k, BZ, BZ);
    if (!p.keyTemporalAutoBezier(k)) p.setTemporalAutoBezierAtKey(k, true);
  } else {
    if (spec.tab === false && p.keyTemporalAutoBezier(k)) p.setTemporalAutoBezierAtKey(k, false);
    if (spec.tc !== undefined && !!p.keyTemporalContinuous(k) !== spec.tc) p.setTemporalContinuousAtKey(k, spec.tc);
    if (spec.easeIn !== undefined || spec.easeOut !== undefined) {
      var ein = spec.easeIn !== undefined ? __kwEaseObjects(spec.easeIn) : p.keyInTemporalEase(k);
      var eout = spec.easeOut !== undefined ? __kwEaseObjects(spec.easeOut) : p.keyOutTemporalEase(k);
      p.setTemporalEaseAtKey(k, ein, eout);
    }
    // Last: an ease or a continuous flag switches both sides to Bezier, and
    // this puts each side where the spec says.
    var wantIn = __INTERP_MAP[spec.inI], wantOut = __INTERP_MAP[spec.outI];
    if (p.keyInInterpolationType(k) !== wantIn || p.keyOutInterpolationType(k) !== wantOut) p.setInterpolationTypeAtKey(k, wantIn, wantOut);
  }
  if (info.spatialOptions) {
    if (spec.sab !== undefined && !!p.keySpatialAutoBezier(k) !== spec.sab) p.setSpatialAutoBezierAtKey(k, spec.sab);
    if (spec.sc !== undefined && !!p.keySpatialContinuous(k) !== spec.sc) p.setSpatialContinuousAtKey(k, spec.sc);
    if (spec.inT && !(__kwSameVec(p.keyInSpatialTangent(k), spec.inT) && __kwSameVec(p.keyOutSpatialTangent(k), spec.outT))) {
      p.setSpatialTangentsAtKey(k, spec.inT, spec.outT);
    }
    if (spec.roving === false && p.keyRoving(k)) p.setRovingAtKey(k, false);
  }
  if (spec.label !== undefined && p.keyLabel(k) !== spec.label) p.setLabelAtKey(k, spec.label);
}

// The value a key state reads, serialized for comparison and reporting.
function __kwValueOf(s, vt) { return __pwSerialize(vt, s.raw); }

// What is wrong with key state `s` against plan entry `e`. Returns a list.
function __kwKeyMismatches(s, e, vt) {
  var bad = [];
  var spec = e.s;
  if (s.t !== e.st) bad.push("time reads " + s.t + ", where After Effects stores " + e.t + " is " + e.st);
  var want = e.wv !== undefined ? e.wv : e.w;
  var got = __kwValueOf(s, vt);
  if (!__pwSame(want, got)) bad.push("value reads " + __pwJson(got) + ", asked " + __pwJson(want));
  if (s.inI !== spec.inI || s.outI !== spec.outI) bad.push("interpolation reads " + s.inI + "/" + s.outI + ", asked " + spec.inI + "/" + spec.outI);
  if (spec.tc !== undefined && s.tc !== spec.tc) bad.push("temporalContinuous reads " + s.tc + ", asked " + spec.tc);
  if (spec.tab !== undefined && s.tab !== spec.tab) bad.push("temporalAutoBezier reads " + s.tab + ", asked " + spec.tab);
  if (spec.easeIn !== undefined && !__kwSameEase(s.easeIn, spec.easeIn)) bad.push("easeIn reads " + __pwJson(__kwEaseShow(s.easeIn)) + ", asked " + __pwJson(__kwEaseShow(spec.easeIn)));
  if (spec.easeOut !== undefined && !__kwSameEase(s.easeOut, spec.easeOut)) bad.push("easeOut reads " + __pwJson(__kwEaseShow(s.easeOut)) + ", asked " + __pwJson(__kwEaseShow(spec.easeOut)));
  if (spec.sab !== undefined && s.sab !== spec.sab) bad.push("spatialAutoBezier reads " + s.sab + ", asked " + spec.sab);
  if (spec.sc !== undefined && s.sc !== spec.sc) bad.push("spatialContinuous reads " + s.sc + ", asked " + spec.sc);
  if (spec.inT && !(__kwSameVec(s.inT, spec.inT) && __kwSameVec(s.outT, spec.outT))) bad.push("spatial tangents read " + __pwJson([s.inT, s.outT]) + ", asked " + __pwJson([spec.inT, spec.outT]));
  if (spec.roving !== undefined && s.roving !== spec.roving) bad.push("roving reads " + s.roving + ", asked " + spec.roving);
  if (spec.label !== undefined && s.label !== spec.label) bad.push("label reads " + s.label + ", asked " + spec.label);
  return bad;
}

// An untouched key (merge) against its captured state: everything but ease,
// which AE rescales on a neighbour of an inserted key, and the tangents of an
// auto-Bezier key, which AE recomputes.
function __kwUntouchedMismatches(s, o, vt) {
  var bad = [];
  if (s.t !== o.t) bad.push("time moved from " + o.t + " to " + s.t);
  var was = __kwValueOf(o, vt), is = __kwValueOf(s, vt);
  if (!__pwSame(was, is)) bad.push("value changed from " + __pwJson(was) + " to " + __pwJson(is));
  if (s.inI !== o.inI || s.outI !== o.outI) bad.push("interpolation changed from " + o.inI + "/" + o.outI + " to " + s.inI + "/" + s.outI);
  if (s.tc !== o.tc || s.tab !== o.tab) bad.push("temporal flags changed");
  if (s.label !== o.label) bad.push("label changed from " + o.label + " to " + s.label);
  if (o.sab !== undefined) {
    if (s.sab !== o.sab || s.sc !== o.sc || s.roving !== o.roving) bad.push("spatial flags changed");
    if (!o.sab && !(__kwSameVec(s.inT, o.inT) && __kwSameVec(s.outT, o.outT))) bad.push("spatial tangents changed");
  }
  return bad;
}

// Whether key state `s` differs in anything this tool writes from `o`.
function __kwStateDiffers(o, s, vt) {
  if (o.t !== s.t || !__pwSame(__kwValueOf(o, vt), __kwValueOf(s, vt)) || o.inI !== s.inI || o.outI !== s.outI ||
    o.tc !== s.tc || o.tab !== s.tab || o.label !== s.label || !__kwSameEase(o.easeIn, s.easeIn) || !__kwSameEase(o.easeOut, s.easeOut)) return true;
  if (o.sab !== undefined && (o.sab !== s.sab || o.sc !== s.sc || !__kwSameVec(o.inT, s.inT) || !__kwSameVec(o.outT, s.outT))) return true;
  return false;
}

// "key 3 (frame 151)" for a plan entry, made only when a message needs it.
function __kwAt(plan, e) {
  var key = plan.input[e.i] || {};
  return "key " + (e.i + 1) + (plan.timeBase === "frames" ? " (frame " + key.frame + ")" : " (" + key.time + "s)");
}

// ---------------------------------------------------------------- masks

// A mask path's vertex and feather-point counts.
function __kwMaskCounts(shape) {
  var v = 0, f = 0;
  try { v = shape.vertices ? shape.vertices.length : 0; } catch (e1) {}
  try { f = shape.featherSegLocs ? shape.featherSegLocs.length : 0; } catch (e2) {}
  return { v: v, f: f };
}

// On a mask path, every key must keep the mask's vertex and feather-point
// counts. Measured (2026-10-11): two keys written onto one mask with 1 and 0
// feather points raised a MODAL "After Effects warning: deleting points or
// feathers from an animated mask path deletes them from all keyframes for that
// shape unless you turn off the Preserve Constant Vertex and Feather Count
// option" — which blocks ExtendScript, and so the whole bridge, until someone
// clicks OK — and with that preference on, AE then edits every other key too.
// Shape-layer paths are not affected (a 4 -> 3 vertex change there is silent;
// the preference is about masks). The reference is the mask's existing keys,
// or its static path when it has none, so neither the write nor a rollback
// ever changes a count on a mask; the user's preference is never touched.
function __kwMaskCountProblems(plan, original, keys, label) {
  var ref, refWhat;
  if (original.numKeys > 0) {
    ref = __kwMaskCounts(original.keys[0].raw);
    for (var o = 1; o < original.keys.length; o++) {
      var oc = __kwMaskCounts(original.keys[o].raw);
      if (oc.v !== ref.v || oc.f !== ref.f) {
        return [label + ": this mask's existing keys already differ in vertex or feather-point count (key 1 has " + ref.v + " vertices and " + ref.f + " feather points, key " + (o + 1) + " has " + oc.v + " and " + oc.f + "). Writing to it, or putting it back on failure, can raise After Effects' modal \"Preserve Constant Vertex and Feather Count\" warning, which blocks every script until someone clicks it — so this tool does not write to this mask"];
      }
    }
    refWhat = "its existing keys have";
  } else {
    ref = __kwMaskCounts(original.staticRaw);
    refWhat = "its current path has";
  }
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var kc = __kwMaskCounts(keys[i].w);
    if (kc.v !== ref.v || kc.f !== ref.f) {
      out.push(__kwAt(plan, keys[i]) + ": " + label + " has " + kc.v + " vertices and " + kc.f + " feather points, but " + refWhat + " " + ref.v + " and " + ref.f + ". Every key of a mask path must keep its vertex and feather-point counts: changing them on an animated mask raises After Effects' modal \"Preserve Constant Vertex and Feather Count\" warning, which blocks every script until someone clicks it, and with that preference on edits every other key too. Match the counts — a key with no `feather` keeps the mask's feather points — or, on a mask with no keys yet, set its path statically first with set_property_values");
    }
  }
  return out;
}

// ---------------------------------------------------------------- preflight

// Check one track and decide everything it will write. Nothing here writes.
// Returns {problems: [...]} or a plan.
function __kwPlanTrack(c, l, track, fd, timeBase, oracle) {
  var p;
  try { p = walkProperty(l, track.path); } catch (eW) { return { problems: [__pwMsg(eW)] }; }
  if (__itIsGroup(p)) {
    return { problems: ["is a group (\"" + p.name + "\", " + p.matchName + "), not a property — inspect_property_tree with this path lists the properties inside it"] };
  }
  var vt = __pvtName(p.propertyValueType);
  var label = "\"" + p.name + "\" (" + p.matchName + ", " + vt + ")";
  if (__KW_REFUSED[vt]) return { problems: [label + " " + __KW_REFUSED[vt]] };
  if (!__KW_SUPPORTED[vt]) return { problems: [label + " is a value type keyframe writes have not been measured on, so this tool does not key it"] };
  var cvot = true;
  try { cvot = p.canVaryOverTime !== false; } catch (eC) {}
  if (!cvot) return { problems: [label + " cannot vary over time (canVaryOverTime is false) — After Effects refuses any keyframe on it; set it statically with set_property_values"] };
  if (__isAmbientLight(l) && __pwTopGroup(p) === "ADBE Transform Group") {
    return { problems: [label + " is on an ambient light, whose Transform takes no values"] };
  }
  var why = __pwHiddenReason(l, p, vt, "Time Remap is off on this layer — turn it on first with set_time_remap (it then starts with two keys, which replace or merge can rework)");
  if (why) return { problems: [label + ": " + why] };
  if (track.mode !== "merge" && track.mode !== "replace") return { problems: ["`mode` must be \"merge\" or \"replace\", got " + __pwJson(track.mode)] };
  if (!__pwIsArray(track.keys) || track.keys.length < 1) return { problems: ["needs at least one key"] };

  var spatial = __kwIsSpatialType(vt);
  var info = {
    vt: vt,
    spatialOptions: spatial && p.matchName !== "ADBE Orientation",
    flatZ: spatial && __pwTopGroup(p) === "ADBE Transform Group" && !__layerIs3D(l),
    spatialWhy: !spatial
      ? label + " is not a spatial property (spatial tangents, spatialContinuous and spatialAutoBezier exist only on TwoD_SPATIAL/ThreeD_SPATIAL values like Position; COLOR and Shape report isSpatial but After Effects refuses every spatial call on them)"
      : label + ": spatial options are refused on Orientation — After Effects rewrites the orientation VALUE when its tangents are set (measured: [90,0,0] read back [90,350,10])"
  };
  info.defaultMeta = { spec: __kwDefaultSpec(info) };
  var exprOn = __pwExpressionOn(p);
  var original;
  try { original = __kwCapture(p, vt, spatial, exprOn, c.time); }
  catch (eCap) { return { problems: [label + "'s existing keys cannot be read (" + __pwMsg(eCap) + "), so they could not be restored on failure"] }; }
  for (var r = 0; r < original.keys.length; r++) {
    if (original.keys[r].roving) {
      return { problems: [label + " has roving keys (key " + (r + 1) + "). After Effects recomputes a roving key's time whenever a neighbour changes and zeroes its neighbours' ease, a state no setter can rebuild — so this tool could neither leave it untouched in a merge nor restore it on failure, and does not write to it. Turn roving off in After Effects first"] };
    }
  }

  var rc = __kwRangeCache(l, p, vt);
  var plan = { timeBase: timeBase, input: track.keys };
  var problems = [];
  var keys = [];
  for (var i = 0; i < track.keys.length; i++) {
    var key = track.keys[i] || {};
    var t;
    if (timeBase === "frames") {
      if (!__pwIsInt(key.frame)) { problems.push("key " + (i + 1) + ": `frame` must be a whole number, got " + __pwJson(key.frame)); continue; }
      t = key.frame * fd;
    } else {
      if (!__pwIsNum(key.time)) { problems.push("key " + (i + 1) + ": `time` must be a finite number of seconds, got " + __pwJson(key.time)); continue; }
      t = key.time;
    }
    var entry = { i: i, t: t };
    if (t < -__KW_RANGE_EPS || t > c.duration + __KW_RANGE_EPS) {
      problems.push(__kwAt(plan, entry) + " is outside the comp (0 to " + c.duration + "s" + (timeBase === "frames" ? ", frames 0 to " + __kwFrameOf(c.duration, fd) : "") + ")");
      continue;
    }
    var val = __kwValue(l, p, vt, key.value, t, rc);
    if (val.problem) { problems.push(__kwAt(plan, entry) + ": " + label + " " + val.problem); continue; }
    entry.w = val.write;
    if (val.want !== undefined) entry.wv = val.want;
    entry.key = key;
    keys.push(entry);
  }
  keys.sort(function (a, b) { return a.t - b.t; });

  // Where After Effects will store each key, asked of After Effects itself
  // (see "Stored key times"). Two requests it stores at one time are one key;
  // a request it stores at an existing key's time IS that key — and nothing
  // closer than that counts, however close.
  if (keys.length) {
    var times = [];
    for (var q = 0; q < keys.length; q++) times.push(keys[q].t);
    var stored;
    try { stored = __kwStoredTimes(oracle, l, times); }
    catch (eO) { return { problems: [label + ": " + __pwMsg(eO)] }; }
    for (var d = 0; d < keys.length; d++) {
      if (stored[d] === null) {
        var other = keys[d + 1] || keys[d - 1];
        problems.push(__kwAt(plan, keys[d]) + " lands on the same After Effects key as " + (other ? __kwAt(plan, other) : "another key of this track") + " (After Effects stores both at one time on this layer and keeps one key there) — pass one");
        continue;
      }
      keys[d].st = stored[d];
    }
  }
  for (var e2 = 0; e2 < keys.length; e2++) {
    var en = keys[e2];
    if (en.st === undefined) continue;
    // An existing key stored at that time: a merge updates it (keeping what is
    // not passed); a replace overwrites it with a fully specified key. The
    // write still goes at the REQUESTED time — After Effects lands it on that
    // key — so a prediction that were ever wrong shows up in the readback as a
    // key count that does not add up, never as a silent write elsewhere.
    var match = __kwSearch(original.keys, en.st, "t");
    var meta = __kwMeta(en.key, info, (match >= 0 && track.mode === "merge") ? original.keys[match] : null);
    if (meta.problem) { problems.push(__kwAt(plan, en) + ": " + meta.problem); continue; }
    en.wt = en.t;
    en.s = meta.spec;
    en.m = match;
    delete en.key;
  }
  if (!problems.length && p.matchName === "ADBE Mask Shape") {
    var mc = __kwMaskCountProblems(plan, original, keys, label);
    for (var mq = 0; mq < mc.length; mq++) problems.push(mc[mq]);
  }
  if (problems.length) return { problems: problems };
  var matched = 0;
  var used = {};
  for (var k2 = 0; k2 < keys.length; k2++) if (keys[k2].m >= 0) { matched++; used[keys[k2].m] = true; }
  plan.layer = l;
  plan.path = track.path;
  plan.mode = track.mode;
  plan.label = label;
  plan.identity = l.id + ":" + __pwIdentity(p);
  plan.name = p.name;
  plan.matchName = p.matchName;
  plan.vt = vt;
  plan.info = info;
  plan.spatial = spatial;
  plan.exprOn = exprOn;
  plan.compTime = c.time;
  plan.original = original;
  plan.keys = keys;
  plan.matched = matched;
  plan.used = used;
  plan.expectedCount = track.mode === "merge" ? original.numKeys + keys.length - matched : keys.length;
  return plan;
}

// ---------------------------------------------------------------- write

// Write `values` at `times` (both sorted), then — when `keep` is given —
// remove every key not stored at one of the times in `keep` (sorted, exact
// stored times), so a Time Remap never passes through zero keys. A neighbour
// one storage step from a written key is a different key and goes.
function __kwReconcile(p, times, values, keep) {
  p.setValuesAtTimes(times, values);
  if (!keep) return;
  for (var k = p.numKeys; k >= 1; k--) {
    if (!__kwHasTime(keep, p.keyTime(k))) p.removeKey(k);
  }
}

function __kwApplyTrack(plan) {
  var p = walkProperty(plan.layer, plan.path);
  var times = [], values = [];
  var keep = plan.mode === "replace" ? [] : null;
  for (var i = 0; i < plan.keys.length; i++) {
    times.push(plan.keys[i].wt); values.push(plan.keys[i].w);
    if (keep) keep.push(plan.keys[i].st);
  }
  __kwReconcile(p, times, values, keep);
  // Indices are computed, not looked up: after a replace the keys are exactly
  // the plan's; after a merge they are the plan's and the untouched originals,
  // interleaved in time order.
  var orig = plan.original.keys;
  var o = 0, before = 0;
  for (var j = 0; j < plan.keys.length; j++) {
    var e = plan.keys[j];
    if (plan.mode === "merge") {
      while (o < orig.length && orig[o].t < e.st) { if (!plan.used[o]) before++; o++; }
    }
    var k = j + 1 + before;
    if (k > p.numKeys || p.keyTime(k) !== e.st) {
      throw new Error(__kwAt(plan, e) + ": the key written at " + e.wt + "s is not where After Effects stores that time (" + e.st + "s, index " + k + ")");
    }
    __kwApplyMeta(p, k, e.s, plan.info);
  }
}

// Read the track back, key by key, and compare it with the plan without
// keeping what was read. Returns {problems, count, first, last, rescaled, changed}.
function __kwVerifyTrack(plan, fd) {
  var p = walkProperty(plan.layer, plan.path);
  var problems = [];
  var n = p.numKeys;
  if (n !== plan.expectedCount) problems.push("has " + n + " keys, expected " + plan.expectedCount);
  var orig = plan.original.keys;
  var j = 0, o = 0, rescaled = 0;
  var changed = (plan.keys.length > plan.matched) || (plan.mode === "replace" && plan.original.numKeys > plan.matched);
  var out = { count: n };
  for (var k = 1; k <= n; k++) {
    var s = __kwReadKey(p, k, plan.spatial);
    if (k === 1) out.first = __kwEnd(s, plan.vt, fd, plan.timeBase);
    if (k === n) out.last = __kwEnd(s, plan.vt, fd, plan.timeBase);
    if (j < plan.keys.length && s.t === plan.keys[j].st) {
      var e = plan.keys[j];
      var bad = __kwKeyMismatches(s, e, plan.vt);
      if (bad.length) problems.push(__kwAt(plan, e) + ": " + bad.join("; "));
      if (!changed && e.m >= 0 && __kwStateDiffers(orig[e.m], s, plan.vt)) changed = true;
      j++;
      continue;
    }
    if (plan.mode === "merge") {
      while (o < orig.length && plan.used[o]) o++;
      if (o < orig.length && orig[o].t === s.t) {
        var ok = orig[o];
        var bad2 = __kwUntouchedMismatches(s, ok, plan.vt);
        if (bad2.length) problems.push("untouched key at " + ok.t + "s: " + bad2.join("; "));
        else if (!ok.tab && ((ok.inI === "bezier" && !__kwSameEase(s.easeIn, ok.easeIn)) || (ok.outI === "bezier" && !__kwSameEase(s.easeOut, ok.easeOut)))) rescaled++;
        o++;
        continue;
      }
    }
    problems.push("an unexpected key at " + s.t + "s");
  }
  for (; j < plan.keys.length; j++) problems.push(__kwAt(plan, plan.keys[j]) + ": no key there");
  if (plan.mode === "merge") {
    for (; o < orig.length; o++) if (!plan.used[o]) problems.push("untouched key at " + orig[o].t + "s is gone");
  }
  var ex = __kwExpressionState(p);
  if (ex.text !== plan.original.expression.text || ex.enabled !== plan.original.expression.enabled) {
    problems.push("its expression changed, which this tool never does");
  }
  out.problems = problems;
  out.rescaled = rescaled;
  out.changed = changed;
  return out;
}

// ---------------------------------------------------------------- rollback

// Whether a captured key's ease can be written back: an auto-Bezier key's is
// AE's own, and an influence outside 0.1..100 is one no setter takes — yet AE
// produces 0 itself, on a first or last key a script switched from Linear to
// Bezier (measured). Such a key's ease is left as AE has it and then compared,
// so a restore that could not rebuild it says so.
function __kwEaseSettable(s) {
  if (s.tab) return false;
  var all = s.easeIn.concat(s.easeOut);
  for (var i = 1; i < all.length; i += 2) if (!(all[i] >= 0.1 && all[i] <= 100)) return false;
  return true;
}

function __kwRestoreKeyMeta(p, k, s, info) {
  var BZ = KeyframeInterpolationType.BEZIER;
  if (s.tab) {
    if (p.keyInInterpolationType(k) !== BZ || p.keyOutInterpolationType(k) !== BZ) p.setInterpolationTypeAtKey(k, BZ, BZ);
    if (!p.keyTemporalAutoBezier(k)) p.setTemporalAutoBezierAtKey(k, true);
  } else {
    if (p.keyTemporalAutoBezier(k)) p.setTemporalAutoBezierAtKey(k, false);
    if (!!p.keyTemporalContinuous(k) !== s.tc) p.setTemporalContinuousAtKey(k, s.tc);
    if (__kwEaseSettable(s) && !(__kwSameEase(__kwEaseFlat(p.keyInTemporalEase(k)), s.easeIn) && __kwSameEase(__kwEaseFlat(p.keyOutTemporalEase(k)), s.easeOut))) {
      p.setTemporalEaseAtKey(k, __kwEaseObjects(s.easeIn), __kwEaseObjects(s.easeOut));
    }
    var wi = __INTERP_MAP[s.inI], wo = __INTERP_MAP[s.outI];
    if (p.keyInInterpolationType(k) !== wi || p.keyOutInterpolationType(k) !== wo) p.setInterpolationTypeAtKey(k, wi, wo);
  }
  if (info.spatialOptions) {
    if (!!p.keySpatialAutoBezier(k) !== s.sab) p.setSpatialAutoBezierAtKey(k, s.sab);
    if (!!p.keySpatialContinuous(k) !== s.sc) p.setSpatialContinuousAtKey(k, s.sc);
    if (!s.sab && !(__kwSameVec(p.keyInSpatialTangent(k), s.inT) && __kwSameVec(p.keyOutSpatialTangent(k), s.outT))) {
      p.setSpatialTangentsAtKey(k, s.inT, s.outT);
    }
    if (p.keyRoving(k)) p.setRovingAtKey(k, false);
  }
  if (p.keyLabel(k) !== s.label) p.setLabelAtKey(k, s.label);
}

// Put one track's animation back as captured, then read it back. Returns the
// list of what still differs.
function __kwRestoreTrack(plan, oracle) {
  var p = walkProperty(plan.layer, plan.path);
  var o = plan.original;
  var bad = [];
  if (o.numKeys === 0) {
    while (p.numKeys > 0) p.removeKey(p.numKeys);
    p.setValue(o.staticRaw);
  } else {
    // Each key goes back at a time After Effects stores exactly at its
    // original stored time — usually that time itself; on a stretched layer
    // far from 0 a searched one (see __kwWriteTimeFor). Every original time is
    // kept; anything else this call made is removed.
    var times = [], values = [], keep = [];
    for (var i = 0; i < o.keys.length; i++) {
      var wt = null;
      try { wt = __kwWriteTimeFor(oracle, plan.layer, o.keys[i].t); } catch (eW) { wt = null; }
      if (wt === null) { bad.push("key " + (i + 1) + " (" + o.keys[i].t + "s): no time could be found that After Effects stores there, so it was written at its own time"); wt = o.keys[i].t; }
      times.push(wt); values.push(o.keys[i].raw); keep.push(o.keys[i].t);
    }
    __kwReconcile(p, times, values, keep);
    // Key by key, so one that cannot be restored does not stop the rest.
    for (var k = 1; k <= o.keys.length && k <= p.numKeys; k++) {
      try { __kwRestoreKeyMeta(p, k, o.keys[k - 1], plan.info); }
      catch (eK) { bad.push("key " + k + " (" + o.keys[k - 1].t + "s): " + __pwMsg(eK)); }
    }
  }
  // Read back.
  var p2 = walkProperty(plan.layer, plan.path);
  if (p2.numKeys !== o.numKeys) bad.push("has " + p2.numKeys + " keys, had " + o.numKeys);
  else if (o.numKeys === 0) {
    var now = __pwSerialize(plan.vt, __pwRead(p2, plan.exprOn, plan.compTime));
    if (!__pwSame(o.staticValue, now)) bad.push("value reads " + __pwJson(now) + ", was " + __pwJson(o.staticValue));
  } else {
    for (var q = 1; q <= o.numKeys; q++) {
      var was = o.keys[q - 1];
      var is = __kwReadKey(p2, q, plan.spatial);
      var m = [];
      if (is.t !== was.t) m.push("time (reads " + is.t + ")");
      if (!__pwSame(__kwValueOf(was, plan.vt), __kwValueOf(is, plan.vt))) m.push("value");
      if (is.inI !== was.inI || is.outI !== was.outI) m.push("interpolation");
      if (is.tc !== was.tc || is.tab !== was.tab) m.push("temporal flags");
      if (is.label !== was.label) m.push("label");
      if (!was.tab) {
        // Compared even where it could not be written: an influence of 0 is a
        // real curve, and a restore that lost it has not restored the key.
        var why = __kwEaseSettable(was) ? "" : " (it held an influence outside 0.1..100, which no After Effects setter accepts)";
        if (was.inI === "bezier" && !__kwSameEase(is.easeIn, was.easeIn)) m.push("easeIn reads " + __pwJson(__kwEaseShow(is.easeIn)) + ", was " + __pwJson(__kwEaseShow(was.easeIn)) + why);
        if (was.outI === "bezier" && !__kwSameEase(is.easeOut, was.easeOut)) m.push("easeOut reads " + __pwJson(__kwEaseShow(is.easeOut)) + ", was " + __pwJson(__kwEaseShow(was.easeOut)) + why);
      }
      if (plan.info.spatialOptions) {
        if (is.sab !== was.sab || is.sc !== was.sc || is.roving !== was.roving) m.push("spatial flags");
        if (!was.sab && !(__kwSameVec(is.inT, was.inT) && __kwSameVec(is.outT, was.outT))) m.push("spatial tangents");
      }
      if (m.length) bad.push("key " + q + " (" + was.t + "s) differs in " + m.join(", "));
    }
  }
  var ex = __kwExpressionState(p2);
  if (ex.text !== o.expression.text || ex.enabled !== o.expression.enabled) bad.push("expression differs");
  return bad;
}

function __kwRollback(touched, oracle) {
  var notes = [];
  var clean = true;
  for (var i = touched.length - 1; i >= 0; i--) {
    var plan = touched[i];
    var where = "track " + plan.trackNumber + " (" + plan.label + ")";
    try {
      var bad = __kwRestoreTrack(plan, oracle);
      if (bad.length) { clean = false; notes.push(where + " NOT fully restored: " + bad.slice(0, 6).join("; ") + (bad.length > 6 ? " (+" + (bad.length - 6) + " more)" : "")); }
      else notes.push(where + " restored (" + plan.original.numKeys + " key" + (plan.original.numKeys === 1 ? "" : "s") + ")");
    } catch (e) {
      clean = false;
      notes.push(where + " NOT restored (" + __pwMsg(e) + ")");
    }
  }
  return { clean: clean, notes: notes };
}

// ---------------------------------------------------------------- op

function __kwSummaryValue(vt, v) {
  if (vt === "SHAPE" && v) return { vertices: v.vertices ? v.vertices.length : 0, closed: v.closed };
  return v;
}

function __kwEnd(s, vt, fd, timeBase) {
  var e = { time: s.t, value: __kwSummaryValue(vt, __kwValueOf(s, vt)) };
  if (timeBase === "frames") e.frame = __kwFrameOf(s.t, fd);
  return e;
}

function __kwJoinProblems(list) {
  if (list.length <= __KW_MAX_PROBLEMS) return list.join("; ");
  return list.slice(0, __KW_MAX_PROBLEMS).join("; ") + "; and " + (list.length - __KW_MAX_PROBLEMS) + " more problem(s)";
}

OPS.set_keyframes = function (args) {
  var started = new Date().getTime();
  var c = getCompById(args.compId);
  var tracks = args.tracks;
  if (!__pwIsArray(tracks) || tracks.length < 1 || tracks.length > __KW_MAX_TRACKS) {
    throw new Error("set_keyframes: `tracks` must hold 1 to " + __KW_MAX_TRACKS + " tracks. Nothing was changed.");
  }
  var fd = c.frameDuration;

  // ---- One time base per request ----
  var timeBase = null, total = 0, baseProblems = [];
  for (var a = 0; a < tracks.length; a++) {
    var tk = tracks[a] || {};
    if (!__pwIsArray(tk.keys)) continue;
    if (tk.keys.length > __KW_MAX_KEYS_PER_TRACK) baseProblems.push("track " + (a + 1) + " has " + tk.keys.length + " keys; the limit is " + __KW_MAX_KEYS_PER_TRACK + " per track");
    total += tk.keys.length;
    for (var b = 0; b < tk.keys.length; b++) {
      var kk = tk.keys[b] || {};
      var hasF = kk.frame !== undefined, hasT = kk.time !== undefined;
      if (hasF === hasT) { baseProblems.push("track " + (a + 1) + " key " + (b + 1) + " needs exactly one of `frame` or `time`" + (hasF ? " — it has both" : "")); continue; }
      var base = hasF ? "frames" : "seconds";
      if (timeBase === null) timeBase = base;
      else if (base !== timeBase) {
        baseProblems.push("track " + (a + 1) + " key " + (b + 1) + " uses `" + (hasF ? "frame" : "time") + "` while earlier keys use `" + (hasF ? "time" : "frame") + "` — one request uses one time base, frames or seconds");
      }
    }
  }
  if (total > __KW_MAX_TOTAL_KEYS) baseProblems.push(total + " keys in total; the limit is " + __KW_MAX_TOTAL_KEYS + " per call — split it into several calls");
  if (baseProblems.length) {
    throw new Error("set_keyframes: " + __kwJoinProblems(baseProblems) + ". Nothing was changed.");
  }

  // Where After Effects stores key times is asked of a scratch comp (see
  // "Stored key times"); it exists only for this call, success or failure.
  var oracle;
  try { oracle = __kwOracleOpen(c); }
  catch (eOpen) {
    throw new Error("set_keyframes: the key-time check could not be prepared (" + __pwMsg(eOpen) + "). The animation was not applied — nothing was written to any of your properties." + (eOpen.cleanup ? " " + eOpen.cleanup : ""));
  }
  var result = null, failure = null;
  try { result = __kwSetKeyframes(c, tracks, fd, timeBase, total, started, oracle); }
  catch (eRun) { failure = eRun; }
  var leftover = __kwOracleClose(oracle);
  if (failure) {
    // The original error stays first and whole; the cleanup is added to it.
    if (!leftover) throw failure;
    throw new Error(__pwMsg(failure) + " " + __kwOutcomeSentence(oracle.outcome) + " " + leftover);
  }
  if (leftover) {
    result.scratchCompLeftover = true;
    result.warning = "The animation WAS applied, exactly as the tracks above report. " + leftover;
  }
  return result;
};

function __kwSetKeyframes(c, tracks, fd, timeBase, total, started, oracle) {
  oracle.outcome = "refused";
  // ---- Preflight: every track, every key, nothing written ----
  var plans = [], problems = [], seen = {};
  for (var i = 0; i < tracks.length; i++) {
    var tr = tracks[i] || {};
    var where = "track " + (i + 1) + " (layer " + tr.layerId + ", " + (__pwIsArray(tr.path) ? __propertyPathLabel(tr.path) : "no path") + ")";
    if (!__pwIsArray(tr.path) || !tr.path.length) { problems.push(where + ": needs a non-empty `path`"); continue; }
    var l;
    try { l = getLayerById(c, tr.layerId); } catch (eL) { problems.push(where + ": " + __pwMsg(eL)); continue; }
    var plan = __kwPlanTrack(c, l, tr, fd, timeBase, oracle);
    if (plan.problems) {
      for (var pi = 0; pi < plan.problems.length; pi++) problems.push(where + ": " + plan.problems[pi]);
      continue;
    }
    if (seen[plan.identity] !== undefined) {
      problems.push(where + ": resolves to the same property as track " + (seen[plan.identity] + 1) + " — one track per property; put all its keys in one track");
      continue;
    }
    seen[plan.identity] = i;
    plan.trackNumber = i + 1;
    plans.push(plan);
  }
  if (problems.length) {
    throw new Error("set_keyframes: " + __kwJoinProblems(problems) + ". Nothing was changed.");
  }

  // ---- Write, verify, roll everything back on the first failure ----
  var timing = { preflightMs: new Date().getTime() - started, writeMs: 0, verifyMs: 0 };
  oracle.outcome = "writing";
  var touched = [];
  var results = [];
  for (var w = 0; w < plans.length; w++) {
    var pl = plans[w];
    var failure = null;
    touched.push(pl);
    var ver = null;
    try {
      var tw = new Date().getTime();
      __kwApplyTrack(pl);
      var tv = new Date().getTime();
      timing.writeMs += tv - tw;
      ver = __kwVerifyTrack(pl, fd);
      timing.verifyMs += new Date().getTime() - tv;
      if (ver.problems.length) failure = "the keys did not land as asked: " + ver.problems.slice(0, 8).join("; ") + (ver.problems.length > 8 ? " (+" + (ver.problems.length - 8) + " more)" : "");
    } catch (eA) {
      failure = "After Effects refused it: " + __pwMsg(eA);
    }
    if (failure) {
      var rb = __kwRollback(touched, oracle);
      oracle.outcome = rb.clean ? "rolled back" : "rollback incomplete";
      throw new Error(
        "set_keyframes: track " + pl.trackNumber + " (layer " + pl.layer.id + ", " + __propertyPathLabel(pl.path) + ", " + pl.label + ") failed — " + failure + ". " +
        (rb.clean ? "Rolled back every track this call touched (" + rb.notes.join("; ") + "), so no animation changed." :
          "Rollback was INCOMPLETE: " + rb.notes.join("; ") + ". Read these properties with inspect_property_tree(includeKeys:true) before retrying; Edit > Undo reverts the whole call.")
      );
    }
    var item = {
      layerId: pl.layer.id,
      path: pl.path,
      name: pl.name,
      matchName: pl.matchName,
      valueType: pl.vt,
      mode: pl.mode,
      previousKeyCount: pl.original.numKeys,
      actualKeyCount: ver.count,
      keysWritten: pl.keys.length,
      keysAdded: pl.keys.length - pl.matched,
      keysUpdated: pl.matched,
      changed: ver.changed
    };
    if (pl.mode === "replace") item.keysRemoved = pl.original.numKeys - pl.matched;
    if (ver.first) { item.first = ver.first; item.last = ver.last; }
    if (ver.rescaled) {
      item.neighbourEaseRescaled = ver.rescaled;
      item.neighbourEaseNote = "After Effects rescaled the ease influence of " + ver.rescaled + " untouched key(s) next to an inserted one, to keep the curve's shape — its own behaviour, the same as in the timeline. Their values, times, interpolation and flags are unchanged.";
    }
    if (pl.exprOn) {
      item.expressionEnabled = true;
      item.expressionNote = "The keys were written under an enabled expression, which still decides what renders; the expression was left alone.";
    }
    results.push(item);
  }

  var out = {
    compId: c.id,
    timeBase: timeBase,
    frameDuration: fd,
    trackCount: tracks.length,
    totalKeyCount: total,
    appliedTrackCount: results.length,
    tracks: results,
    elapsedMs: new Date().getTime() - started,
    timing: timing
  };
  if (c.displayStartTime) {
    out.displayStartFrame = __kwFrameOf(c.displayStartTime, fd);
    out.displayStartNote = "This comp's timeline starts at frame " + out.displayStartFrame + "; `frame` here counts from the comp's first frame (time 0), not from the displayed number.";
  }
  oracle.outcome = "applied";
  return out;
}
