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
// Every factor reaching __shotUseFactor names the resolution it renders at.
//
// ---------------------------------------------------------------------------
// What a screenshot does to the user's Undo history
// ---------------------------------------------------------------------------
// A screenshot is a read, but it renders by changing things and putting them
// back: the resolution above, and for screenshot_layer every solo flag and an
// optional background solid. Without an undo group, After Effects records each
// of those as its own step — measured on 26.5 (recipe 64): a single frame cost
// two "Resolution Change" steps, a 4-tile sheet eight, screenshot_layer four
// ("Toggle Switch" around two Resolution Changes) and with a background eight,
// including a "New Solid" and a "Clear Layer" — so the user's next Undo undid
// the screenshot instead of their edit, and stopping halfway brought the
// temporary solid back into their comp. Also measured: assigning a resolution
// the comp ALREADY has still records a step; assigning an unchanged solo does
// not.
//
// So: nothing is assigned that would not change, which leaves a capture at the
// viewer's own resolution with nothing to undo at all; and the first change a
// capture does make opens one named group that closes, after everything is put
// back, inside this same evalScript (a group cannot span two). Inside a caller's
// own group — a run_jsx script calling OPS.screenshot_frame — no group is
// opened: the changes become part of the caller's step.
//
// The ledger reports what this one capture did; the panel adds up every
// capture a request ran (its stale-frame retry runs another), and it reports
// groups opened, not Undo steps — that one group is one Edit-menu step is what
// the supervised run measures, and nothing here asserts it.
var __SHOT_UNDO_NAME = "AE MCP: screenshot (view only)";

function __shotLedger() {
  return {
    insideCallerGroup: (typeof __UNDO_OPEN !== "undefined" && __UNDO_OPEN === true),
    open: false, groupsOpened: 0, changes: [], problems: [], leftBehind: [],
    prevFactor: null
  };
}

// Called immediately before any assignment that changes something.
function __shotWillChange(led, what) {
  if (!led.insideCallerGroup && !led.open) {
    __beginUndoGroup(__SHOT_UNDO_NAME);
    led.open = true;
    led.groupsOpened += 1;
  }
  for (var i = 0; i < led.changes.length; i++) if (led.changes[i] === what) return;
  led.changes.push(what);
}

function __shotClose(led) {
  if (!led.open) return;
  led.open = false;
  app.endUndoGroup();
}

function __shotReport(led) {
  return {
    undoGroupsOpened: led.groupsOpened,
    undoGroupName: led.groupsOpened ? __SHOT_UNDO_NAME : null,
    insideCallerGroup: led.insideCallerGroup,
    temporaryChanges: led.changes,
    restored: led.problems.length === 0,
    problems: led.problems,
    leftBehind: led.leftBehind
  };
}

function __shotMsg(e) { return String(e && e.message ? e.message : e); }

function __shotUseFactor(comp, factor, led) {
  var f = (factor > 1) ? Math.round(factor) : 1;
  var cur = comp.resolutionFactor;
  if (cur[0] === f && cur[1] === f) return;
  if (!led.prevFactor) led.prevFactor = [cur[0], cur[1]];
  __shotWillChange(led, "resolution");
  comp.resolutionFactor = [f, f];
}

// Unconditional once anything was changed — a failed render must never leave
// the user looking at a half-resolution comp — and read back, so a restore that
// did not land is reported rather than assumed.
function __shotRestoreFactor(comp, led) {
  var p = led.prevFactor;
  if (!p) return;
  try {
    var cur = comp.resolutionFactor;
    if (cur[0] !== p[0] || cur[1] !== p[1]) comp.resolutionFactor = [p[0], p[1]];
    var back = comp.resolutionFactor;
    if (back[0] !== p[0] || back[1] !== p[1]) {
      led.problems.push("the comp's resolution reads [" + back[0] + "," + back[1] + "] after restoring, not its original [" + p[0] + "," + p[1] + "]");
    }
  } catch (e) {
    led.problems.push("the comp's resolution could not be restored to [" + p[0] + "," + p[1] + "] (" + __shotMsg(e) + ")");
  }
}

// Runs one capture: `body(led)` makes the temporary changes and renders,
// `restore(led)` puts everything back. The group closes after the restore, on
// success and failure alike, and a failure carries the ledger with it.
function __shotCapture(body, restore) {
  var led = __shotLedger();
  var out, failure = null;
  try {
    out = body(led);
  } catch (e) {
    failure = e;
  }
  try { restore(led); } catch (eR) { led.problems.push("restoring failed (" + __shotMsg(eR) + ")"); }
  __shotClose(led);
  if (failure) {
    var err = (failure instanceof Error) ? failure : new Error(__shotMsg(failure));
    var detail = {};
    try { if (err.aeDetail) detail = err.aeDetail; } catch (eD) {}
    detail.screenshotUndo = __shotReport(led);
    err.aeDetail = detail;
    throw err;
  }
  out.undo = __shotReport(led);
  return out;
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
  // The factor is set once for the whole sheet and put back once at the end —
  // per tile it cost two Undo steps a tile.
  return __shotCapture(function (led) {
    __shotUseFactor(comp, ds, led);
    var tiles = [];
    for (var i = 0; i < times.length; i++) {
      var entry = { time: times[i], downsample: ds };
      try {
        var p = __tmpPngPath();
        comp.saveFrameToPng(times[i], new File(p));
        entry.path = p;
      } catch (e) {
        // One time that will not render must not cost the other five.
        entry.error = __shotMsg(e);
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
  }, function (led) { __shotRestoreFactor(comp, led); });
}

OPS.screenshot_frame = noUndo(function (args) {
  var c = getCompById(args.compId);
  if (args.times && args.times.length) return __contactSheetFrames(c, args);
  var t = (args.time !== undefined && args.time !== null) ? args.time : c.time;
  var ds = __resolveDownsample(c, args.downsample);
  var path = __tmpPngPath();
  var f = new File(path);
  return __shotCapture(function (led) {
    __shotUseFactor(c, ds, led);
    // saveFrameToPng is async-ish; the panel polls the file's existence/size.
    c.saveFrameToPng(t, f);
    return {
      path: path,
      width: c.width, height: c.height,
      downsample: ds,
      time: t, compId: c.id
    };
  }, function (led) { __shotRestoreFactor(c, led); });
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
  var bgSourceId = null;
  var layersBefore = c.numLayers;
  var itemsBefore = null;
  // Only a solo that differs is assigned (an unchanged one records nothing in
  // AE, but it would still open this capture's undo group for nothing).
  var targetSolo = l.solo;
  return __shotCapture(function (led) {
    for (var i = 1; i <= c.numLayers; i++) {
      var ll = c.layer(i);
      if (!ll.enabled) continue;
      prevSolo.push({ idx: i, solo: ll.solo });
      if (ll !== l && ll.solo) { __shotWillChange(led, "solo"); ll.solo = false; }
    }
    if (!l.solo) { __shotWillChange(led, "solo"); l.solo = true; }

    if (args.background !== undefined && args.background !== null) {
      // "black" or an [r,g,b] triple, already validated by the schema.
      var color = (args.background === "black") ? [0, 0, 0] : args.background;
      itemsBefore = {};
      for (var b = 1; b <= app.project.numItems; b++) itemsBefore["#" + app.project.item(b).id] = true;
      __shotWillChange(led, "background solid");
      bgLayer = c.layers.addSolid(color, "AE MCP: screenshot background", c.width, c.height, c.pixelAspect, c.duration);
      bgSource = bgLayer.source;
      bgSourceId = bgSource.id;
      bgLayer.moveAfter(l);
      bgLayer.solo = true;
    }

    __shotUseFactor(c, ds, led);
    c.saveFrameToPng(t, f);
    return {
      path: path,
      width: c.width, height: c.height,
      downsample: ds,
      time: t, compId: c.id, layerId: l.id
    };
  }, function (led) {
    __shotRestoreFactor(c, led);
    // Layer removed before anything else, so the index shift it caused
    // (every layer behind it pushed back by one) is undone before prevSolo's
    // captured indices are used to restore. The backing source is removed
    // next, independently guarded so a failure there still falls through to
    // solo restoration — and captured into bgSource before the layer was
    // ever touched, so this removes the exact item this call created, never
    // one resolved by name or position afterward.
    if (bgLayer) {
      try { bgLayer.remove(); } catch (e0) { led.problems.push("the temporary background layer could not be removed (" + __shotMsg(e0) + ")"); }
    }
    if (bgSource) {
      try { bgSource.remove(); } catch (eS) { led.problems.push("the temporary background solid (project item " + bgSourceId + ") could not be removed (" + __shotMsg(eS) + ")"); }
    }
    // The target first, by its own reference, then every enabled layer back to
    // the solo it had (the target is in that list too when it is enabled).
    try {
      if (l.solo !== targetSolo) l.solo = targetSolo;
      if (l.solo !== targetSolo) led.problems.push("layer " + l.id + "'s solo reads " + l.solo + " after restoring");
    } catch (e1) {
      if (l.enabled) led.problems.push("layer " + l.id + "'s solo could not be restored (" + __shotMsg(e1) + ")");
    }
    for (var j = 0; j < prevSolo.length; j++) {
      try {
        var rl = c.layer(prevSolo[j].idx);
        if (rl.solo !== prevSolo[j].solo) rl.solo = prevSolo[j].solo;
        if (rl.solo !== prevSolo[j].solo) led.problems.push("layer " + rl.id + "'s solo reads " + rl.solo + " after restoring");
      } catch (e2) {
        led.problems.push("layer " + prevSolo[j].idx + "'s solo could not be restored (" + __shotMsg(e2) + ")");
      }
    }
    if (c.numLayers !== layersBefore) led.problems.push("the comp has " + c.numLayers + " layers after the capture, not " + layersBefore);
    // Reported, not fixed in this pass: AE files the solid in a Solids folder
    // it creates when there is none, and removing the solid leaves the folder.
    if (itemsBefore !== null) {
      for (var k = 1; k <= app.project.numItems; k++) {
        var it = app.project.item(k);
        if (!itemsBefore["#" + it.id]) led.leftBehind.push({ itemId: it.id, name: it.name, typeName: it.typeName });
      }
    }
  });
});
