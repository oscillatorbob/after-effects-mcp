// ids.jsx — stable ID lookup helpers. (compId, layerId) is the canonical pair.

// app.project.itemByID(id) does not reliably return null for a missing item.
// Measured live against real AE 2026: for every nonexistent id tried (2, 3,
// 999, 12345, 999999, 99999999), it threw the same internal message —
// "internal verification failure, sorry! {Item Not Found}" — and never once
// returned null. Every caller below that wrote `if (!item) throw <friendly
// message>` had dead code: the raw AE error reached the caller instead.
//
// This is the one place that distinction is made, so every caller keeps its
// own message exactly as written — normalizing the *lookup*, not the error
// text. The match is on the message text, the only signal AE gives: it is
// consistent across every id this was measured against, and deliberately
// narrow — anything that is not that exact failure is rethrown unchanged,
// because a project-corruption or other genuine internal error must never be
// silently read as "not found" and swallowed.
function itemByIdOrNull(id) {
  try {
    return app.project.itemByID(id);
  } catch (e) {
    var msg = (e && e.message) ? String(e.message) : String(e);
    if (msg.indexOf("Item Not Found") >= 0) return null;
    throw e;
  }
}

function getCompById(id) {
  if (id === null || id === undefined) throw new Error("compId required");
  var item = itemByIdOrNull(id);
  if (!item) throw new Error("No comp with id " + id);
  if (!(item instanceof CompItem)) throw new Error("Item " + id + " is not a CompItem");
  return item;
}

// Resolve a comp from an optional explicit id, falling back to the comp active
// in the viewer. For read ops where "the comp I'm looking at" is a reasonable
// default and the caller may not have its id at hand — the same fallback
// screenshot_frame's own `time` argument uses, defaulting to the comp's
// current time rather than requiring one.
function resolveComp(args) {
  var id = args ? args.compId : null;
  if (id !== null && id !== undefined) return getCompById(id);
  var active = app.project.activeItem;
  if (active instanceof CompItem) return active;
  throw new Error("No active comp, and no compId given. Open a comp in the viewer, or pass compId.");
}

function getItemById(id) {
  if (id === null || id === undefined) throw new Error("itemId required");
  var item = itemByIdOrNull(id);
  if (!item) throw new Error("No item with id " + id);
  return item;
}

function getLayerById(comp, layerId) {
  if (!(comp instanceof CompItem)) throw new Error("Expected CompItem");
  if (layerId === null || layerId === undefined) throw new Error("layerId required");
  for (var i = 1; i <= comp.numLayers; i++) {
    var l = comp.layer(i);
    if (l.id === layerId) return l;
  }
  throw new Error("No layer with id " + layerId + " in comp " + comp.id);
}

// Walk a propertyPath into a layer/group, e.g. ["Transform","Position"] or ["Effects","Gaussian Blur","Blurriness"].
// Supports numeric indices (1-based) and string names. Returns the Property/PropertyGroup.
function walkProperty(root, path) {
  if (!path || !path.length) throw new Error("Empty propertyPath");
  var cur = root;
  for (var i = 0; i < path.length; i++) {
    var seg = path[i];
    try { cur = cur.property(seg); }
    catch (e) { throw new Error("Property path segment failed at [" + i + "]=" + String(seg) + ": " + e.message); }
    if (!cur) throw new Error("Property path segment returned null at [" + i + "]=" + String(seg));
  }
  return cur;
}

// Look up one of After Effects' own enumerations by member name, and throw if
// the running AE does not define it. `BlendingMode[name] || current` — the
// shape every caller used to have — turned an unknown name into "keep the old
// value" and the call still reported success. Callers resolve every name they
// need *before* changing anything, so a refusal leaves the layer untouched.
function __enumByName(enumObj, enumLabel, name, field) {
  var v;
  try { v = enumObj[name]; } catch (e) { v = undefined; }
  if (name === null || name === undefined || typeof name !== "string" || v === undefined || v === null) {
    throw new Error(
      field + ": \"" + String(name) + "\" is not a " + enumLabel + " this After Effects defines. Nothing was changed."
    );
  }
  return v;
}

function colorOrDefault(c, fallback) {
  if (!c) return fallback;
  return [Number(c[0]), Number(c[1]), Number(c[2])];
}
