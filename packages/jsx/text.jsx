// text.jsx — text layer styling.

// Shared with create_text_layer, which implements `anchorAlign` as live
// paragraph justification rather than a one-time anchor offset. One map so the
// two cannot drift.
var __JUSTIFICATION = {
  left: ParagraphJustification.LEFT_JUSTIFY,
  center: ParagraphJustification.CENTER_JUSTIFY,
  right: ParagraphJustification.RIGHT_JUSTIFY,
  full: ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT,
};

// The name for an enum value, for results and errors. AE has more FULL_JUSTIFY
// variants than the map offers, so a value the map does not know comes back as
// its number rather than as the nearest name.
function __justificationName(v) {
  for (var k in __JUSTIFICATION) {
    if (__JUSTIFICATION.hasOwnProperty(k) && __JUSTIFICATION[k] === v) return k;
  }
  return String(v);
}

// Issue #93: on AE 26.3 the TextDocument round trip — read `.value`, change
// `.text`, `setValue()` — has come back with justification reset to CENTER
// even though the document that went in still said LEFT; issue #94 reports the
// setter storing RIGHT when handed CENTER from a script. Nothing raises in
// either case and the mechanism is unknown, so the only guard that can be built
// blind is the one this repo asks for anyway: read the property back and
// compare with what should be there. A second write of the justification alone
// has been seen to land (`set_text({justification})` on its own always did), so
// one re-assert is tried before giving up. If that also disagrees, the caller
// is told what was expected and what the layer actually shows — a text layer
// that silently re-centres is the failure this codebase refuses everywhere.
//
// `expected` is an enum value: the requested one, or the one read before the
// mutation. Returns {justification, reasserted}; throws when it cannot deliver.
function __verifyJustification(src, expected) {
  var actual = src.value.justification;
  if (actual === expected) return { justification: actual, reasserted: false };
  var again = src.value;
  again.justification = expected;
  src.setValue(again);
  actual = src.value.justification;
  if (actual === expected) return { justification: actual, reasserted: true };
  throw new Error(
    "Source Text justification did not land: expected " + __justificationName(expected) +
    " (" + String(expected) + "), the layer reads " + __justificationName(actual) +
    " (" + String(actual) + ") after a second write. The other fields were written. " +
    "Read the layer back with get_layer_full include:[\"text\"] before relying on its alignment."
  );
}

OPS.set_text = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  if (!(l instanceof TextLayer)) throw new Error("Layer is not a TextLayer");
  var src = l.property("Source Text");
  var td = src.value;
  // Captured before anything is touched: "undefined fields unchanged" is a
  // claim about this value, and it is what the read-back is checked against
  // when no justification was asked for.
  var justificationBefore = td.justification;
  var justificationWanted = justificationBefore;
  if (args.justification !== undefined) {
    if (__JUSTIFICATION[args.justification] === undefined) {
      throw new Error("Unknown justification '" + String(args.justification) + "'; expected one of left, center, right, full. Nothing was changed.");
    }
    justificationWanted = __JUSTIFICATION[args.justification];
  }
  if (args.text !== undefined) td.text = args.text;
  if (args.font !== undefined) td.font = args.font;
  if (args.size !== undefined) td.fontSize = args.size;
  if (args.fillColor) { td.applyFill = true; td.fillColor = [args.fillColor[0], args.fillColor[1], args.fillColor[2]]; }
  if (args.strokeColor) { td.applyStroke = true; td.strokeColor = [args.strokeColor[0], args.strokeColor[1], args.strokeColor[2]]; }
  if (args.strokeWidth !== undefined) td.strokeWidth = args.strokeWidth;
  if (args.tracking !== undefined) td.tracking = args.tracking;
  if (args.leading !== undefined) td.leading = args.leading;
  if (args.justification !== undefined) td.justification = justificationWanted;
  if (args.applyFill !== undefined) td.applyFill = args.applyFill;
  if (args.applyStroke !== undefined) td.applyStroke = args.applyStroke;
  if (args.fauxBold !== undefined) td.fauxBold = args.fauxBold;
  if (args.fauxItalic !== undefined) td.fauxItalic = args.fauxItalic;
  if (args.allCaps !== undefined) td.allCaps = args.allCaps;
  if (args.smallCaps !== undefined) td.smallCaps = args.smallCaps;
  if (args.baselineShift !== undefined) td.baselineShift = args.baselineShift;
  src.setValue(td);
  var verified = __verifyJustification(src, justificationWanted);
  return {
    ok: true,
    justification: __justificationName(verified.justification),
    justificationReasserted: verified.reasserted,
  };
};

var __TEXT_ANIMATOR_PROPS = {
  position: "ADBE Text Position 3D",
  scale: "ADBE Text Scale 3D",
  rotation: "ADBE Text Rotation",
  opacity: "ADBE Text Opacity",
  tracking: "ADBE Text Tracking Amount",
  skew: "ADBE Text Skew",
  fillColor: "ADBE Text Fill Color",
  strokeColor: "ADBE Text Stroke Color"
};

var __TEXT_RANGE_KEYS = [
  ["start", "ADBE Text Percent Start"],
  ["end", "ADBE Text Percent End"],
  ["offset", "ADBE Text Percent Offset"]
];

// The animator at `index`, fetched fresh from the layer. A text animator's
// handles go stale when a child is added beneath it — the same trap as a shape
// node (issue #24) — so nothing here holds one across an addProperty.
function __textAnimatorAt(l, index) {
  return l.property("ADBE Text Properties").property("ADBE Text Animators").property(index);
}

// add_text_animator used to swallow a failed addProperty for the animator
// property and report {ok:true} with an animator that animated nothing. Now
// every node it creates is re-fetched and checked by matchName before the next
// step, and any failure removes the animator it made — so the result is either
// a verified animator or an error with nothing left behind.
OPS.add_text_animator = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  if (!(l instanceof TextLayer)) throw new Error("Layer " + args.layerId + " is not a TextLayer");
  var propMatch = __TEXT_ANIMATOR_PROPS[args.type];
  if (!propMatch) {
    throw new Error("Unknown text animator type '" + String(args.type) + "'. Nothing was changed.");
  }

  var anims = l.property("ADBE Text Properties").property("ADBE Text Animators");
  var created = anims.addProperty("ADBE Text Animator");
  if (!created) throw new Error("After Effects did not create a text animator on layer " + args.layerId + ". Nothing was changed.");
  var index = created.propertyIndex;
  var step = "animator";

  try {
    var anim = __textAnimatorAt(l, index);
    if (!anim || anim.matchName !== "ADBE Text Animator") throw new Error("the new animator was not found at index " + index);

    step = "animator property " + propMatch;
    var added = anim.property("ADBE Text Animator Properties").addProperty(propMatch);
    if (!added) throw new Error("addProperty returned nothing");
    var props = __textAnimatorAt(l, index).property("ADBE Text Animator Properties");
    var prop = props.property(propMatch);
    if (!prop || prop.matchName !== propMatch) throw new Error("the property is not on the animator after adding it");
    // A primitive, because adding the selector below can invalidate `prop`.
    var propName = prop.name;

    var selector = null;
    if (args.range) {
      step = "range selector";
      var selectors = __textAnimatorAt(l, index).property("ADBE Text Selectors");
      if (selectors.numProperties === 0) {
        var sAdded = selectors.addProperty("ADBE Text Selector");
        if (!sAdded) throw new Error("addProperty returned nothing");
        selectors = __textAnimatorAt(l, index).property("ADBE Text Selectors");
      }
      var sel = selectors.property(1);
      if (!sel || sel.matchName !== "ADBE Text Selector") throw new Error("no range selector on the animator after adding one");
      selector = { name: sel.name, index: 1 };
      for (var i = 0; i < __TEXT_RANGE_KEYS.length; i++) {
        var key = __TEXT_RANGE_KEYS[i][0];
        if (args.range[key] === undefined) continue;
        step = "range selector " + key;
        var rp = sel.property(__TEXT_RANGE_KEYS[i][1]);
        if (!rp) throw new Error("the selector has no " + __TEXT_RANGE_KEYS[i][1]);
        rp.setValue(args.range[key]);
        selector[key] = rp.value;
      }
    }

    var finalAnim = __textAnimatorAt(l, index);
    var out = {
      ok: true,
      animatorName: finalAnim.name,
      animatorIndex: index,
      property: { name: propName, matchName: propMatch },
      // The path add_keyframe / set_expression take to animate what was added.
      propertyPath: ["ADBE Text Properties", "ADBE Text Animators", index, "ADBE Text Animator Properties", propMatch]
    };
    if (selector) out.selector = selector;
    return out;
  } catch (e) {
    var removed = false;
    try {
      var leftover = __textAnimatorAt(l, index);
      if (leftover && leftover.matchName === "ADBE Text Animator") { leftover.remove(); removed = true; }
    } catch (eRm) {}
    var msg = (e && e.message) ? String(e.message) : String(e);
    throw new Error(
      "add_text_animator failed at the " + step + ": " + msg + ". " +
      (removed ? "The animator it created was removed, so nothing changed."
               : "The animator it created could not be removed — check the layer's Text > Animators before retrying.")
    );
  }
};
