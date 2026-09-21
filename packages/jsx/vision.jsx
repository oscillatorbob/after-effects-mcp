// vision.jsx — saveFrameToPng wrapper, returns the temp file path which the
// panel then reads and base64-encodes.

function __tmpPngPath() {
  var folder = Folder.temp;
  var name = "ae-mcp-" + (new Date().getTime()) + "-" + Math.floor(Math.random() * 1e6) + ".png";
  return folder.fsName + "/" + name;
}

function __clampDownsample(v) {
  if (v === undefined || v === null) return 1;
  var n = Math.round(v);
  if (!(n > 1)) return 1;
  return n > 8 ? 8 : n;
}

// The long edge we aim a screenshot at. ~1280px is still legible for checking
// type and layout, and costs roughly 1.2k image tokens instead of the 11k a
// full-resolution 4K frame costs.
var __SCREENSHOT_TARGET_PX = 1280;

// The correct downsample was always derivable from the comp, and an agent that
// forgot it got a full-resolution 4K frame — the most expensive accident
// available through these tools. So derive it, and let an explicit value win.
function __autoDownsampleFor(comp, targetPx) {
  var longEdge = comp.width > comp.height ? comp.width : comp.height;
  var n = Math.ceil(longEdge / targetPx);
  if (!(n > 1)) return 1;
  return n > 8 ? 8 : n;
}

// 1080p -> 2 (960px), 4K -> 3 (1280px), and anything already small -> 1.
function __autoDownsample(comp) {
  return __autoDownsampleFor(comp, __SCREENSHOT_TARGET_PX);
}

// A contact sheet of N frames has to cost about what one frame costs, so each
// tile gets 1/sqrt(N) of the single-frame long edge — N tiles of 1/N the area
// each. Expressed as a multiple of what this comp's *single* frame would have
// used rather than as its own target, for two reasons: it cannot drift from
// __autoDownsample, and the factor is an integer, so deriving from the target
// instead would let the rounding leave a 1080p sheet at nearly twice the budget.
function __tileDownsample(comp, count) {
  var n = Math.ceil(__autoDownsample(comp) * Math.sqrt(count));
  if (!(n > 1)) return 1;
  return n > 8 ? 8 : n;
}

function __resolveDownsample(comp, requested) {
  if (requested === undefined || requested === null) return __autoDownsample(comp);
  return __clampDownsample(requested);
}

// saveFrameToPng honours the comp's resolutionFactor, so AE can render the
// reduced frame directly instead of writing full size and resampling
// afterwards. That is faster (a quarter of the pixels at factor 2) and needs no
// external image tool, which is what makes it work off macOS.
//
// Factor 1 is *set*, not skipped. Skipping it rendered at whatever the user had
// left the viewer on, so a comp parked at Quarter answered `downsample: 1` with
// a quarter-size frame and `downsample: 2` came back **larger** than
// `downsample: 1` (issue #72). Designers leave heavy comps at Quarter or Third
// as a matter of course, so that was the common case rather than a corner. The
// panel reads the real dimensions out of the PNG's IHDR, which means the
// response stayed honest while the *picture* was not the one asked for — the
// worse of the two failures, because an agent that can see a frame believes it.
// Every factor reaching this function now names the resolution it renders at.
function __saveFrameAt(comp, time, file, factor) {
  var f = (factor > 1) ? Math.round(factor) : 1;
  var previous = comp.resolutionFactor;
  try {
    comp.resolutionFactor = [f, f];
    comp.saveFrameToPng(time, file);
  } finally {
    // Restore unconditionally — a failed render must never leave the user
    // looking at a half-resolution comp. This covers factor 1 too: the render
    // happens at Full and the viewer goes back to Quarter afterwards.
    comp.resolutionFactor = previous;
  }
}

// Several times in one call. Every requested time gets an entry, in order,
// whether or not it rendered — the panel draws a marked block for the ones that
// did not, so the sheet it composes still lines up with the times that were
// asked for. Dropping a failed tile would silently renumber the rest, which is
// the same class of lie as swallowing an error.
function __contactSheetFrames(comp, args) {
  var times = args.times;
  var ds;
  if (args.downsample === undefined || args.downsample === null) {
    ds = __tileDownsample(comp, times.length);
  } else {
    ds = __clampDownsample(args.downsample);
  }
  var tiles = [];
  for (var i = 0; i < times.length; i++) {
    var entry = { time: times[i], downsample: ds };
    try {
      var p = __tmpPngPath();
      __saveFrameAt(comp, times[i], new File(p), ds);
      entry.path = p;
    } catch (e) {
      // One time that will not render must not cost the other five.
      entry.error = String(e && e.message ? e.message : e);
    }
    tiles.push(entry);
  }
  return {
    contactSheet: true,
    tiles: tiles,
    downsample: ds,
    width: comp.width, height: comp.height,
    times: times, compId: comp.id
  };
}

OPS.screenshot_frame = noUndo(function (args) {
  var c = getCompById(args.compId);
  if (args.times && args.times.length) return __contactSheetFrames(c, args);
  var t = (args.time !== undefined && args.time !== null) ? args.time : c.time;
  var ds = __resolveDownsample(c, args.downsample);
  var path = __tmpPngPath();
  var f = new File(path);
  // saveFrameToPng is async-ish; the panel polls the file's existence/size.
  __saveFrameAt(c, t, f, ds);
  return {
    path: path,
    width: c.width, height: c.height,
    downsample: ds,
    time: t, compId: c.id
  };
});

// Measured against the real op (colour type 6, alpha 0, black RGB underneath
// outside the isolated layer): this always rendered genuinely transparent.
// Any white a caller sees there is a viewer compositing the PNG onto white,
// never this tool — so `background` is an opt-in solid for a visual QA pass,
// not a fix for anything, and the default stays untouched: no background,
// real alpha, exactly the behaviour before this option existed.
OPS.screenshot_layer = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var t = (args.time !== undefined && args.time !== null) ? args.time : c.time;
  var ds = __resolveDownsample(c, args.downsample);
  var path = __tmpPngPath();
  var f = new File(path);

  // Capture every solo-able layer's state; solo the target (and an optional
  // background solid) alone; restore everything in `finally`, whatever
  // happens in between — including inside this same loop. AE refuses to
  // touch `.solo` on a disabled layer at all ("Solo flag can not be set on a
  // layer if the layer is not enabled"), so a disabled layer is skipped
  // rather than forced to false; measured live, any comp with one disabled
  // layer threw here before try/finally even started, leaving whatever solo
  // states the loop had already changed with nothing to put them back.
  var prevSolo = [];
  var bgLayer = null;
  // addSolid() creates two things, not one: the AVLayer in the comp, and a
  // backing Solid FootageItem in the Project panel that layer.source points
  // at. Removing only the layer leaves that item behind — measured live: a
  // fresh, brand-new item every call (addSolid never reuses an existing
  // solid), so it is always safe to delete once captured here, and never a
  // pre-existing project item.
  var bgSource = null;
  try {
    for (var i = 1; i <= c.numLayers; i++) {
      var ll = c.layer(i);
      if (!ll.enabled) continue;
      prevSolo.push({ idx: i, solo: ll.solo });
      ll.solo = false;
    }
    l.solo = true;

    if (args.background !== undefined && args.background !== null) {
      // "black" or an [r,g,b] triple, already validated by the schema.
      var color = (args.background === "black") ? [0, 0, 0] : args.background;
      bgLayer = c.layers.addSolid(color, "AE MCP: screenshot background", c.width, c.height, c.pixelAspect, c.duration);
      bgSource = bgLayer.source;
      bgLayer.moveAfter(l);
      bgLayer.solo = true;
    }

    __saveFrameAt(c, t, f, ds);
  } finally {
    // Layer removed before anything else, so the index shift it caused
    // (every layer behind it pushed back by one) is undone before prevSolo's
    // captured indices are used to restore. The backing source is removed
    // next, independently guarded so a failure there still falls through to
    // solo restoration — and captured into bgSource before the layer was
    // ever touched, so this removes the exact item this call created, never
    // one resolved by name or position afterward.
    if (bgLayer) {
      try { bgLayer.remove(); } catch (e0) {}
    }
    if (bgSource) {
      try { bgSource.remove(); } catch (eS) {}
    }
    try { l.solo = false; } catch (e1) {}
    for (var j = 0; j < prevSolo.length; j++) {
      try { c.layer(prevSolo[j].idx).solo = prevSolo[j].solo; } catch (e2) {}
    }
  }
  return {
    path: path,
    width: c.width, height: c.height,
    downsample: ds,
    time: t, compId: c.id, layerId: l.id
  };
});
