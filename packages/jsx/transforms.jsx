// transforms.jsx — fast-path for setting common transform properties.
//
// set_transform writes several properties in one call, and nothing rolls back,
// so the whole contract is: **resolve and check every requested property
// before the first write.** A call that would fail part-way — a camera has no
// writable Scale, a 2D layer no writable Orientation, an animated property
// refuses a static setValue — is refused whole, and a refused call changes
// nothing. Measured on 26.5x89 (docs/fragile-areas-ae.md, "Layers and
// transforms"): every one of the eight properties below *exists* on every
// layer kind, writing a property's current value back succeeds even when it is
// hidden, and only a different value throws "the property or a parent property
// is hidden". So existence proves nothing and a trial write proves nothing.

// `time` and `keyframe: true` go together (the schema's TIME_NEEDS_KEYFRAME
// rule). Checked again here because OPS handlers are reachable from run_jsx
// without the schema; never a static write that ignores the time.
function __checkTimeKeyframe(time, keyframe, opName) {
  var hasTime = time !== undefined && time !== null;
  if (hasTime && keyframe !== true) {
    throw new Error(opName + ": `time` needs `keyframe: true` — without it the time would be ignored. Nothing was changed.");
  }
  if (keyframe === true && !hasTime) {
    throw new Error(opName + ": `keyframe: true` needs `time`. Nothing was changed.");
  }
  return hasTime;
}

// Keyed when the caller asked for a key, static otherwise. The plan has
// already refused a static write to an animated property.
function __writeTransformValue(prop, value, time, keyed) {
  if (keyed) prop.setValueAtTime(time, value);
  else prop.setValue(value);
}

// Request key -> Transform matchName. `rotation` is Z Rotation on every layer
// kind — a 2D layer's "Rotation" is the same ADBE Rotate Z property.
var __TRANSFORM_KEYS = [
  ["position", "ADBE Position"],
  ["scale", "ADBE Scale"],
  ["rotation", "ADBE Rotate Z"],
  ["anchorPoint", "ADBE Anchor Point"],
  ["opacity", "ADBE Opacity"],
  ["orientation", "ADBE Orientation"],
  ["xRotation", "ADBE Rotate X"],
  ["yRotation", "ADBE Rotate Y"],
  ["zRotation", "ADBE Rotate Z"]
];

// The 3D-only fields, by request key, with the name a caller would recognise.
var __TRANSFORM_3D_ONLY = [
  ["orientation", "Orientation"],
  ["xRotation", "X Rotation"],
  ["yRotation", "Y Rotation"],
  ["zRotation", "Z Rotation"]
];

// Cameras and lights are always 3D but have no `threeDLayer` switch of their
// own — reading it gives undefined, which the old code took for 2D.
function __layerIs3D(l) {
  if (typeof CameraLayer !== "undefined" && l instanceof CameraLayer) return true;
  if (typeof LightLayer !== "undefined" && l instanceof LightLayer) return true;
  return !!l.threeDLayer;
}

function __isAmbientLight(l) {
  if (typeof LightLayer === "undefined" || !(l instanceof LightLayer)) return false;
  try { return l.lightType === LightType.AMBIENT; } catch (e) { return false; }
}

// Whether After Effects will accept a new value on `prop`. `canSetExpression`
// tracks the hidden state exactly across 2D/3D AV, text, shape, null, one- and
// two-node cameras and parallel/spot/point lights — measured property by
// property on 26.5x89 — with one exception: an ambient light reports
// canSetExpression on X/Y Rotation although its whole Transform group refuses
// writes. Hence the explicit check, which is measured, not guessed.
function __transformWritable(l, prop) {
  if (__isAmbientLight(l)) return false;
  try { return prop.canSetExpression === true; } catch (e) { return false; }
}

function __layerLabel(l) {
  var kind = "layer";
  if (typeof CameraLayer !== "undefined" && l instanceof CameraLayer) kind = "camera";
  else if (typeof LightLayer !== "undefined" && l instanceof LightLayer) kind = "light";
  return kind + " " + l.id + " (\"" + l.name + "\")";
}

// Resolve every requested property and check every one of them. Returns the
// writes to make, in request order; throws, naming every problem, if any of
// them cannot be made. Nothing here writes.
function __transformPlan(l, tr, p, keyed) {
  // 2D first, with the message that names the fix — the generic hidden check
  // below would also catch these, but less helpfully.
  if (!__layerIs3D(l)) {
    var only3D = [];
    for (var i = 0; i < __TRANSFORM_3D_ONLY.length; i++) {
      if (p[__TRANSFORM_3D_ONLY[i][0]] !== undefined) {
        only3D.push(__TRANSFORM_3D_ONLY[i][1] + " (" + __TRANSFORM_3D_ONLY[i][0] + ")");
      }
    }
    if (only3D.length) {
      throw new Error(
        "Layer " + l.id + " (\"" + l.name + "\") is 2D; " + only3D.join(", ") + " " +
        (only3D.length === 1 ? "requires" : "require") + " threeDLayer:true. Set it with " +
        "set_layer({threeDLayer:true}) first, or use `rotation` for a 2D layer. Nothing was changed."
      );
    }
  }

  var writes = [];
  var problems = [];
  var byMatch = {};
  for (var k = 0; k < __TRANSFORM_KEYS.length; k++) {
    var key = __TRANSFORM_KEYS[k][0];
    var match = __TRANSFORM_KEYS[k][1];
    var value = p[key];
    if (value === undefined) continue;

    // Two keys for one property (rotation + zRotation): whichever was written
    // last would silently win.
    if (byMatch[match]) {
      problems.push(byMatch[match] + " and " + key + " both set " + match.replace("ADBE ", "") + "; pass one of them");
      continue;
    }
    byMatch[match] = key;

    var prop = null;
    try { prop = tr.property(match); } catch (eProp) { prop = null; }
    if (!prop) { problems.push(key + ": this layer has no " + match + " property"); continue; }
    var label = key + " (" + prop.name + ")";

    if (key === "position") {
      var separated = false;
      try { separated = !!prop.dimensionsSeparated; } catch (eSep) { separated = false; }
      if (separated) {
        problems.push(
          "position: Position has its dimensions separated, so it cannot be set as one value — key " +
          "[\"Transform\",\"X Position\"] / [\"Transform\",\"Y Position\"] with add_keyframe instead"
        );
        continue;
      }
    }
    if (!__transformWritable(l, prop)) {
      problems.push(label + " is not settable on this " + (__isAmbientLight(l) ? "ambient light" : "layer"));
      continue;
    }
    // A static setValue on a keyed property throws, after whatever came before
    // it had already landed.
    var numKeys = 0;
    try { numKeys = prop.numKeys; } catch (eKeys) { numKeys = 0; }
    if (!keyed && numKeys > 0) {
      problems.push(label + " is animated (" + numKeys + " keys), so it has no single static value — pass time with keyframe:true to key it");
      continue;
    }
    // Shape of the value: AE throws on a scalar for a vector property and the
    // other way round, again after earlier writes landed.
    var current = null;
    try { current = prop.value; } catch (eVal) { current = null; }
    var isVector = current !== null && typeof current === "object" && current.length !== undefined;
    if (isVector) {
      if (!(value instanceof Array) || value.length < 2 || value.length > current.length) {
        problems.push(label + " takes 2" + (current.length > 2 ? " or " + current.length : "") + " numbers");
        continue;
      }
    } else if (typeof value !== "number") {
      problems.push(label + " takes a single number");
      continue;
    }
    writes.push({ key: key, prop: prop, value: value });
  }

  if (problems.length) {
    throw new Error(
      "set_transform on " + __layerLabel(l) + ": " + problems.join("; ") + ". Nothing was changed."
    );
  }
  return writes;
}

OPS.set_transform = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var keyed = __checkTimeKeyframe(args.time, args.keyframe, "set_transform");
  var tr = l.property("ADBE Transform Group");
  var writes = __transformPlan(l, tr, args.properties || {}, keyed);
  var applied = [];
  for (var i = 0; i < writes.length; i++) {
    __writeTransformValue(writes[i].prop, writes[i].value, args.time, keyed);
    applied.push(writes[i].key);
  }
  return { ok: true, applied: applied, keyed: keyed };
};
