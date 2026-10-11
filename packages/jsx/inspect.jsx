// inspect.jsx — inspect_property_tree: a generic, bounded, read-only walk of a
// layer's property tree, for the properties nobody wrote a serializer for —
// camera and light options, time remap, text animators, effect parameters of
// any plugin, layer styles, material and geometry options.
//
// Measured on AE 26.5x89 before this was written (docs/fragile-areas-ae.md,
// "Property trees"); the facts that decide its shape:
//
//   * A group has no value, expression or keys — those fields read undefined
//     on a NAMED_GROUP / INDEXED_GROUP, so they are only read on PROPERTY nodes.
//   * `.value` throws for NO_VALUE (effect section markers, buttons, layer-style
//     gradients) and CUSTOM_VALUE (Curves, …). Such nodes are returned with
//     `valueReadable: false` and the reason — never dropped, which is what
//     list_effects used to do.
//   * `separationDimension` throws unless the property is a separation
//     follower; `minValue`/`maxValue` throw unless `hasMin`/`hasMax`.
//   * A marker property's value is a plain object, not `instanceof
//     MarkerValue`; markers are its keys, and are read through keyValue().
//   * Text variable-font axes report a propertyValueType that is not in the
//     PropertyValueType enum (1489342032); it is reported as UNKNOWN(n).
//   * `canSetExpression` is NOT a writability signal outside the Transform
//     group (layer styles report true and refuse writes; text More Options
//     report false and accept them), so this tool reports it as the raw fact
//     it is and claims nothing about whether a write would land.
//   * Effect "sections" are not groups: AE lists them as flat NO_VALUE markers
//     whose naming differs per effect, so no nesting is inferred from them.
//
// Addressing: every node carries a `path` that walkProperty — and therefore
// add_keyframe, the expression tools, set_shape_property — resolves as-is.
// Each segment is the node's matchName when no sibling shares it, and its
// 1-based index when one does (two Glows, two Fills), so the path is
// unambiguous at the moment of the read. `occurrence` says which of the
// same-matchName siblings a node is. Indices shift when siblings are added,
// removed or reordered; read again after structural edits.

var __PVT_NAMES = null;
function __pvtName(v) {
  if (v === undefined || v === null) return null;
  if (!__PVT_NAMES) {
    __PVT_NAMES = {};
    for (var k in PropertyValueType) __PVT_NAMES[String(PropertyValueType[k])] = k;
  }
  return __PVT_NAMES[String(v)] || ("UNKNOWN(" + v + ")");
}

function __itIsGroup(p) {
  return p.propertyType === PropertyType.NAMED_GROUP || p.propertyType === PropertyType.INDEXED_GROUP;
}

function __itKind(p) {
  if (p.propertyType === PropertyType.INDEXED_GROUP) return "indexedGroup";
  if (p.propertyType === PropertyType.NAMED_GROUP) return "group";
  return "property";
}

function __itNum(n) {
  if (typeof n !== "number" || isNaN(n) || !isFinite(n)) return null;
  return n;
}

function __itArray(v) {
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var x = v[i];
    out.push((x !== null && typeof x === "object" && x.length !== undefined) ? __itArray(x) : __itNum(x));
  }
  return out;
}

function __itColor(c) {
  return c ? [c[0], c[1], c[2]] : null;
}

// One TextDocument as plain data. The fields that throw on a paragraph-only or
// point-only document are skipped one by one rather than failing the node.
function __itTextDocument(td) {
  var out = {};
  var plain = ["text", "font", "fontSize", "tracking", "leading", "baselineShift", "fauxBold", "fauxItalic",
    "allCaps", "smallCaps", "applyFill", "applyStroke", "strokeWidth", "pointText", "boxText"];
  for (var i = 0; i < plain.length; i++) {
    try { var v = td[plain[i]]; if (v !== undefined) out[plain[i]] = v; } catch (e) {}
  }
  try { if (td.applyFill) out.fillColor = __itColor(td.fillColor); } catch (e1) {}
  try { if (td.applyStroke) out.strokeColor = __itColor(td.strokeColor); } catch (e2) {}
  try { out.justification = __justificationName(td.justification); } catch (e3) {}
  try { if (td.boxText) out.boxTextSize = __itArray(td.boxTextSize); } catch (e4) {}
  return out;
}

// A Shape (mask path, shape path). The feather arrays are a mask's
// variable-width feather points; they are only included when there are any.
function __itShape(s) {
  var out = {
    closed: !!s.closed,
    vertices: __itArray(s.vertices || []),
    inTangents: __itArray(s.inTangents || []),
    outTangents: __itArray(s.outTangents || [])
  };
  try {
    if (s.featherSegLocs && s.featherSegLocs.length) {
      out.feather = {
        segLocs: __itArray(s.featherSegLocs), relSegLocs: __itArray(s.featherRelSegLocs),
        radii: __itArray(s.featherRadii), types: __itArray(s.featherTypes),
        interps: __itArray(s.featherInterps), tensions: __itArray(s.featherTensions),
        relCornerAngles: __itArray(s.featherRelCornerAngles)
      };
    }
  } catch (e) {}
  return out;
}

function __itMarker(mv) {
  var out = {};
  var fields = ["comment", "duration", "chapter", "url", "frameTarget", "cuePointName", "eventCuePoint", "label", "protectedRegion"];
  for (var i = 0; i < fields.length; i++) {
    try { var v = mv[fields[i]]; if (v !== undefined && v !== "" && v !== null) out[fields[i]] = v; } catch (e) {}
  }
  return out;
}

// Serialize a value read from a property of value type `vt`. Returns
// {ok:true, value} or {ok:false, category, message}. Never throws.
function __itSerializeValue(vt, raw) {
  try {
    if (vt === "SHAPE") return { ok: true, value: __itShape(raw) };
    if (vt === "TEXT_DOCUMENT") return { ok: true, value: __itTextDocument(raw) };
    if (vt === "MARKER") return { ok: true, value: __itMarker(raw) };
    if (raw === null || raw === undefined) return { ok: true, value: null };
    if (typeof raw === "number") return { ok: true, value: __itNum(raw) };
    if (typeof raw === "boolean" || typeof raw === "string") return { ok: true, value: raw };
    if (typeof raw === "object" && raw.length !== undefined) return { ok: true, value: __itArray(raw) };
    return { ok: false, category: "UNSERIALIZABLE", message: "a value of an object type this tool does not know how to represent" };
  } catch (e) {
    return { ok: false, category: "THREW", message: String(e && e.message ? e.message : e) };
  }
}

// The value of a PROPERTY node, read once. NO_VALUE and CUSTOM_VALUE are
// reported by category without touching `.value`, which is exactly what makes
// them throw; anything else that throws is reported with AE's own message.
function __itReadValue(p, vt) {
  if (vt === "NO_VALUE") {
    return { ok: false, category: "NO_VALUE", message: "has no value: in an effect this is a section marker or a button, elsewhere a UI-only control" };
  }
  if (vt === "CUSTOM_VALUE") {
    return { ok: false, category: "CUSTOM_VALUE", message: "holds plugin-defined data that After Effects does not expose to scripts" };
  }
  var raw;
  try { raw = p.value; } catch (e) {
    return { ok: false, category: "THREW", message: String(e && e.message ? e.message : e) };
  }
  return __itSerializeValue(vt, raw);
}

function __itEase(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push({ influence: arr[i].influence, speed: arr[i].speed });
  return out;
}

// One key, every field AE 26.5 was measured to answer, each read on its own
// so one that throws costs only itself.
function __itKey(p, k, vt) {
  var key = { index: k };
  try { key.time = p.keyTime(k); } catch (e0) {}
  try {
    var kv = p.keyValue(k);
    var s = __itSerializeValue(vt, kv);
    if (s.ok) key.value = s.value; else key.valueError = s.category;
  } catch (e1) { key.valueError = "THREW"; }
  if (vt === "MARKER") return key;
  try { key["in"] = __invInterp(p.keyInInterpolationType(k)); key.out = __invInterp(p.keyOutInterpolationType(k)); } catch (e2) {}
  try { key.easeIn = __itEase(p.keyInTemporalEase(k)); key.easeOut = __itEase(p.keyOutTemporalEase(k)); } catch (e3) {}
  try { key.temporalContinuous = p.keyTemporalContinuous(k); key.temporalAutoBezier = p.keyTemporalAutoBezier(k); } catch (e4) {}
  if (p.isSpatial) {
    try { key.inTangent = __itArray(p.keyInSpatialTangent(k)); key.outTangent = __itArray(p.keyOutSpatialTangent(k)); } catch (e5) {}
    try { key.spatialContinuous = p.keySpatialContinuous(k); key.spatialAutoBezier = p.keySpatialAutoBezier(k); } catch (e6) {}
    try { key.roving = p.keyRoving(k); } catch (e7) {}
  }
  try { var lab = p.keyLabel(k); if (lab) key.label = lab; } catch (e8) {}
  return key;
}

// Path segment for child `i` of `parent`: its matchName when no sibling shares
// it, its index when one does. Also returns which occurrence it is.
function __itSegment(parent, i, child) {
  var seen = 0, occurrence = 0;
  for (var j = 1; j <= parent.numProperties; j++) {
    var sib;
    try { sib = parent.property(j); } catch (e) { continue; }
    if (sib && sib.matchName === child.matchName) {
      seen++;
      if (j === i) occurrence = seen;
    }
  }
  return { segment: seen > 1 ? i : child.matchName, occurrence: occurrence, sameMatchName: seen };
}

var __IT_HIDDEN_MEASURED = { OneD: true, TwoD: true, TwoD_SPATIAL: true, ThreeD: true, ThreeD_SPATIAL: true, COLOR: true };

function __itPropertyFields(p, node, opts) {
  var vt = __pvtName(p.propertyValueType);
  node.valueType = vt;
  if (opts.includeValues) {
    var r = (vt === "MARKER") ? { ok: true, skip: true } : __itReadValue(p, vt);
    if (r.ok) { if (!r.skip) node.value = r.value; }
    else { node.valueReadable = false; node.valueError = { category: r.category, message: r.message }; }
  } else if (vt === "NO_VALUE" || vt === "CUSTOM_VALUE") {
    node.valueReadable = false;
    node.valueError = { category: vt };
  }
  try { node.canSetExpression = !!p.canSetExpression; } catch (e1) {}
  // A one-way hint, measured: across 1,125 properties of every layer kind on
  // 26.5x89, every property with canSetExpression false and canVaryOverTime
  // true refused a new value — the 102 inert slots of a text animator's
  // Properties group, a 2D layer's Orientation, a camera's Scale — and none was
  // writable. The converse does not hold (a disabled layer style's properties
  // say canSetExpression true and still refuse), so absence proves nothing.
  // Only the value types that measurement could write-test: a Marker also
  // reports canSetExpression false + canVaryOverTime true and takes markers
  // perfectly well (seen live), so the rule says nothing outside this set.
  try {
    if (__IT_HIDDEN_MEASURED[vt] && !p.canSetExpression && p.canVaryOverTime) node.hidden = true;
  } catch (eH) {}
  try { node.numKeys = p.numKeys; } catch (e2) { node.numKeys = 0; }
  try { if (p.isTimeVarying) node.isTimeVarying = true; } catch (e3) {}
  try { if (p.isSpatial) node.isSpatial = true; } catch (e4) {}
  try { if (!p.canVaryOverTime) node.canVaryOverTime = false; } catch (e5) {}
  try { if (p.unitsText) node.unitsText = p.unitsText; } catch (e6) {}
  try { if (p.hasMin) node.min = p.minValue; } catch (e7) {}
  try { if (p.hasMax) node.max = p.maxValue; } catch (e8) {}
  try { if (p.isDropdownEffect) node.dropdown = true; } catch (e9) {}
  try {
    if (p.dimensionsSeparated) node.dimensionsSeparated = true;
    if (p.isSeparationLeader) node.separation = { role: "leader" };
    if (p.isSeparationFollower) {
      node.separation = { role: "follower" };
      try { node.separation.dimension = p.separationDimension; } catch (eD) {}
      try { node.separation.leader = p.separationLeader.matchName; } catch (eL) {}
    }
  } catch (e10) {}
  if (opts.includeExpressions) {
    try {
      if (p.canSetExpression) {
        var ex = p.expression;
        if (ex) {
          node.expression = ex;
          node.expressionEnabled = !!p.expressionEnabled;
          // Read, not forced: the value read above (if any) already evaluated it.
          var err = "";
          try { err = p.expressionError; } catch (eE) { err = ""; }
          if (err) node.expressionError = String(err);
        }
      }
    } catch (e11) { node.expressionUnreadable = String(e11 && e11.message ? e11.message : e11); }
  }
  if (opts.includeKeys && node.numKeys > 0) {
    var total = node.numKeys;
    var w = __keyframeWindow(total, opts.maxKeysPerProperty);
    node.keys = [];
    for (var k = 1; k <= total; k++) {
      if (w && k > w.head && k <= total - w.tail) continue;
      node.keys.push(__itKey(p, k, vt));
    }
    if (w) {
      node.keysOmitted = w.omitted;
      node.keysTruncated = __truncationNote(w).replace("raise maxKeyframes", "raise maxKeysPerProperty");
    }
  }
}

function __itGroupFields(p, node) {
  node.childCount = p.numProperties;
  try { if (p.isEffect) node.effect = { enabled: !!p.enabled }; } catch (e1) {}
  try {
    if (p.isMask) {
      node.mask = { inverted: !!p.inverted, locked: !!p.locked };
      for (var k in MaskMode) { if (MaskMode[k] === p.maskMode) { node.mask.mode = k; break; } }
    }
  } catch (e2) {}
  try { if (p.canSetEnabled && !p.enabled) node.enabled = false; } catch (e3) {}
}

function __itCommon(p, node) {
  try { if (!p.active) node.active = false; } catch (e1) {}
  try { if (p.elided) node.elided = true; } catch (e2) {}
  try { if (p.isModified) node.modified = true; } catch (e3) {}
}

var __IT_DEFAULT_COLLAPSE = [
  "ADBE Layer Styles",
  "ADBE Material Options Group",
  "ADBE Extrsn Options Group",
  "ADBE Plane Options Group",
  "ADBE Vector Materials Group"
];

OPS.inspect_property_tree = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var startPath = args.path || [];
  var start = startPath.length ? walkProperty(l, startPath) : l;

  var opts = {
    depth: (args.depth !== undefined && args.depth !== null) ? args.depth : 4,
    maxNodes: args.maxNodes || 250,
    includeValues: args.includeValues !== false,
    includeKeys: args.includeKeys === true,
    includeExpressions: args.includeExpressions !== false,
    maxKeysPerProperty: args.maxKeysPerProperty || 10,
    includeHidden: args.includeHidden !== false
  };
  var collapse = {};
  var collapseList = (args.collapse !== undefined && args.collapse !== null) ? args.collapse : __IT_DEFAULT_COLLAPSE;
  for (var ci = 0; ci < collapseList.length; ci++) collapse[collapseList[ci]] = true;

  var nodes = [];
  var stats = { depthLimited: 0, collapsed: [], hiddenOmitted: 0 };
  var truncated = null;

  // Explicit stack, so a 7-deep shape tree costs no ExtendScript recursion and
  // the node budget can stop the walk at a precise place.
  var stack = [{ prop: start, path: startPath.slice(0), depth: 0, occurrence: null, sameMatchName: null }];
  while (stack.length) {
    var item = stack.pop();
    if (nodes.length >= opts.maxNodes) {
      truncated = {
        reason: "maxNodes",
        limit: opts.maxNodes,
        nextUnvisited: item.path,
        note: "Stopped after " + opts.maxNodes + " nodes; the rest of the tree was not read. Raise maxNodes, lower depth, or pass `path` to inspect one subtree."
      };
      break;
    }
    var p = item.prop;
    var node = { name: p.name, matchName: p.matchName, kind: __itKind(p), path: item.path, depth: item.depth };
    if (item.depth > 0 || startPath.length) {
      try { if (p.propertyIndex !== undefined) node.index = p.propertyIndex; } catch (eI) {}
    }
    if (item.sameMatchName > 1) node.occurrence = item.occurrence;
    __itCommon(p, node);
    if (__itIsGroup(p)) {
      __itGroupFields(p, node);
      var expand = true;
      if (item.depth > 0 && collapse[p.matchName]) {
        node.collapsed = true; expand = false;
        stats.collapsed.push(item.path);
      } else if (item.depth >= opts.depth && p.numProperties > 0) {
        node.childrenNotWalked = true; expand = false;
        stats.depthLimited++;
      }
      if (expand) {
        // Pushed in reverse so they pop in AE's order: the response reads top
        // to bottom exactly as the timeline does.
        for (var i = p.numProperties; i >= 1; i--) {
          var ch;
          try { ch = p.property(i); } catch (eC) { continue; }
          if (!ch) continue;
          var seg = __itSegment(p, i, ch);
          stack.push({ prop: ch, path: item.path.concat([seg.segment]), depth: item.depth + 1, occurrence: seg.occurrence, sameMatchName: seg.sameMatchName });
        }
      }
    } else {
      __itPropertyFields(p, node, opts);
      if (node.hidden && !opts.includeHidden && item.depth > 0) {
        stats.hiddenOmitted++;
        continue;
      }
    }
    nodes.push(node);
  }

  var out = {
    compId: c.id,
    layerId: l.id,
    layerName: l.name,
    path: startPath,
    depth: opts.depth,
    nodesReturned: nodes.length,
    truncated: truncated ? true : false,
    nodes: nodes
  };
  if (truncated) out.truncation = truncated;
  if (stats.depthLimited) out.depthLimitedGroups = stats.depthLimited;
  if (stats.hiddenOmitted) {
    out.hiddenOmitted = stats.hiddenOmitted;
    out.hiddenNote = "Properties flagged hidden (After Effects refuses a value there in this layer's current state) were left out because includeHidden was false.";
  }
  if (stats.collapsed.length) {
    out.collapsed = stats.collapsed;
    out.collapsedNote = "These groups were listed but not expanded (`collapse`). Pass their path to inspect one, or collapse:[] to expand everything.";
  }
  return out;
});
