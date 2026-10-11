// project.jsx — the Project panel hierarchy: the tree, folders, renaming,
// moving, and deletion that says what it takes with it before it takes it.
//
// Measured on AE 26.5x89 (docs/fragile-areas-ae.md, recipe 53), and every rule
// below follows from one of these:
//
//   - A ProjectItem's id survives rename and move. Names are not unique (two
//     folders may share one, and "" is legal), and app.project.item(i) walks in
//     Project-panel order, so an index moves when anything is renamed. Ids are
//     the only identifier these ops accept.
//   - The root folder is a FolderItem with id 0 that is not in project.items:
//     itemByID(0) throws, remove() is refused, it cannot be moved — and AE
//     *does* let a script rename it. Here 0 means "the root" as a parent and is
//     refused as the thing to rename, move or delete.
//   - parentFolder is writable for every item. AE refuses a folder moved into
//     itself or its own descendant, but with an internal error; that is checked
//     here first, by id ancestry, so the refusal names the cycle.
//   - remove() never asks. A folder takes everything inside it; a comp or
//     footage item takes every layer that uses it, in every comp; a comp takes
//     its Render Queue items. So nothing here removes anything until the whole
//     consequence has been worked out, and nothing removes what it could not
//     work out.

var __PROJECT_ROOT_ID = 0;
var __TREE_MAX_DEPTH = 64;
// Lists inside a deletion report are capped; the totals never are.
var __IMPACT_LIST_CAP = 200;

function __projectRoot() { return app.project.rootFolder; }

// A folder argument where 0 is the project root. Anything else goes through
// __folderArg (comps.jsx), the same resolver duplicate_comp and
// purge_unused_footage use.
function __folderOrRoot(id) {
  if (id === __PROJECT_ROOT_ID || id === undefined || id === null) return __projectRoot();
  return __folderArg(id);
}

// The item an op acts on. Never the root, never a name, never an index.
function __projectItemArg(id, verb) {
  if (id === null || id === undefined) throw new Error("itemId required");
  if (id === __PROJECT_ROOT_ID) {
    throw new Error("itemId 0 is the project root, which cannot be " + verb + ". Nothing was changed.");
  }
  var it = itemByIdOrNull(id);
  if (!it) throw new Error("No project item with id " + id + ". Nothing was changed.");
  return it;
}

function __parentFolderId(it) {
  var p = null;
  try { p = it.parentFolder; } catch (e) { p = null; }
  return p ? p.id : null;
}

// The ids of every folder above `it`, root first: [0, …, parentId]. The root's
// own parentFolder reads null, which is where the walk stops.
function __ancestorIds(it) {
  var out = [];
  var cur = null;
  try { cur = it.parentFolder; } catch (e) { cur = null; }
  for (var d = 0; cur && d < 256; d++) {
    out.unshift(cur.id);
    var next = null;
    try { next = cur.parentFolder; } catch (e2) { next = null; }
    cur = next;
  }
  return out;
}

// Deterministic order, independent of AE's own: name compared case-insensitively
// by code unit, then exactly, then id. AE's panel order follows the name, so an
// index would move under a rename; this order is the one ids keep.
function __projectItemOrder(a, b) {
  var an = String(a.name), bn = String(b.name);
  var al = an.toLowerCase(), bl = bn.toLowerCase();
  if (al < bl) return -1;
  if (al > bl) return 1;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.id - b.id;
}

function __folderChildren(folder) {
  var kids = [];
  for (var i = 1; i <= folder.numItems; i++) kids.push(folder.item(i));
  kids.sort(__projectItemOrder);
  return kids;
}

// Every item below `folder`, depth-first in __projectItemOrder.
function __folderDescendants(folder, out) {
  var kids = __folderChildren(folder);
  for (var i = 0; i < kids.length; i++) {
    out.push(kids[i]);
    if (kids[i] instanceof FolderItem) __folderDescendants(kids[i], out);
  }
  return out;
}

function __countDescendants(folder) {
  var n = 0;
  for (var i = 1; i <= folder.numItems; i++) {
    var c = folder.item(i);
    n += 1;
    if (c instanceof FolderItem) n += __countDescendants(c);
  }
  return n;
}

// comp id -> Render Queue items rendering it, read once per call.
function __renderQueueByComp() {
  var map = {};
  var rq = app.project.renderQueue;
  for (var i = 1; i <= rq.numItems; i++) {
    var item = rq.item(i);
    var comp = null;
    try { comp = item.comp; } catch (e) { comp = null; }
    if (!comp) continue;
    var key = "C" + comp.id;
    if (!map.hasOwnProperty(key)) map[key] = [];
    var status = null;
    try { status = __rqStatusName(item.status); } catch (e2) { status = null; }
    map[key].push({ position: i, compId: comp.id, compName: comp.name, status: status });
  }
  return map;
}

function __rqStatusName(s) {
  if (typeof RQItemStatus === "undefined") return String(s);
  for (var k in RQItemStatus) {
    if (RQItemStatus.hasOwnProperty(k) && RQItemStatus[k] === s) return k;
  }
  return String(s);
}

function __treeNode(it, depth, rq) {
  var n = {
    id: it.id,
    name: it.name,
    type: __itemKind(it),
    parentFolderId: __parentFolderId(it),
    depth: depth,
    pathIds: __ancestorIds(it),
  };
  if (it instanceof FolderItem) {
    n.childCount = it.numItems;
  } else if (it instanceof CompItem) {
    n.width = it.width;
    n.height = it.height;
    n.duration = it.duration;
    n.frameRate = it.frameRate;
    n.numLayers = it.numLayers;
    n.usedInCount = __usedInList(it).length;
    n.renderQueueCount = rq.hasOwnProperty("C" + it.id) ? rq["C" + it.id].length : 0;
  } else if (it instanceof FootageItem) {
    n.sourceKind = __footageKind(it);
    var file = null;
    try { file = it.mainSource && it.mainSource.file ? it.mainSource.file.fsName : null; } catch (e) { file = null; }
    if (file) n.filePath = String(file);
    try { if (it.footageMissing) n.footageMissing = true; } catch (e2) {}
    n.width = it.width;
    n.height = it.height;
    n.usedInCount = __usedInList(it).length;
  }
  return n;
}

OPS.get_project_tree = noUndo(function (args) {
  args = args || {};
  var start = __folderOrRoot(args.folderId);
  var maxDepth = Math.min(args.depth || 16, __TREE_MAX_DEPTH);
  var maxItems = args.maxItems || 500;
  var rq = __renderQueueByComp();

  var rootNode = {
    id: start.id,
    name: start.name,
    type: "folder",
    parentFolderId: start.id === __PROJECT_ROOT_ID ? null : __parentFolderId(start),
    pathIds: start.id === __PROJECT_ROOT_ID ? [] : __ancestorIds(start),
    childCount: start.numItems,
  };
  if (start.id === __PROJECT_ROOT_ID) rootNode.isProjectRoot = true;

  var items = [];
  var depthLimited = [];
  var stoppedAt = null;

  function walk(folder, depth) {
    var kids = __folderChildren(folder);
    for (var i = 0; i < kids.length; i++) {
      if (items.length >= maxItems) {
        if (!stoppedAt) stoppedAt = { id: kids[i].id, name: kids[i].name, parentFolderId: folder.id };
        return;
      }
      var node = __treeNode(kids[i], depth, rq);
      items.push(node);
      if (kids[i] instanceof FolderItem && kids[i].numItems > 0) {
        if (depth >= maxDepth) {
          node.childrenNotListed = true;
          depthLimited.push(kids[i].id);
        } else {
          walk(kids[i], depth + 1);
          if (stoppedAt) return;
        }
      }
    }
  }
  walk(start, 1);

  var total = __countDescendants(start);
  var out = {
    folder: rootNode,
    ordering: "Depth-first. Within a folder: name compared case-insensitively, then exactly, then id. Not After Effects' panel order, which moves when anything is renamed.",
    items: items,
    listedCount: items.length,
    totalItems: total,
    truncated: items.length < total,
  };
  if (stoppedAt) {
    out.truncation = {
      reason: "maxItems",
      limit: maxItems,
      nextUnlisted: stoppedAt,
      note: "Listed " + items.length + " of " + total + " items. Raise maxItems, or pass folderId to list one folder.",
    };
  }
  if (depthLimited.length > 0) {
    out.depthLimitedFolderIds = depthLimited;
    if (!out.truncation) {
      out.truncation = {
        reason: "depth",
        limit: maxDepth,
        note: depthLimited.length + " folder(s) at depth " + maxDepth + " have contents that were not listed (childrenNotListed). Raise depth, or pass one of depthLimitedFolderIds as folderId.",
      };
    }
  }
  return out;
});

OPS.create_project_folder = undoNamed("AE MCP: create project folder", function (args) {
  var name = __projectItemNameArg(args.name);
  var parent = __folderOrRoot(args.parentFolderId);
  var parentId = parent.id;
  var made = (parentId === __PROJECT_ROOT_ID ? app.project.items : parent.items).addFolder(name);
  var id = made.id;

  var back = itemByIdOrNull(id);
  var problem = null;
  if (!back || !(back instanceof FolderItem)) problem = "the new folder " + id + " could not be read back";
  else if (back.name !== name) problem = "its name reads back " + __quoted(back.name) + ", asked " + __quoted(name);
  else if (__parentFolderId(back) !== parentId) problem = "its parent reads back " + __parentFolderId(back) + ", asked " + parentId;
  if (problem) {
    var removed = false;
    try { if (back) { back.remove(); removed = true; } } catch (e) {}
    throw new Error("create_project_folder: " + problem + "." + (removed ? " The folder was removed again." : " The folder may still exist as id " + id + "."));
  }
  return {
    itemId: back.id,
    name: back.name,
    type: "folder",
    parentFolderId: __parentFolderId(back),
    pathIds: __ancestorIds(back),
    childCount: back.numItems,
  };
});

OPS.rename_project_item = undoNamed("AE MCP: rename project item", function (args) {
  var it = __projectItemArg(args.itemId, "renamed");
  var name = __projectItemNameArg(args.name);
  var id = it.id;
  var previous = it.name;
  if (previous !== name) it.name = name;

  var back = itemByIdOrNull(id);
  if (!back) throw new Error("rename_project_item: item " + id + " could not be read back after the rename.");
  if (back.name !== name) {
    try { back.name = previous; } catch (e) {}
    throw new Error("rename_project_item: the name reads back " + __quoted(back.name) + ", asked " + __quoted(name) + ". The previous name was restored.");
  }
  return {
    itemId: back.id,
    previousName: previous,
    actualName: back.name,
    type: __itemKind(back),
    changed: previous !== back.name,
    note: "Only the project item was renamed — a footage item's file on disk keeps its name.",
  };
});

OPS.move_project_item = undoNamed("AE MCP: move project item", function (args) {
  var it = __projectItemArg(args.itemId, "moved");
  if (args.folderId === null || args.folderId === undefined) throw new Error("folderId required (0 for the project root)");
  var target = __folderOrRoot(args.folderId);
  var id = it.id;
  var targetId = target.id;

  if (it instanceof FolderItem) {
    if (targetId === id) {
      throw new Error("move_project_item: folder " + id + " (" + __quoted(it.name) + ") cannot be moved into itself. Nothing was changed.");
    }
    var above = __ancestorIds(target);
    for (var a = 0; a < above.length; a++) {
      if (above[a] === id) {
        throw new Error(
          "move_project_item: folder " + targetId + " (" + __quoted(target.name) + ") is inside folder " + id + " (" + __quoted(it.name) +
          ") — its path is " + above.concat([targetId]).join(" > ") + " — so moving " + id + " into it would make a cycle. Nothing was changed."
        );
      }
    }
  }

  var previousParent = __parentFolderId(it);
  if (previousParent !== targetId) it.parentFolder = target;

  var back = itemByIdOrNull(id);
  if (!back) throw new Error("move_project_item: item " + id + " could not be read back after the move.");
  var actualParent = __parentFolderId(back);
  if (actualParent !== targetId) {
    throw new Error("move_project_item: item " + id + " reads back in folder " + actualParent + ", asked " + targetId + ".");
  }
  return {
    itemId: back.id,
    name: back.name,
    type: __itemKind(back),
    previousParentFolderId: previousParent,
    parentFolderId: actualParent,
    pathIds: __ancestorIds(back),
    changed: previousParent !== actualParent,
  };
});

// ---------- deletion ----------

function __itemBrief(it) {
  return { id: it.id, name: it.name, type: __itemKind(it), parentFolderId: __parentFolderId(it) };
}

function __capped(list) {
  if (list.length <= __IMPACT_LIST_CAP) return list;
  return list.slice(0, __IMPACT_LIST_CAP);
}

// Everything removing `it` would take with it, read from After Effects at the
// moment of asking and changing nothing. `ids` is the full list of project
// item ids that go (target first); the rest is the report.
function __deletionImpact(it) {
  var doomed = [it];
  if (it instanceof FolderItem) __folderDescendants(it, doomed);
  var inSet = {};
  var ids = [];
  for (var i = 0; i < doomed.length; i++) { inSet["I" + doomed[i].id] = true; ids.push(doomed[i].id); }

  var rqByComp = __renderQueueByComp();
  var rqItems = [];
  var externalLayers = [];
  var externalComps = {};
  var externalCompOrder = [];
  var layersInsideDeletedComps = 0;

  for (var d = 0; d < doomed.length; d++) {
    var x = doomed[d];
    if (x instanceof CompItem) {
      layersInsideDeletedComps += x.numLayers;
      var key = "C" + x.id;
      if (rqByComp.hasOwnProperty(key)) rqItems = rqItems.concat(rqByComp[key]);
    }
    if (!(x instanceof CompItem) && !(x instanceof FootageItem)) continue;
    var users = __usedInList(x);
    for (var u = 0; u < users.length; u++) {
      if (inSet["I" + users[u].id]) continue; // a layer inside a comp that goes too
      var comp = itemByIdOrNull(users[u].id);
      if (!comp) continue;
      for (var l = 1; l <= comp.numLayers; l++) {
        var layer = comp.layer(l);
        var src = null;
        try { src = layer.source; } catch (e) { src = null; }
        if (!src || src.id !== x.id) continue;
        externalLayers.push({ compId: comp.id, compName: comp.name, layerId: layer.id, layerName: layer.name, sourceItemId: x.id });
        var ck = "C" + comp.id;
        if (!externalComps.hasOwnProperty(ck)) { externalComps[ck] = { id: comp.id, name: comp.name, layersRemoved: 0 }; externalCompOrder.push(ck); }
        externalComps[ck].layersRemoved += 1;
      }
    }
  }
  rqItems.sort(function (a, b) { return a.position - b.position; });
  var comps = [];
  for (var c = 0; c < externalCompOrder.length; c++) comps.push(externalComps[externalCompOrder[c]]);

  var isFolder = it instanceof FolderItem;
  var safeWhy = [];
  if (isFolder && it.numItems > 0) safeWhy.push("folder " + it.id + " is not empty — it holds " + (doomed.length - 1) + " item(s) at every depth, and deleting it deletes them all");
  if (externalLayers.length > 0) safeWhy.push(externalLayers.length + " layer(s) in " + comps.length + " other comp(s) use it and would be deleted with it");
  if (rqItems.length > 0) safeWhy.push(rqItems.length + " Render Queue item(s) render it and would be deleted with it");
  var recursiveWhy = [];
  if (externalLayers.length > 0) recursiveWhy.push(externalLayers.length + " layer(s) in " + comps.length + " comp(s) outside what is being deleted use it");
  if (rqItems.length > 0) recursiveWhy.push(rqItems.length + " Render Queue item(s) render a comp being deleted");

  var items = [];
  for (var k = 0; k < doomed.length; k++) items.push(__itemBrief(doomed[k]));

  var summary = "Deleting item " + it.id + " (" + __quoted(it.name) + ", " + __itemKind(it) + ") would remove " +
    doomed.length + " project item(s), " + externalLayers.length + " layer(s) in " + comps.length + " other comp(s) and " +
    rqItems.length + " Render Queue item(s).";

  var report = {
    itemId: it.id,
    name: it.name,
    type: __itemKind(it),
    parentFolderId: __parentFolderId(it),
    items: __capped(items),
    externalLayers: __capped(externalLayers),
    externalComps: comps,
    renderQueueItems: rqItems,
    layersInsideDeletedComps: layersInsideDeletedComps,
    totals: {
      projectItems: doomed.length,
      externalLayers: externalLayers.length,
      externalComps: comps.length,
      renderQueueItems: rqItems.length,
    },
    safe: { allowed: safeWhy.length === 0, reasons: safeWhy },
    recursive: { allowed: recursiveWhy.length === 0, reasons: recursiveWhy },
    summary: summary,
  };
  if (items.length > __IMPACT_LIST_CAP || externalLayers.length > __IMPACT_LIST_CAP) {
    report.listsCapped = "items and externalLayers list at most " + __IMPACT_LIST_CAP + " entries each; totals count all of them.";
  }
  return { report: report, ids: ids };
}

OPS.analyze_project_item_deletion = noUndo(function (args) {
  var it = __projectItemArg(args.itemId, "deleted");
  var r = __deletionImpact(it).report;
  r.note = "Nothing was changed. After Effects deletes all of this without asking; delete_project_item refuses unless the mode allows it. " +
    "Expressions that refer to a deleted item by name are not detected.";
  return r;
});

// Layers in every comp that is not going away — the count that must not move.
function __layerTotalOutside(inSet) {
  var n = 0;
  var p = app.project;
  for (var i = 1; i <= p.numItems; i++) {
    var it = p.item(i);
    if (it instanceof CompItem && !inSet["I" + it.id]) n += it.numLayers;
  }
  return n;
}

OPS.delete_project_item = undoNamed("AE MCP: delete project item", function (args) {
  var mode = args.mode || "safe";
  if (mode !== "safe" && mode !== "recursive") throw new Error("mode must be \"safe\" or \"recursive\". Nothing was changed.");
  var it = __projectItemArg(args.itemId, "deleted");
  var impact = __deletionImpact(it);
  var r = impact.report;
  var verdict = r[mode];
  if (!verdict.allowed) {
    var hint = (mode === "safe" && r.recursive.allowed)
      ? " Everything it would remove is inside it, so mode:\"recursive\" would be allowed — check analyze_project_item_deletion first."
      : " No mode of this tool deletes something other comps or the Render Queue still use: delete or re-source those layers, and remove the Render Queue items, first.";
    throw new Error("delete_project_item refused (mode \"" + mode + "\"): " + verdict.reasons.join("; ") + ". " + r.summary + " Nothing was changed." + hint);
  }

  var inSet = {};
  for (var i = 0; i < impact.ids.length; i++) inSet["I" + impact.ids[i]] = true;
  var p = app.project;
  var before = { numItems: p.numItems, rq: p.renderQueue.numItems, outsideLayers: __layerTotalOutside(inSet) };

  it.remove();

  var survivors = [];
  for (var s = 0; s < impact.ids.length; s++) if (itemByIdOrNull(impact.ids[s])) survivors.push(impact.ids[s]);
  var after = { numItems: p.numItems, rq: p.renderQueue.numItems, outsideLayers: __layerTotalOutside(inSet) };
  var bad = [];
  if (survivors.length > 0) bad.push("item(s) " + survivors.join(", ") + " still exist");
  if (after.numItems !== before.numItems - impact.ids.length) bad.push("the project went from " + before.numItems + " to " + after.numItems + " items, expected " + (before.numItems - impact.ids.length));
  if (after.rq !== before.rq) bad.push("the Render Queue went from " + before.rq + " to " + after.rq + " items");
  if (after.outsideLayers !== before.outsideLayers) bad.push("comps outside the deletion went from " + before.outsideLayers + " to " + after.outsideLayers + " layers");
  if (bad.length > 0) {
    throw new Error("delete_project_item removed item " + r.itemId + " but the result does not match what was analyzed: " + bad.join("; ") +
      ". One Undo in After Effects restores the deletion.");
  }
  return {
    deleted: true,
    mode: mode,
    itemId: r.itemId,
    name: r.name,
    type: r.type,
    removedItemCount: impact.ids.length,
    removedItems: r.items,
    verified: {
      itemsGone: impact.ids.length,
      projectItems: { before: before.numItems, after: after.numItems },
      renderQueueItems: { before: before.rq, after: after.rq },
      layersOutside: { before: before.outsideLayers, after: after.outsideLayers },
    },
  };
});

// Names are display text: duplicates are fine, but an empty or blank one is
// refused even though After Effects accepts it, because nothing can find it
// in the panel and every report quoting it reads as missing.
function __projectItemNameArg(name) {
  if (typeof name !== "string" || !/\S/.test(name)) {
    throw new Error("name must be a non-empty string with at least one non-space character. Nothing was changed.");
  }
  return name;
}

function __quoted(s) { return "\"" + String(s) + "\""; }
