// structure.jsx — composition structure: the structural read, moving a layer,
// parenting, track mattes by explicit source, and precompose.
//
// Measured on AE 26.5x89 (docs/fragile-areas-ae.md, "Layer structure"; recipes
// 54-56), and every rule below follows from one of these:
//
//   - layer.id survives reorder, parenting, duplication (the copy gets a new
//     one) and precompose with moveAllAttributes:false. It does NOT survive
//     precompose with moveAllAttributes:true: every moved layer is recreated
//     inside the new comp with a new id, the old handles go invalid, and the
//     replacement layer in the outer comp is new too. Indexes shift on all of
//     these, so ids are the only identity these ops accept or return.
//   - moveBefore/moveAfter/moveToBeginning/moveToEnd take a layer, never an
//     index. AE refuses a layer moved relative to itself and any move of a
//     locked layer.
//   - A modern track matte names its source. Reordering the source anywhere —
//     above, below, top, bottom — keeps the relationship and the source id.
//     Deleting the source clears the target's matte silently.
//   - precompose(indices, name, moveAll) returns the new CompItem, files it in
//     the outer comp's folder, gives it the outer comp's size, duration and
//     frame rate (moveAll:true) or the layer source's size (moveAll:false), and
//     puts the replacement layer at the index of the topmost selected layer.
//     What it does to relationships crossing the selection is where it damages
//     silently — see __precomposeHazards.

// ---------------------------------------------------------------------------
// get_layer_structure
// ---------------------------------------------------------------------------

function __sourceItemType(l) {
  var s = null;
  try { s = l.source; } catch (e) { s = null; }
  if (!s) return null;
  if (s instanceof CompItem) return "comp";
  if (s instanceof FootageItem) return __footageKind(s);
  return "unknown";
}

// A camera or light has no threeDLayer/adjustmentLayer/guideLayer of its own;
// null says "not applicable" rather than inventing a false.
function __flagOrNull(l, name) {
  var v;
  try { v = l[name]; } catch (e) { return null; }
  return (v === undefined) ? null : v;
}

function __structureRecord(l, children, matteFor) {
  var src = null;
  try { src = l.source; } catch (e) { src = null; }
  var tm = __trackMatteState(l);
  return {
    layerId: l.id,
    index: l.index,
    name: l.name,
    sourceType: __layerKind(l),
    sourceItemId: src ? src.id : null,
    sourceItemType: __sourceItemType(l),
    parentLayerId: l.parent ? l.parent.id : null,
    childLayerIds: children[l.id] || [],
    threeDLayer: __flagOrNull(l, "threeDLayer"),
    enabled: l.enabled,
    locked: l.locked,
    shy: l.shy,
    adjustmentLayer: __flagOrNull(l, "adjustmentLayer"),
    guideLayer: __flagOrNull(l, "guideLayer"),
    trackMatte: tm.layerId === null ? null : { sourceLayerId: tm.layerId, type: tm.type },
    isTrackMatte: matteFor[l.id] ? true : false,
    matteForLayerIds: matteFor[l.id] || [],
    // startTime/inPoint/outPoint/stretch, the source's length and the Time
    // Remap state (timing.jsx) — what set_layer_timing and set_time_remap act on.
    timing: __timingRecord(l)
  };
}

OPS.get_layer_structure = noUndo(function (args) {
  var c = getCompById(args.compId);
  var max = args.maxLayers || 500;
  var n = c.numLayers;
  // Children and matte users are computed over the whole comp even when the
  // listing is capped, so a listed layer's relationships are always complete.
  var children = {}, matteFor = {};
  for (var i = 1; i <= n; i++) {
    var l = c.layer(i);
    if (l.parent) (children[l.parent.id] = children[l.parent.id] || []).push(l.id);
    var tm = __trackMatteState(l);
    if (tm.layerId !== null) (matteFor[tm.layerId] = matteFor[tm.layerId] || []).push(l.id);
  }
  var layers = [];
  for (var j = 1; j <= n && j <= max; j++) layers.push(__structureRecord(c.layer(j), children, matteFor));
  var out = { compId: c.id, compName: c.name, numLayers: n, frameDuration: c.frameDuration, duration: c.duration, layers: layers, truncated: n > max };
  if (n > max) {
    out.truncation = { listed: max, omitted: n - max, nextUnlistedIndex: max + 1,
      note: "Layers are listed front to back; raise maxLayers to see the rest. childLayerIds and matteForLayerIds still name unlisted layers." };
  }
  return out;
});

// ---------------------------------------------------------------------------
// move_layer
// ---------------------------------------------------------------------------

function __neighbors(c, l) {
  var i = l.index;
  return {
    aboveLayerId: i > 1 ? c.layer(i - 1).id : null,
    belowLayerId: i < c.numLayers ? c.layer(i + 1).id : null
  };
}

OPS.move_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var ref = null, mode;
  if (args.beforeLayerId !== undefined) { mode = "before"; ref = getLayerById(c, args.beforeLayerId); }
  else if (args.afterLayerId !== undefined) { mode = "after"; ref = getLayerById(c, args.afterLayerId); }
  else if (args.to === "beginning" || args.to === "end") { mode = args.to; }
  else throw new Error("move_layer: pass exactly one of beforeLayerId, afterLayerId or to. Nothing was changed.");

  if (ref && ref.id === l.id) {
    throw new Error("move_layer: layer " + l.id + " cannot be moved " + mode + " itself. Nothing was changed.");
  }
  if (l.locked) {
    throw new Error(
      "move_layer: layer " + l.id + " (\"" + l.name + "\") is locked, and After Effects refuses to move a locked layer. " +
      "Unlock it with set_layer locked:false first. Nothing was changed."
    );
  }
  var from = l.index;
  var id = l.id;
  // Already where it was asked to go: no AE call, reported as unchanged.
  var already =
    (mode === "beginning" && from === 1) ||
    (mode === "end" && from === c.numLayers) ||
    (mode === "before" && from === ref.index - 1) ||
    (mode === "after" && from === ref.index + 1);
  if (!already) {
    if (mode === "before") l.moveBefore(ref);
    else if (mode === "after") l.moveAfter(ref);
    else if (mode === "beginning") l.moveToBeginning();
    else l.moveToEnd();
  }

  // Re-fetched by id; the landing is checked against the destination the
  // caller named, not against an index computed beforehand.
  var back = getLayerById(c, id);
  var nb = __neighbors(c, back);
  var ok =
    (mode === "beginning" && back.index === 1) ||
    (mode === "end" && back.index === c.numLayers) ||
    (mode === "before" && nb.belowLayerId === ref.id) ||
    (mode === "after" && nb.aboveLayerId === ref.id);
  if (!ok) {
    throw new Error(
      "move_layer: After Effects placed layer " + id + " at index " + back.index + " (above: " + nb.aboveLayerId +
      ", below: " + nb.belowLayerId + "), which is not " + mode + (ref ? " layer " + ref.id : "") + "."
    );
  }
  return {
    layerId: id,
    previousIndex: from,
    actualIndex: back.index,
    changed: back.index !== from,
    aboveLayerId: nb.aboveLayerId,
    belowLayerId: nb.belowLayerId
  };
};

// ---------------------------------------------------------------------------
// set_layer_parent
// ---------------------------------------------------------------------------

OPS.set_layer_parent = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var np = __planParent(c, l, args.parentLayerId, "set_layer_parent");
  var prev = l.parent ? l.parent.id : null;
  var preserve = args.preserveWorldTransform !== false;
  var out = { layerId: l.id, previousParentLayerId: prev, preserveWorldTransform: preserve };
  if (preserve) out.correction = __parentPreservingWorld(c, l, np);
  else {
    var jump = __parentJump(c, l, np);
    out.localTransformUnchanged = jump.localTransformUnchanged;
    if (!jump.localTransformUnchanged) out.localPropertiesChanged = jump.localPropertiesChanged;
  }
  var back = getLayerById(c, l.id);
  var actual = back.parent ? back.parent.id : null;
  var want = np ? np.id : null;
  if (actual !== want) {
    throw new Error("set_layer_parent: asked for parent " + want + ", After Effects reads " + actual + " on layer " + l.id + ".");
  }
  out.parentLayerId = actual;
  out.changed = actual !== prev;
  return out;
};

// ---------------------------------------------------------------------------
// set_track_matte
// ---------------------------------------------------------------------------

OPS.set_track_matte = function (args) {
  var c = getCompById(args.compId);
  var t = getLayerById(c, args.targetLayerId);
  if (typeof t.setTrackMatte !== "function") {
    throw new Error(
      "set_track_matte: layer " + t.id + " (\"" + t.name + "\") is a camera or light, which cannot take a track matte. Nothing was changed."
    );
  }
  if (t.locked) {
    throw new Error(
      "set_track_matte: layer " + t.id + " (\"" + t.name + "\") is locked. Unlock it with set_layer locked:false first. Nothing was changed."
    );
  }
  var previous = __trackMatteState(t);
  // Explicit source only: matte:null clears, otherwise the source is named. The
  // adjacency fallback set_layer keeps for compatibility is never used here —
  // a plain trackMatteType assignment is measured to pick the layer above.
  var plan = (args.matte === null)
    ? __planTrackMatte(c, t, null)
    : __planTrackMatte(c, t, { type: args.matte.type, layerId: args.matte.sourceLayerId });
  var st = __applyTrackMatte(c, t, plan);
  var back = getLayerById(c, t.id);
  var out = {
    targetLayerId: back.id,
    previous: previous.layerId === null ? null : { sourceLayerId: previous.layerId, type: previous.type },
    trackMatte: st.layerId === null ? null : { sourceLayerId: st.layerId, type: st.type },
    hasTrackMatte: back.hasTrackMatte,
    changed: previous.layerId !== st.layerId || previous.type !== st.type
  };
  if (st.layerId !== null) out.sourceEnabled = st.sourceEnabled;
  if (args.matte === null && previous.layerId !== null) {
    try { out.previousSourceEnabled = getLayerById(c, previous.layerId).enabled; } catch (e) {}
    out.note = "After Effects switched the old matte source's video off when it became a matte and does not switch it back on; previousSourceEnabled is what it reads now.";
  }
  return out;
};

// ---------------------------------------------------------------------------
// precompose_layers
// ---------------------------------------------------------------------------

// Every Property under a layer with a non-empty expression, and every effect
// parameter that names another layer (PropertyValueType.LAYER_INDEX). Bounded:
// the walk stops at __PC_PROP_CAP properties per layer and says so.
var __PC_PROP_CAP = 20000;
function __layerRefs(layer) {
  var out = { expressions: [], layerParams: [], capped: false };
  var seen = 0;
  var LAYER_INDEX = null;
  try { LAYER_INDEX = PropertyValueType.LAYER_INDEX; } catch (e) {}
  function walk(g) {
    var n = 0;
    try { n = g.numProperties; } catch (e) { return; }
    for (var i = 1; i <= n; i++) {
      if (++seen > __PC_PROP_CAP) { out.capped = true; return; }
      var p = null;
      try { p = g.property(i); } catch (e) { continue; }
      if (!p) continue;
      var isProp = false;
      try { isProp = (p.propertyType === PropertyType.PROPERTY); } catch (e) {}
      if (!isProp) { walk(p); if (out.capped) return; continue; }
      try { if (p.canSetExpression && p.expression !== "") out.expressions.push({ name: p.name, text: p.expression }); } catch (e) {}
      try {
        if (LAYER_INDEX !== null && p.propertyValueType === LAYER_INDEX) {
          var v = p.value;
          if (v) out.layerParams.push({ name: p.name, index: v });
        }
      } catch (e) {}
    }
  }
  walk(layer);
  return out;
}

// The layer references an expression makes, as written. Not a parser: it
// finds `layer(` calls and classifies the argument — a string literal is a
// name, an integer literal is an index, anything else is dynamic. The ones it
// cannot classify are what make a precompose unsafe to promise.
function __exprLayerCalls(text) {
  var re = /\blayer\s*\(\s*([^)]*?)\s*\)/g;
  var out = [], m;
  while ((m = re.exec(text)) !== null) {
    var arg = m[1];
    var s = /^"((?:[^"\\]|\\.)*)"$/.exec(arg) || /^'((?:[^'\\]|\\.)*)'$/.exec(arg);
    if (s) out.push({ kind: "name", value: s[1] });
    else if (/^\d+$/.exec(arg)) out.push({ kind: "index", value: Number(arg) });
    else out.push({ kind: "dynamic", value: arg });
  }
  return out;
}
function __exprUsesIndex(text) { return /\bindex\b/.test(text) || /\bnumLayers\b/.test(text); }

// What precompose would do to everything around the selection, decided before
// anything moves. Each entry is one measured way AE changes the comp without a
// word; any of them refuses the call.
function __precomposeHazards(c, sel, moveAll) {
  var hz = [];
  var n = c.numLayers;
  var isSel = {}, k;
  for (k = 0; k < sel.length; k++) isSel[sel[k].id] = true;
  var top = sel[0].index;   // sel is sorted by index

  for (k = 0; k < sel.length; k++) {
    var l = sel[k];
    var label = "layer " + l.id + " (\"" + l.name + "\")";
    if (l.locked) hz.push(label + " is locked. Unlock it with set_layer locked:false first.");
    if ((typeof CameraLayer !== "undefined" && l instanceof CameraLayer) || (typeof LightLayer !== "undefined" && l instanceof LightLayer)) {
      hz.push(label + " is a camera or light. Precomposing it takes it out of this comp, so the 3D layers left here lose it.");
      continue;
    }
    if (!moveAll) {
      var hasSrc = false;
      try { hasSrc = !!l.source; } catch (e) { hasSrc = false; }
      if (!hasSrc) hz.push(label + " is a " + __layerKind(l) + " layer, which has no source item; After Effects only keeps attributes on a footage, solid, null or precomp layer. Use moveAllAttributes:true.");
      continue;
    }
    if (l.threeDLayer) hz.push(label + " is 3D. The precomp layer that replaces it is 2D and not collapsed, so it would stop interacting with this comp's cameras and lights.");
    if (l.adjustmentLayer) {
      for (var b = l.index + 1; b <= n; b++) {
        if (!isSel[c.layer(b).id]) { hz.push(label + " is an adjustment layer with unselected layers below it (layer " + c.layer(b).id + "); inside the precomp it would stop adjusting them."); break; }
      }
    }
  }
  if (!moveAll) return hz;   // the layer keeps its id, parent, children, matte and expressions

  // Parenting across the boundary.
  for (var i = 1; i <= n; i++) {
    var L = c.layer(i);
    var P = L.parent;
    if (!P) continue;
    if (isSel[L.id] && !isSel[P.id]) hz.push("layer " + L.id + " is selected but its parent " + P.id + " is not; After Effects drops the parent and bakes it into the child. Select both, or unparent first.");
    if (!isSel[L.id] && isSel[P.id]) hz.push("layer " + L.id + " is not selected but its parent " + P.id + " is; After Effects re-parents it to the precomp layer, which does not carry the parent's motion. Select both, or unparent first.");
  }
  // Track mattes across the boundary.
  for (var j = 1; j <= n; j++) {
    var T = c.layer(j);
    var st = __trackMatteState(T);
    if (st.layerId === null) continue;
    if (isSel[T.id] && !isSel[st.layerId]) hz.push("layer " + T.id + " is selected but its matte source " + st.layerId + " is not; After Effects copies the source into the precomp and leaves the original behind. Select both, or clear the matte first.");
    if (!isSel[T.id] && isSel[st.layerId]) hz.push("matte source " + st.layerId + " is selected but its target " + T.id + " is not; After Effects re-points the matte at the precomp layer. Select both, or clear the matte first.");
  }
  // Expressions and layer-reference effect parameters.
  var nameSel = {}, nameUnsel = {};
  for (var q = 1; q <= n; q++) { var Q = c.layer(q); if (isSel[Q.id]) nameSel[Q.name] = true; else nameUnsel[Q.name] = true; }
  var selAbove = 0;   // selected layers above the one being looked at
  var capped = [];
  for (var r = 1; r <= n; r++) {
    var R = c.layer(r);
    var inSel = !!isSel[R.id];
    var refs = __layerRefs(R);
    if (refs.capped) capped.push(R.id);
    // Where an unselected layer's index lands afterwards: the selected ones
    // above it are gone and the replacement sits at `top`.
    var moves = inSel || ((r - selAbove + (top < r ? 1 : 0)) !== r);
    for (var e = 0; e < refs.expressions.length; e++) {
      var ex = refs.expressions[e];
      var where = "the expression on layer " + R.id + " \"" + ex.name + "\"";
      var calls = __exprLayerCalls(ex.text);
      for (var x = 0; x < calls.length; x++) {
        var cl = calls[x];
        if (cl.kind === "index") hz.push(where + " refers to layer(" + cl.value + ") by index, which precompose silently re-points at a different layer.");
        else if (cl.kind === "dynamic") hz.push(where + " refers to layer(" + cl.value + "), which cannot be checked before precomposing.");
        else if (nameSel[cl.value] && nameUnsel[cl.value]) hz.push(where + " refers to \"" + cl.value + "\", a name both a selected and an unselected layer have.");
        else if (inSel && nameUnsel[cl.value]) hz.push(where + " refers to \"" + cl.value + "\", which stays in this comp; inside the precomp it would not exist.");
        else if (!inSel && nameSel[cl.value]) hz.push(where + " refers to \"" + cl.value + "\", which moves into the precomp; the expression would break.");
      }
      if (moves && __exprUsesIndex(ex.text)) hz.push(where + " uses index or numLayers, and this layer's index or comp changes.");
    }
    for (var y = 0; y < refs.layerParams.length; y++) {
      var lp = refs.layerParams[y];
      var target = (lp.index >= 1 && lp.index <= n) ? c.layer(lp.index) : null;
      if (target && (!!isSel[target.id]) !== inSel) {
        hz.push("effect parameter \"" + lp.name + "\" on layer " + R.id + " names layer " + target.id + " across the selection boundary.");
      }
    }
    if (inSel) selAbove++;
  }
  if (capped.length) hz.push("layers " + capped.join(", ") + " have more than " + __PC_PROP_CAP + " properties, so their expressions could not all be checked.");
  return hz;
}

OPS.precompose_layers = function (args) {
  var c = getCompById(args.compId);
  var moveAll = args.moveAllAttributes !== false;
  var ids = args.layerIds || [];
  if (!ids.length) throw new Error("precompose_layers: layerIds is empty. Nothing was changed.");
  var seen = {}, sel = [], k;
  for (k = 0; k < ids.length; k++) {
    if (seen[ids[k]]) throw new Error("precompose_layers: layerId " + ids[k] + " is listed twice. Nothing was changed.");
    seen[ids[k]] = true;
    sel.push(getLayerById(c, ids[k]));
  }
  if (!moveAll && sel.length !== 1) {
    throw new Error("precompose_layers: moveAllAttributes:false works on exactly one layer (After Effects refuses it for more). Nothing was changed.");
  }
  var folder = null;
  if (args.parentFolderId !== undefined) folder = __folderOrRoot(args.parentFolderId);
  sel.sort(function (a, b) { return a.index - b.index; });

  var hz = __precomposeHazards(c, sel, moveAll);
  if (hz.length) {
    throw new Error(
      "precompose_layers refused — After Effects would change this comp in ways it does not report:\n  - " +
      hz.join("\n  - ") + "\nNothing was changed."
    );
  }

  var selIds = [], selNames = [], indices = [];
  for (k = 0; k < sel.length; k++) { selIds.push(sel[k].id); selNames.push(sel[k].name); }
  var outerCount = c.numLayers;
  // Indexes only now, immediately before the call, read off the layers just
  // resolved by id.
  for (k = 0; k < sel.length; k++) indices.push(sel[k].index);
  var top = indices[0];
  var nc = c.layers.precompose(indices, args.name, moveAll);

  // --- readback -------------------------------------------------------------
  if (!(nc instanceof CompItem)) throw new Error("precompose_layers: After Effects did not return a comp. Read the comp back with get_layer_structure.");
  var newComp = getCompById(nc.id);
  var repl = [];
  for (var i = 1; i <= c.numLayers; i++) {
    var src = null;
    try { src = c.layer(i).source; } catch (e) { src = null; }
    if (src && src.id === newComp.id) repl.push(c.layer(i));
  }
  if (repl.length !== 1) throw new Error("precompose_layers: expected one layer using new comp " + newComp.id + " in comp " + c.id + ", found " + repl.length + ".");
  var R = repl[0];
  var inner = [];
  if (moveAll) {
    for (k = 0; k < selIds.length; k++) {
      var still = null;
      try { still = getLayerById(c, selIds[k]); } catch (e) { still = null; }
      if (still) throw new Error("precompose_layers: layer " + selIds[k] + " is still in comp " + c.id + " after the precompose.");
    }
    if (newComp.numLayers !== sel.length) throw new Error("precompose_layers: new comp " + newComp.id + " has " + newComp.numLayers + " layers, expected " + sel.length + ".");
    if (c.numLayers !== outerCount - sel.length + 1) throw new Error("precompose_layers: comp " + c.id + " has " + c.numLayers + " layers afterwards, expected " + (outerCount - sel.length + 1) + ".");
    // AE keeps the selection's stacking order inside, so the k-th inner layer
    // is the k-th selected one; names confirm it rather than assume it.
    for (k = 0; k < newComp.numLayers; k++) {
      var il = newComp.layer(k + 1);
      var rec = { layerId: il.id, index: il.index, name: il.name };
      if (il.name === selNames[k]) rec.fromLayerId = selIds[k];
      inner.push(rec);
    }
  } else {
    if (R.id !== selIds[0]) throw new Error("precompose_layers: with moveAllAttributes:false the layer should keep id " + selIds[0] + "; the precomp layer is " + R.id + ".");
    for (k = 1; k <= newComp.numLayers; k++) inner.push({ layerId: newComp.layer(k).id, index: k, name: newComp.layer(k).name });
  }
  if (folder !== null) {
    newComp.parentFolder = folder;
    if (__parentFolderId(newComp) !== folder.id) throw new Error("precompose_layers: new comp " + newComp.id + " did not land in folder " + folder.id + "; it is in " + __parentFolderId(newComp) + ".");
  }
  return {
    compId: c.id,
    newCompId: newComp.id,
    newCompName: newComp.name,
    parentFolderId: __parentFolderId(newComp),
    precompLayerId: R.id,
    precompLayerIndex: R.index,
    precompLayerName: R.name,
    sourceLayerIds: selIds,
    moveAllAttributes: moveAll,
    layerIdsChanged: moveAll,
    innerLayers: inner,
    note: (R.index !== top ? "The precomp layer landed at index " + R.index + ", not at " + top + " where the topmost selected layer was. " : "") + (moveAll
      ? "The selected layers were recreated inside the new comp with NEW ids (innerLayers maps them); their old ids no longer exist. Use precompLayerId in this comp."
      : "The layer kept its id, effects, masks, keyframes, parent and matte, and was renamed to the new comp's name; its source is now the new comp.")
  };
};
