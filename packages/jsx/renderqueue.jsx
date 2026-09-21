// renderqueue.jsx — Phase 1 of Render Queue support: inspect and enqueue, but
// never render. get_render_queue and queue_comp share __describeRenderQueueItem
// so both tools report queue state in exactly the same shape.
//
// Measured, not assumed, against a real disposable queue item (see
// docs/fragile-areas-ae.md):
//
//   - RenderQueueItem has no `.id` and no working `.index` — both read back
//     `undefined`. The only handle is *current position*: `rq.items.add(comp)`
//     always appends, so the new item's position is `rq.numItems` right after
//     adding. That position is not stable once an earlier item is removed —
//     it renumbers everything after it — so it is reported as `queueIndex`,
//     described as "current position", never as a persistent id.
//   - `om.file = new File(path)` silently rewrites the extension to match
//     whatever output-module template is active — request "out.mov" against
//     an H.264 template and the readback is "out.mp4". AE does not throw and
//     does not ask. The response always reports the readback path, never an
//     echo of what was requested, for exactly this reason.
//   - A nonexistent parent directory is accepted with no error at queue time —
//     it would only fail at render, which this phase never reaches. Rejected
//     here instead, before `items.add()` ever runs, because a mistake caught
//     now costs nothing and costs a wasted render later.
//   - `RQItemStatus` was fully enumerated: WILL_CONTINUE, NEEDS_OUTPUT,
//     UNQUEUED, QUEUED, RENDERING, USER_STOPPED, ERR_STOPPED, DONE. A fresh
//     item's status is QUEUED, not NEEDS_OUTPUT, even though its output module
//     path was inherited from whatever this AE session queued last — not blank
//     and not comp-specific. That inherited path is exactly why every response
//     here reads the file back from AE rather than trusting either a default
//     or a request.
//   - Queueing does not touch the comp (layer count unchanged), does not open
//     an undo group of its own, and does not save the project. Render Queue
//     state is not part of After Effects' Undo stack — Ctrl+Z does not reach
//     it — so both ops here use noUndo() rather than opening a group nothing
//     would ever close on Undo.

var __RQ_STATUS_NAMES = ["WILL_CONTINUE", "NEEDS_OUTPUT", "UNQUEUED", "QUEUED", "RENDERING", "USER_STOPPED", "ERR_STOPPED", "DONE"];

function __rqStatusName(statusCode) {
  for (var i = 0; i < __RQ_STATUS_NAMES.length; i++) {
    var name = __RQ_STATUS_NAMES[i];
    try { if (RQItemStatus[name] === statusCode) return name; } catch (e) {}
  }
  return null;
}

/** The directory portion of a path, Windows or POSIX separators, or null if there is none. */
function __parentDirOf(p) {
  var s = String(p);
  var idx = -1;
  for (var i = s.length - 1; i >= 0; i--) {
    var c = s.charAt(i);
    if (c === "\\" || c === "/") { idx = i; break; }
  }
  if (idx < 0) return null;
  return s.substring(0, idx);
}

function __describeOutputModule(om, index) {
  var filePath = null, fileName = null, extension = null, hasOutputPath = false, fileExists = false;
  try {
    if (om.file) {
      filePath = String(om.file.fsName);
      hasOutputPath = true;
      var slash = -1;
      for (var i = filePath.length - 1; i >= 0; i--) {
        var c = filePath.charAt(i);
        if (c === "\\" || c === "/") { slash = i; break; }
      }
      fileName = filePath.substring(slash + 1);
      var dot = fileName.lastIndexOf(".");
      extension = dot >= 0 ? fileName.substring(dot + 1) : null;
      try { fileExists = om.file.exists; } catch (e0) {}
    }
  } catch (e) {}
  var name = null;
  try { name = om.name; } catch (e2) {}
  return {
    outputModuleIndex: index,
    name: name,
    filePath: filePath,
    fileName: fileName,
    extension: extension,
    hasOutputPath: hasOutputPath,
    fileExists: fileExists
  };
}

/**
 * Shared by get_render_queue and queue_comp, so neither can report the queue
 * in a shape the other disagrees with. `index` is the caller's current
 * position for this item — see the file header on why that is not an id.
 */
function __describeRenderQueueItem(rqItem, index) {
  var comp = null;
  try { comp = rqItem.comp; } catch (e) {}
  var numOutputModules = 0;
  try { numOutputModules = rqItem.numOutputModules; } catch (e2) {}
  var outputs = [];
  for (var i = 1; i <= numOutputModules; i++) {
    try { outputs.push(__describeOutputModule(rqItem.outputModule(i), i)); } catch (e3) {}
  }
  var statusCode = null;
  try { statusCode = rqItem.status; } catch (e4) {}
  var render = null;
  try { render = rqItem.render; } catch (e5) {}
  var timeSpanStart = null;
  try { timeSpanStart = rqItem.timeSpanStart; } catch (e6) {}
  var timeSpanDuration = null;
  try { timeSpanDuration = rqItem.timeSpanDuration; } catch (e7) {}
  return {
    queueIndex: index,
    compId: comp ? comp.id : null,
    compName: comp ? comp.name : null,
    statusCode: statusCode,
    status: __rqStatusName(statusCode),
    render: render,
    timeSpanStart: timeSpanStart,
    timeSpanDuration: timeSpanDuration,
    numOutputModules: numOutputModules,
    outputs: outputs
  };
}

OPS.get_render_queue = noUndo(function (args) {
  var rq = app.project.renderQueue;
  var items = [];
  for (var i = 1; i <= rq.numItems; i++) {
    items.push(__describeRenderQueueItem(rq.item(i), i));
  }
  return { numItems: rq.numItems, items: items };
});

OPS.queue_comp = noUndo(function (args) {
  // Measured live (AE 2026): itemByID throws its own cryptic internal error
  // for a missing id ("internal verification failure, sorry! {Item Not
  // Found}") rather than returning null, for every id tried. Normalizing
  // both possible behaviours here rather than trusting either.
  var comp = null;
  try { comp = app.project.itemByID(args.compId); } catch (eLookup) { comp = null; }
  if (!comp) throw new Error("No project item with id " + args.compId);
  if (!(comp instanceof CompItem)) {
    throw new Error("Item " + args.compId + " (\"" + comp.name + "\") is not a comp — nothing to queue.");
  }

  var outputFile = null;
  if (args.outputPath !== undefined && args.outputPath !== null) {
    var parent = __parentDirOf(args.outputPath);
    if (parent) {
      var dir = new Folder(parent);
      if (!dir.exists) {
        throw new Error(
          "The output path's parent directory does not exist: " + parent + ". " +
          "queue_comp does not create directories — create it first, or pass a path under one that already exists."
        );
      }
    }
    outputFile = new File(args.outputPath);
  }

  var rq = app.project.renderQueue;
  var item = rq.items.add(comp);
  try {
    if (outputFile) {
      item.outputModule(1).file = outputFile;
    }
  } catch (e) {
    // Never leave a half-configured item behind: the queue mutation this call
    // made is undone before the original failure reaches the caller.
    try { item.remove(); } catch (e2) {}
    throw e;
  }

  // items.add() always appends, so the item just added is the last position —
  // there is no other handle to it (see file header).
  return __describeRenderQueueItem(item, rq.numItems);
});
