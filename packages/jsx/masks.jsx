// masks.jsx — layer mask ops.
//
// Both writers check everything they can before the first write, because
// nothing rolls back: add_mask removes the one mask it created if anything
// after the creation fails, and set_mask refuses a call it could only half
// apply (an animated property cannot take a static value, and a tangent list
// that does not match the vertex count makes AE throw on the path).

// Throws unless every tangent list matches the vertex count it will be paired with.
function __checkMaskTangents(vertexCount, inT, outT, opName) {
  var bad = [];
  if (inT && inT.length !== vertexCount) bad.push("inTangents has " + inT.length);
  if (outT && outT.length !== vertexCount) bad.push("outTangents has " + outT.length);
  if (bad.length) {
    throw new Error(
      opName + ": the path has " + vertexCount + " vertices but " + bad.join(" and ") +
      " — each tangent list needs one entry per vertex. Nothing was changed."
    );
  }
}

function __maskTangentsOr(existing, count) {
  if (existing && existing.length) return existing;
  var z = [];
  for (var i = 0; i < count; i++) z.push([0, 0]);
  return z;
}

OPS.add_mask = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  // Everything that can be known before the mask exists is checked first, so
  // a refusal here costs nothing at all.
  var mode = args.mode ? __enumByName(MaskMode, "MaskMode", args.mode, "mode") : null;
  if (!args.vertices || args.vertices.length === 0) {
    throw new Error("add_mask: a mask needs at least one vertex. Nothing was changed.");
  }
  __checkMaskTangents(args.vertices.length, args.inTangents, args.outTangents, "add_mask");
  var masksGroup = l.property("ADBE Mask Parade");
  if (!masksGroup) throw new Error("add_mask: layer " + args.layerId + " cannot hold masks. Nothing was changed.");

  var created = masksGroup.addProperty("ADBE Mask Atom");
  if (!created) throw new Error("add_mask: After Effects did not create a mask. Nothing was changed.");
  // Held as an index, never as a handle across the writes below: the mask
  // this call made is the only one it may remove.
  var index = created.propertyIndex;
  var step = "path";
  try {
    var m = masksGroup.property(index);
    var shape = new Shape();
    shape.vertices = args.vertices;
    if (args.inTangents) shape.inTangents = args.inTangents;
    if (args.outTangents) shape.outTangents = args.outTangents;
    shape.closed = args.closed !== false;
    m.property("ADBE Mask Shape").setValue(shape);
    if (mode !== null) {
      step = "mode";
      m.maskMode = mode;
    }
    return { ok: true, maskIndex: index };
  } catch (e) {
    var removed = false;
    try {
      var mine = masksGroup.property(index);
      if (mine && mine.matchName === "ADBE Mask Atom") { mine.remove(); removed = true; }
    } catch (eRm) {}
    var msg = (e && e.message) ? String(e.message) : String(e);
    throw new Error(
      "add_mask failed setting the mask's " + step + ": " + msg + ". " +
      (removed ? "The mask it created was removed, so nothing changed."
               : "The mask it created (index " + index + ") could not be removed — check the layer's masks before retrying.")
    );
  }
};

OPS.set_mask = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var m = l.property("ADBE Mask Parade").property(args.maskIndex);
  if (!m) throw new Error("No mask " + args.maskIndex + " on layer " + args.layerId + ". Nothing was changed.");
  var mode = args.mode ? __enumByName(MaskMode, "MaskMode", args.mode, "mode") : null;

  // Any of the four path fields changes the path — tangents and `closed` used
  // to be ignored unless `vertices` came with them.
  var touchesPath = args.vertices !== undefined || args.inTangents !== undefined ||
    args.outTangents !== undefined || args.closed !== undefined;
  var pathProp = m.property("ADBE Mask Shape");
  var statics = [];
  if (touchesPath) statics.push(["path", pathProp]);
  if (args.expansion !== undefined) statics.push(["expansion", m.property("ADBE Mask Offset")]);
  if (args.feather !== undefined) statics.push(["feather", m.property("ADBE Mask Feather")]);
  if (args.opacity !== undefined) statics.push(["opacity", m.property("ADBE Mask Opacity")]);
  var animated = [];
  for (var i = 0; i < statics.length; i++) {
    if (statics[i][1].numKeys > 0) animated.push(statics[i][0] + " (" + statics[i][1].numKeys + " keys)");
  }
  if (animated.length) {
    throw new Error(
      "set_mask: mask " + args.maskIndex + " has animated " + animated.join(", ") + ", which cannot take a static " +
      "value — key it with add_keyframe instead. Nothing was changed."
    );
  }
  var sh = null;
  if (touchesPath) {
    // Read, check, and only then build — nothing is assigned onto the current
    // path value until every field has been validated.
    var cur = pathProp.value;
    var verts = args.vertices !== undefined ? args.vertices : cur.vertices;
    // A path built without tangents has none to carry over; zero tangents are
    // what AE draws for it anyway (straight segments).
    var inT = args.inTangents !== undefined ? args.inTangents : __maskTangentsOr(cur.inTangents, verts.length);
    var outT = args.outTangents !== undefined ? args.outTangents : __maskTangentsOr(cur.outTangents, verts.length);
    if (!verts || verts.length === 0) throw new Error("set_mask: a mask needs at least one vertex. Nothing was changed.");
    if (inT.length !== verts.length || outT.length !== verts.length) {
      throw new Error(
        "set_mask: the path would have " + verts.length + " vertices with " + inT.length + " inTangents and " +
        outT.length + " outTangents — pass inTangents and outTangents with one entry per vertex. Nothing was changed."
      );
    }
    // Assigned onto the value read back (AE returns a copy), never a fresh
    // Shape: the path also carries the mask's variable-width feather points
    // (featherRadii, featherSegLocs, …), and a new Shape would drop them.
    sh = cur;
    sh.vertices = verts;
    sh.inTangents = inT;
    sh.outTangents = outT;
    sh.closed = args.closed !== undefined ? args.closed : cur.closed;
  }

  if (sh !== null) pathProp.setValue(sh);
  if (mode !== null) m.maskMode = mode;
  if (args.inverted !== undefined) m.inverted = args.inverted;
  if (args.expansion !== undefined) m.property("ADBE Mask Offset").setValue(args.expansion);
  if (args.feather !== undefined) m.property("ADBE Mask Feather").setValue(args.feather);
  if (args.opacity !== undefined) m.property("ADBE Mask Opacity").setValue(args.opacity);
  return { ok: true };
};

OPS.remove_mask = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var m = l.property("ADBE Mask Parade").property(args.maskIndex);
  if (!m) throw new Error("No mask " + args.maskIndex + " on layer " + args.layerId + ". Nothing was changed.");
  m.remove();
  return { ok: true };
};
