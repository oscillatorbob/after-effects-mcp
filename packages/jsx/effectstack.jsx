// effectstack.jsx — the structure of a layer's Effects stack: get_effect_stack,
// add_effect, remove_effect, duplicate_effect, move_effect.
//
// Measured on AE 26.5x89 (docs/fragile-areas-ae.md, "Effect stack"; recipe 57),
// and every rule below follows from one of these:
//
//   - An effect has no id. propertyIndex is its position; matchName names its
//     type and repeats across copies; the display name is mutable and two
//     effects may share one (AE dedups only when it names an effect itself:
//     adding a second Glow gives "Glow 2", duplicating "Bloom" gives "Bloom 2";
//     a rename to an existing name is accepted). property("Bloom") and
//     property("ADBE Glo2") return the FIRST match.
//   - Every held reference into a stack goes invalid ("Object is invalid")
//     after moveTo, duplicate or remove on it — the moved or duplicated effect
//     included. So nothing here keeps a handle across a write: it re-fetches by
//     index, and proves which effect is where by fingerprint.
//   - duplicate() inserts the copy directly below its source and copies
//     enabled, values, keyframes (interpolation and holds), expressions,
//     Compositing Options and layer-reference parameters; a layer reference
//     keeps following its layer when layers are reordered.
//   - moveTo(n) leaves the effect at final index n. moveTo(own index) is a
//     no-op; 0 or past the end throws.
//   - Cameras and lights have no Effects group (property(...) is null); every
//     other layer — solid, null, text, shape, footage, precomp, adjustment —
//     takes effects.
//   - From a script AE does NOT refuse effect edits on a locked layer (add,
//     duplicate, move, rename, enable, value writes, remove all land). These
//     tools refuse by policy, as the layer-structure and timing tools do: the
//     lock is the user saying "do not touch this layer".
//   - Removing an effect that an expression names by display name leaves the
//     expression disabled with "effect named '…' is missing" and the property
//     on its static value, with no error anywhere else. An expression that
//     addresses effects by index silently reads a different effect once the
//     indices shift.
//   - CUSTOM_VALUE parameters (Curves' curve, some plugin data) cannot be read
//     or written from a script. duplicate() copies them, being AE's own copy;
//     a parameter-by-parameter copy to another layer would lose them, which is
//     why there is no copy_effect.

var __ES_PARADE = "ADBE Effect Parade";
var __ES_PROP_CAP = 2000;        // leaf properties fingerprinted per effect
var __ES_KEY_CAP = 200;          // keys fingerprinted per property
var __ES_EXPR_PROP_CAP = 200000; // properties walked per comp for expressions

function __esParade(l) {
  var p = null;
  try { p = l.property(__ES_PARADE); } catch (e) { p = null; }
  return p || null;
}

function __esLayerLabel(l) { return "layer " + l.id + " (\"" + l.name + "\")"; }

function __esKind(l) {
  try { if (l instanceof CameraLayer) return "camera"; } catch (e) {}
  try { if (l instanceof LightLayer) return "light"; } catch (e2) {}
  return "layer";
}

function __esRequireParade(l, op) {
  var fx = __esParade(l);
  if (!fx) {
    throw new Error(op + ": " + __esLayerLabel(l) + " is a " + __esKind(l) + ", and After Effects gives cameras and lights no Effects. Nothing was changed.");
  }
  return fx;
}

function __esRequireUnlocked(l, op) {
  if (l.locked) {
    throw new Error(op + ": " + __esLayerLabel(l) + " is locked. After Effects would let a script change its effects anyway, but the lock is the user's — unlock it with set_layer locked:false first. Nothing was changed.");
  }
}

// ---------------------------------------------------------------------------
// Reading an effect: its record and its fingerprint
// ---------------------------------------------------------------------------

function __esValStr(p) {
  var v;
  try { v = p.value; } catch (e) { return "?custom"; }
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return String(v);
  if (v instanceof Array) return "[" + v.join(",") + "]";
  return "?" + typeof v;
}

function __esIsProp(p) {
  try { return p.propertyType === PropertyType.PROPERTY; } catch (e) { return false; }
}

// Walks one effect: counts, and a fingerprint string of everything a script
// can read — every leaf's value, keys (time, value, interpolation) and
// expression, under the effect and its nested groups. CUSTOM_VALUE leaves
// read as "?custom": they are counted, and the result says they could not be
// compared.
function __esScan(eff) {
  var out = { leaves: 0, keyed: 0, expressions: 0, custom: 0, capped: false, fp: [] };
  function walk(g, prefix) {
    var n = 0;
    try { n = g.numProperties; } catch (e) { return; }
    for (var i = 1; i <= n; i++) {
      if (out.leaves >= __ES_PROP_CAP) { out.capped = true; return; }
      var p = null;
      try { p = g.property(i); } catch (e2) { continue; }
      if (!p) continue;
      var key = prefix + "/" + p.matchName;
      if (!__esIsProp(p)) { walk(p, key); continue; }
      out.leaves++;
      var nk = 0;
      try { nk = p.numKeys; } catch (e3) { nk = 0; }
      var ex = "";
      try { ex = p.canSetExpression ? p.expression : ""; } catch (e6) { ex = ""; }
      // The current value only where it cannot depend on the playhead: a keyed
      // or expression-driven value is captured by its keys and its text, so the
      // fingerprint does not change when the user scrubs.
      var v = (nk > 0 || ex !== "") ? "~" : __esValStr(p);
      if (v === "?custom") out.custom++;
      var s = key + "=" + v;
      if (nk > 0) {
        out.keyed++;
        s += "|k" + nk;
        for (var k = 1; k <= nk && k <= __ES_KEY_CAP; k++) {
          var kv = "?";
          try { var raw = p.keyValue(k); kv = raw instanceof Array ? raw.join(",") : String(raw); } catch (e4) {}
          var ii = "", oi = "";
          try { ii = String(p.keyInInterpolationType(k)); oi = String(p.keyOutInterpolationType(k)); } catch (e5) {}
          s += ";" + p.keyTime(k) + ":" + kv + ":" + ii + "/" + oi;
        }
      }
      if (ex !== "") {
        out.expressions++;
        var on = false;
        try { on = p.expressionEnabled; } catch (e7) {}
        s += "|x" + (on ? "1" : "0") + ":" + ex;
      }
      out.fp.push(s);
    }
  }
  walk(eff, "");
  return out;
}

// FNV-1a, 32-bit, in ES3 arithmetic (the multiply as shifts so no product
// passes 2^53). A short, stable name for an effect's whole readable state.
function __esHash(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  var hex = h.toString(16);
  while (hex.length < 8) hex = "0" + hex;
  return hex;
}

function __esOccurrence(fx, i) {
  var mn = fx.property(i).matchName, before = 0, total = 0;
  for (var j = 1; j <= fx.numProperties; j++) {
    if (fx.property(j).matchName === mn) { total++; if (j <= i) before++; }
  }
  return { occurrence: before, sameMatchNameCount: total };
}

// The path inspect_property_tree would give this effect: its matchName while
// it is the only one of its kind, its index once it is not.
function __esPath(fx, i, occ) {
  return [__ES_PARADE, occ.sameMatchNameCount > 1 ? i : fx.property(i).matchName];
}

function __esRecord(fx, i) {
  var eff = fx.property(i);
  var occ = __esOccurrence(fx, i);
  var pr = __esPrint(fx, i);
  var sc = pr.scan;
  var r = {
    effectIndex: i,
    name: eff.name,
    matchName: eff.matchName,
    enabled: eff.enabled,
    occurrence: occ.occurrence,
    sameMatchNameCount: occ.sameMatchNameCount,
    path: __esPath(fx, i, occ),
    numProperties: sc.leaves,
    keyedProperties: sc.keyed,
    expressions: sc.expressions,
    fingerprint: __esHash(pr.body),
  };
  if (sc.custom) r.unreadableProperties = sc.custom;
  if (sc.capped) r.propertiesNotScanned = true;
  return r;
}

// Everything that identifies the effect at i, name excluded (`body`) and
// included (`full`). Two effects with equal `full` are indistinguishable to a
// script, which is the most any check here can promise.
function __esPrint(fx, i) {
  var eff = fx.property(i);
  var sc = __esScan(eff);
  var body = eff.matchName + "#" + (eff.enabled ? "on" : "off") + "#" + sc.fp.join("\n");
  return { name: eff.name, matchName: eff.matchName, body: body, full: eff.name + "#" + body, scan: sc };
}

function __esPrints(fx) {
  var out = [];
  for (var i = 1; i <= fx.numProperties; i++) out.push(__esPrint(fx, i));
  return out;
}

function __esStack(fx) {
  var out = [];
  for (var i = 1; i <= fx.numProperties; i++) out.push(__esRecord(fx, i));
  return out;
}

function __esCompact(fx) {
  var out = [];
  for (var i = 1; i <= fx.numProperties; i++) {
    var e = fx.property(i);
    out.push({ effectIndex: i, name: e.name, matchName: e.matchName, enabled: e.enabled });
  }
  return out;
}

function __esStackText(fx) {
  var parts = [];
  for (var i = 1; i <= fx.numProperties; i++) {
    var e = fx.property(i);
    parts.push(i + " " + e.matchName + " \"" + e.name + "\"");
  }
  return parts.length ? parts.join(", ") : "(empty)";
}

// Does `prints` (read now) match `expected`, effect by effect? Returns the
// first difference as a sentence, or null.
function __esCompare(prints, expected) {
  if (prints.length !== expected.length) return "the stack has " + prints.length + " effects, expected " + expected.length;
  for (var i = 0; i < expected.length; i++) {
    var want = expected[i], got = prints[i];
    if (want.body !== got.body || (want.name !== null && want.name !== got.name)) {
      return "effect " + (i + 1) + " is " + got.matchName + " \"" + got.name + "\", expected " + want.matchName + " \"" + (want.name === null ? "(any name)" : want.name) + "\"";
    }
  }
  return null;
}

// Put the stack back in the order `before` records, by fingerprint: for each
// position from the top, find the effect that belongs there and move it in.
// Needs no knowledge of where a wrong move landed — the only safe assumption,
// since a move that went wrong did not go where it was told. Returns whether
// the result was verified.
function __esRestoreOrder(l, before) {
  try {
    for (var p = 1; p <= before.length; p++) {
      var fx = __esParade(l);
      if (fx.numProperties !== before.length) return false;
      if (__esPrint(fx, p).full === before[p - 1].full) continue;
      var found = 0;
      for (var q = p + 1; q <= fx.numProperties; q++) if (__esPrint(fx, q).full === before[p - 1].full) { found = q; break; }
      if (!found) return false;
      fx.property(found).moveTo(p);
    }
    return __esCompare(__esPrints(__esParade(l)), before) === null;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

function __esResolve(fx, loc, label, op) {
  var n = fx.numProperties;
  var i = loc ? loc.effectIndex : undefined;
  var stale = "Effect indices shift whenever an effect is added, removed, duplicated or moved — call get_effect_stack and use what it returns. The stack now: " + __esStackText(fx) + ". Nothing was changed.";
  if (typeof i !== "number" || Math.round(i) !== i || i < 1) throw new Error(op + ": " + label + ".effectIndex must be a whole number from 1. Nothing was changed.");
  if (i > n) throw new Error(op + ": " + label + " effectIndex " + i + " is past the end of the stack (" + n + " effect" + (n === 1 ? "" : "s") + "). " + stale);
  var e = fx.property(i);
  if (e.matchName !== loc.matchName) {
    throw new Error(op + ": " + label + " does not match the stack — effect " + i + " is " + e.matchName + " \"" + e.name + "\", not " + loc.matchName + ". " + stale);
  }
  if (loc.effectName !== undefined && loc.effectName !== null && e.name !== loc.effectName) {
    throw new Error(op + ": " + label + " does not match the stack — effect " + i + " is named \"" + e.name + "\", not \"" + loc.effectName + "\". " + stale);
  }
  // Two effects can share matchName AND name ("Bloom" twice), so after a
  // reorder index + matchName + name can match the other one. The fingerprint
  // is what tells them apart whenever any value, key or expression differs.
  if (loc.fingerprint !== undefined && loc.fingerprint !== null) {
    var now = __esHash(__esPrint(fx, i).body);
    if (now !== loc.fingerprint) {
      throw new Error(op + ": " + label + " does not match the stack — effect " + i + " (" + e.matchName + " \"" + e.name + "\") has fingerprint " + now + ", not " + loc.fingerprint + ": it is another effect with the same name, or it was edited since it was read. " + stale);
    }
  }
  return i;
}

// ---------------------------------------------------------------------------
// Expressions that depend on the stack
// ---------------------------------------------------------------------------

// Every expression in the comp, with whether After Effects reports it broken.
// Reading the value first makes AE evaluate it, which is what fills in
// expressionError.
function __esExprs(c) {
  var out = { list: [], capped: false };
  var seen = 0;
  function walk(l, g) {
    var n = 0;
    try { n = g.numProperties; } catch (e) { return; }
    for (var i = 1; i <= n; i++) {
      if (++seen > __ES_EXPR_PROP_CAP) { out.capped = true; return; }
      var p = null;
      try { p = g.property(i); } catch (e2) { continue; }
      if (!p) continue;
      if (!__esIsProp(p)) { walk(l, p); if (out.capped) return; continue; }
      var ex = "";
      try { ex = p.canSetExpression ? p.expression : ""; } catch (e3) { ex = ""; }
      if (ex === "") continue;
      var err = "";
      try { p.value; } catch (e4) {}
      try { err = p.expressionError || ""; } catch (e5) { err = ""; }
      out.list.push({ layerId: l.id, layerIndex: l.index, layerName: l.name, property: p.name, text: ex, error: err });
    }
  }
  for (var j = 1; j <= c.numLayers; j++) { walk(c.layer(j), c.layer(j)); if (out.capped) break; }
  return out;
}

// The effect() calls an expression makes, as written, with what each is
// called on. Not a parser — the same literal-or-not classification
// precompose_layers uses for layer(): a string literal is a name, an integer
// literal an index, anything else dynamic. The receiver is `self` for a bare
// effect() or thisLayer.effect(), the layer(...) argument when the call is
// chained straight off one, and `unknown` for anything else (a variable).
//
// NO REGULAR EXPRESSIONS, on purpose. The first version matched these calls
// with one RegExp (an optional `layer(…).` / `name.` prefix in front of lazy
// `[^()]*?` groups). V8 runs it instantly; After Effects' ExtendScript engine
// never returns from a single exec() of it — measured twice on 26.5x89, each
// time freezing After Effects until it was force-quit, with an iteration cap
// around the loop that never got the chance to fire. A scanner of plain
// indexOf/charAt cannot backtrack, and every loop below moves its position
// strictly forward or strictly back toward 0, so it terminates on any input.
// tests/unit/effect-stack.mjs fails if a RegExp comes back into these
// functions.
function __esIsIdent(ch) {
  return ch !== "" && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "$");
}
function __esIsSpace(ch) { return ch === " " || ch === "\t" || ch === "\n" || ch === "\r"; }
// Fragments of an expression echoed back in a refusal, bounded: a malformed
// expression must not turn into a message (or a result) the size of itself.
function __esClip(s) { return s.length > 80 ? s.substring(0, 80) + "…" : s; }
function __esTrim(s) {
  var a = 0, b = s.length;
  while (a < b && __esIsSpace(s.charAt(a))) a++;
  while (b > a && __esIsSpace(s.charAt(b - 1))) b--;
  return s.substring(a, b);
}
function __esClassify(raw) {
  var arg = __esTrim(raw);
  var q = arg.charAt(0);
  if ((q === "\"" || q === "'") && arg.length >= 2 && arg.charAt(arg.length - 1) === q) {
    // A string literal only if the closing quote is the only unescaped one.
    // An escape that swallows the closing quote leaves i past it.
    var ok = true, i = 1;
    for (; i < arg.length - 1; i++) {
      var ch = arg.charAt(i);
      if (ch === "\\") { i++; continue; }
      if (ch === q) { ok = false; break; }
    }
    if (ok && i === arg.length - 1) return { kind: "name", value: arg.substring(1, arg.length - 1) };
  }
  if (arg.length > 0) {
    var digits = true;
    for (var j = 0; j < arg.length; j++) { var d = arg.charAt(j); if (d < "0" || d > "9") { digits = false; break; } }
    if (digits) return { kind: "index", value: Number(arg) };
  }
  return { kind: "dynamic", value: __esClip(arg) };
}
// What effect() at `at` is called on, read backwards from it.
function __esReceiver(text, at) {
  var k = at - 1;
  while (k >= 0 && __esIsSpace(text.charAt(k))) k--;
  if (k < 0 || text.charAt(k) !== ".") return { kind: "self" };
  k--;
  while (k >= 0 && __esIsSpace(text.charAt(k))) k--;
  if (k >= 0 && text.charAt(k) === ")") {
    var open = text.lastIndexOf("(", k);
    if (open < 0) return { kind: "unknown", value: __esClip(text.substring(0, k + 1)) };
    var e = open - 1;
    while (e >= 0 && __esIsSpace(text.charAt(e))) e--;
    var b = e;
    while (b >= 0 && __esIsIdent(text.charAt(b))) b--;
    var fn = text.substring(b + 1, e + 1);
    if (fn === "layer") return { kind: "layer", ref: __esClassify(text.substring(open + 1, k)) };
    return { kind: "unknown", value: __esClip(text.substring(b + 1, k + 1)) };
  }
  var end = k;
  while (k >= 0 && __esIsIdent(text.charAt(k))) k--;
  var name = text.substring(k + 1, end + 1);
  if (name === "thisLayer") return { kind: "self" };
  return { kind: "unknown", value: __esClip(name === "" ? text.substring(0, end + 1) : name) };
}
function __esEffectCalls(text) {
  var out = [];
  var pos = 0;
  var s = String(text);
  while (pos < s.length) {
    var at = s.indexOf("effect", pos);
    if (at < 0) break;
    pos = at + 6;                                   // strictly forward, every iteration
    if (at > 0 && __esIsIdent(s.charAt(at - 1))) continue;      // part of a longer name
    var k = pos;
    while (k < s.length && __esIsSpace(s.charAt(k))) k++;
    if (s.charAt(k) !== "(") continue;              // "effect" not called here
    var close = s.indexOf(")", k + 1);
    if (close < 0) {
      // No ")" anywhere after this: every later call is unclosed too, so one
      // entry stands for them all — dynamic, which the hazard check refuses on.
      out.push({ receiver: __esReceiver(s, at), arg: { kind: "dynamic", value: __esClip(__esTrim(s.substring(k + 1))) } });
      break;
    }
    var inner = s.substring(k + 1, close);
    // A nested call in the argument cannot be read as a literal: dynamic.
    var arg = inner.indexOf("(") >= 0 ? { kind: "dynamic", value: __esClip(__esTrim(inner)) } : __esClassify(inner);
    out.push({ receiver: __esReceiver(s, at), arg: arg });
  }
  return out;
}

// Could this call be addressing an effect on layer l? Literal references are
// decided; anything else is assumed to, since the check exists to refuse what
// it cannot rule out.
function __esCallTargets(call, entry, l) {
  var r = call.receiver;
  if (r.kind === "self") return entry.layerId === l.id;
  if (r.kind === "layer") {
    if (r.ref.kind === "name") return r.ref.value === l.name;
    if (r.ref.kind === "index") return r.ref.value === l.index;
    return true;
  }
  return true;
}

// plan: {kind: "remove", index, name, matchName} — the effect goes away and
// every index after it shifts down; {kind: "shift", from, to} — every effect
// index in [from, to] changes meaning. Returns one sentence per hazard.
function __esExprHazards(exprs, l, plan) {
  var hz = [];
  for (var i = 0; i < exprs.list.length; i++) {
    var en = exprs.list[i];
    var calls = __esEffectCalls(en.text);
    for (var k = 0; k < calls.length; k++) {
      var call = calls[k];
      if (!__esCallTargets(call, en, l)) continue;
      var a = call.arg, why = null;
      if (a.kind === "dynamic") why = "addresses an effect with a computed argument (" + a.value + "), so which one it reads cannot be checked";
      else if (plan.kind === "remove") {
        if (a.kind === "name" && (a.value === plan.name || a.value === plan.matchName)) why = "names \"" + a.value + "\", the effect being removed";
        else if (a.kind === "index" && a.value >= plan.index) why = "addresses effect(" + a.value + "), which would " + (a.value === plan.index ? "be the removed effect" : "then read a different effect");
      } else if (a.kind === "index" && a.value >= plan.from && a.value <= plan.to) {
        why = "addresses effect(" + a.value + "), which would then read a different effect";
      }
      if (why) {
        var onWhat = call.receiver.kind === "unknown" ? " (on \"" + call.receiver.value + "\", which could be this layer)" : "";
        hz.push("the expression on layer " + en.layerId + " (\"" + en.layerName + "\") \"" + en.property + "\" " + why + onWhat);
        break;
      }
    }
  }
  if (exprs.capped) hz.push("the comp has more than " + __ES_EXPR_PROP_CAP + " properties, so its expressions could not all be checked");
  return hz;
}

function __esRefuseHazards(op, hz) {
  throw new Error(
    op + ": this would break expressions that depend on the Effects stack — " + hz.join("; ") +
      ". Change those expressions first (an expression that names an effect survives a move or duplicate, but not its removal; one that uses an index survives none), or pass ignoreExpressionReferences:true if the user agreed. Nothing was changed."
  );
}

// Expressions AE reports broken now that were not broken before. Matched by
// layer, property name and text, not by path: the paths of effect parameters
// are exactly what a structural change moves.
function __esNewlyBroken(before, after) {
  var was = {};
  for (var i = 0; i < before.list.length; i++) {
    var b = before.list[i];
    if (b.error) { var kb = b.layerId + "|" + b.property + "|" + b.text; was[kb] = (was[kb] || 0) + 1; }
  }
  var out = [];
  for (var j = 0; j < after.list.length; j++) {
    var a = after.list[j];
    if (!a.error) continue;
    var ka = a.layerId + "|" + a.property + "|" + a.text;
    if (was[ka]) { was[ka]--; continue; }
    out.push({ layerId: a.layerId, layerName: a.layerName, property: a.property, expression: a.text, error: a.error });
  }
  return out;
}

function __esBrokenText(broken) {
  var parts = [];
  for (var i = 0; i < broken.length; i++) parts.push("layer " + broken[i].layerId + " \"" + broken[i].property + "\": " + broken[i].error);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------

function __esLayerArgs(args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  return { c: c, l: l };
}

OPS.get_effect_stack = noUndo(function (args) {
  var t = __esLayerArgs(args);
  var fx = __esParade(t.l);
  var base = { compId: t.c.id, layerId: t.l.id, layerName: t.l.name };
  if (!fx) {
    base.supportsEffects = false;
    base.reason = "a " + __esKind(t.l) + " has no Effects in After Effects";
    base.numEffects = 0;
    base.effects = [];
    return base;
  }
  base.supportsEffects = true;
  base.locked = t.l.locked;
  base.numEffects = fx.numProperties;
  base.effects = __esStack(fx);
  base.note = "Locators (effectIndex + matchName + name) and index paths go stale after any add/remove/duplicate/move — read the stack again after one.";
  return base;
});

OPS.add_effect = function (args) {
  var op = "add_effect";
  var t = __esLayerArgs(args);
  var fx = __esRequireParade(t.l, op);
  __esRequireUnlocked(t.l, op);
  var req = args.matchName;
  var can = false;
  try { can = fx.canAddProperty(req); } catch (e) { can = false; }
  if (!can) {
    throw new Error(op + ": After Effects cannot add \"" + req + "\" to " + __esLayerLabel(t.l) + " — it is not the matchName (or display name) of an installed effect. list_available_effects({filter}) finds the matchName. Nothing was changed.");
  }
  var before = __esPrints(fx);
  fx.addProperty(req);
  fx = __esParade(t.l);
  var n = fx.numProperties;
  if (args.name !== undefined) fx.property(n).name = args.name;
  fx = __esParade(t.l);
  var after = __esPrints(fx);
  var problem = null;
  if (after.length !== before.length + 1) problem = "the stack went from " + before.length + " to " + after.length + " effects";
  else {
    problem = __esCompare(after.slice(0, before.length), before);
    if (!problem && args.name !== undefined && after[n - 1].name !== args.name) problem = "the new effect is named \"" + after[n - 1].name + "\", not \"" + args.name + "\"";
  }
  if (problem) {
    var removed = false;
    if (after.length === before.length + 1) { try { fx.property(n).remove(); removed = true; } catch (e2) {} }
    throw new Error(op + ": " + problem + ". " + (removed ? "The new effect was removed again." : "The stack could not be put back; read it with get_effect_stack.") );
  }
  return { added: __esRecord(fx, n), requested: req, numEffects: n };
};

OPS.remove_effect = function (args) {
  var op = "remove_effect";
  var t = __esLayerArgs(args);
  var fx = __esRequireParade(t.l, op);
  __esRequireUnlocked(t.l, op);
  var i = __esResolve(fx, args.effect, "effect", op);
  var target = fx.property(i);
  var exprsBefore = __esExprs(t.c);
  var hz = __esExprHazards(exprsBefore, t.l, { kind: "remove", index: i, name: target.name, matchName: target.matchName });
  if (hz.length && !args.ignoreExpressionReferences) __esRefuseHazards(op, hz);
  var removedRecord = __esRecord(fx, i);
  var before = __esPrints(fx);
  fx.property(i).remove();
  fx = __esParade(t.l);
  var expected = before.slice(0, i - 1).concat(before.slice(i));
  var problem = __esCompare(__esPrints(fx), expected);
  if (problem) {
    throw new Error(op + ": after removing effect " + i + ", " + problem + ". A removed effect cannot be rebuilt by script (its CUSTOM_VALUE data cannot be read), so nothing was restored — undo it in After Effects, then read the stack with get_effect_stack.");
  }
  var broken = __esNewlyBroken(exprsBefore, __esExprs(t.c));
  var out = { removed: removedRecord, previousIndex: i, numEffects: fx.numProperties, effects: __esCompact(fx) };
  if (hz.length) out.expressionReferencesIgnored = hz;
  if (broken.length) {
    out.expressionsBroken = broken;
    out.warning = "Removing the effect broke " + broken.length + " expression(s): " + __esBrokenText(broken) + ". Undo restores the effect.";
  }
  return out;
};

OPS.duplicate_effect = function (args) {
  var op = "duplicate_effect";
  var t = __esLayerArgs(args);
  var fx = __esRequireParade(t.l, op);
  __esRequireUnlocked(t.l, op);
  var i = __esResolve(fx, args.effect, "effect", op);
  var n = fx.numProperties;
  var exprsBefore = __esExprs(t.c);
  var hz = __esExprHazards(exprsBefore, t.l, { kind: "shift", from: i + 1, to: n + 1 });
  if (hz.length && !args.ignoreExpressionReferences) __esRefuseHazards(op, hz);
  var before = __esPrints(fx);
  fx.property(i).duplicate();
  fx = __esParade(t.l);
  var d = i + 1;
  if (args.name !== undefined && fx.numProperties === n + 1) fx.property(d).name = args.name;
  fx = __esParade(t.l);
  var after = __esPrints(fx);
  // The copy carries the source's whole body; only its name is AE's (or ours).
  var expected = before.slice(0, i).concat([{ name: args.name !== undefined ? args.name : null, matchName: before[i - 1].matchName, body: before[i - 1].body }]).concat(before.slice(i));
  var problem = __esCompare(after, expected);
  var broken = problem ? [] : __esNewlyBroken(exprsBefore, __esExprs(t.c));
  if (problem || (broken.length && !args.ignoreExpressionReferences)) {
    var undone = false;
    if (fx.numProperties === n + 1 && fx.property(d).matchName === before[i - 1].matchName) {
      try { fx.property(d).remove(); fx = __esParade(t.l); undone = __esCompare(__esPrints(fx), before) === null; } catch (e) {}
    }
    var why = problem ? "the duplicate did not come out as a copy of effect " + i + ": " + problem : "the duplicate broke " + broken.length + " expression(s): " + __esBrokenText(broken);
    throw new Error(op + ": " + why + ". " + (undone ? "The copy was removed again and the stack verified as it was." : "The stack could not be verified as restored; read it with get_effect_stack."));
  }
  var src = __esPrint(fx, i).scan;
  var out = {
    source: __esRecord(fx, i),
    duplicate: __esRecord(fx, d),
    preserved: {
      verified: "every readable value, keyframe (time, value, interpolation) and expression, enabled state and nested group, compared with the source",
      properties: src.leaves,
      keyedProperties: src.keyed,
      expressions: src.expressions,
    },
    numEffects: fx.numProperties,
    effects: __esCompact(fx),
  };
  if (src.custom) out.preserved.notComparable = src.custom + " CUSTOM_VALUE propert" + (src.custom === 1 ? "y" : "ies") + " (e.g. a Curves curve) that scripts cannot read; After Effects' own duplicate copies them, but this call could not verify it.";
  if (hz.length) out.expressionReferencesIgnored = hz;
  if (broken.length) out.expressionsBroken = broken;
  return out;
};

OPS.move_effect = function (args) {
  var op = "move_effect";
  var t = __esLayerArgs(args);
  var fx = __esRequireParade(t.l, op);
  __esRequireUnlocked(t.l, op);
  var s = __esResolve(fx, args.effect, "effect", op);
  var n = fx.numProperties;
  var given = 0, dest;
  if (args.to !== undefined && args.to !== null) given++;
  if (args.before) given++;
  if (args.after) given++;
  if (given !== 1) throw new Error(op + ": pass exactly one of to, before or after. Nothing was changed.");
  if (args.to === "beginning") dest = 1;
  else if (args.to === "end") dest = n;
  else if (args.to !== undefined && args.to !== null) throw new Error(op + ": to must be \"beginning\" or \"end\". Nothing was changed.");
  else {
    var rel = args.before ? "before" : "after";
    var r = __esResolve(fx, args[rel], rel, op);
    if (r === s) throw new Error(op + ": an effect cannot be moved " + rel + " itself (effect " + s + "). Nothing was changed.");
    if (rel === "before") dest = s < r ? r - 1 : r;
    else dest = s < r ? r : r + 1;
  }
  if (dest === s) {
    return { effect: __esRecord(fx, s), previousIndex: s, actualIndex: s, changed: false, numEffects: n, note: "Already there; nothing was written." };
  }
  var lo = Math.min(s, dest), hi = Math.max(s, dest);
  var exprsBefore = __esExprs(t.c);
  var hz = __esExprHazards(exprsBefore, t.l, { kind: "shift", from: lo, to: hi });
  if (hz.length && !args.ignoreExpressionReferences) __esRefuseHazards(op, hz);
  var before = __esPrints(fx);
  var expected = before.slice(0);
  var moving = expected.splice(s - 1, 1)[0];
  expected.splice(dest - 1, 0, moving);
  fx.property(s).moveTo(dest);
  fx = __esParade(t.l);
  var problem = __esCompare(__esPrints(fx), expected);
  var broken = problem ? [] : __esNewlyBroken(exprsBefore, __esExprs(t.c));
  if (problem || (broken.length && !args.ignoreExpressionReferences)) {
    var undone = __esRestoreOrder(t.l, before);
    var why = problem ? "the stack did not come out in the expected order: " + problem : "the move broke " + broken.length + " expression(s): " + __esBrokenText(broken);
    throw new Error(op + ": " + why + ". " + (undone ? "The effect was moved back and the stack verified as it was." : "The stack could not be verified as restored; read it with get_effect_stack."));
  }
  var out = { effect: __esRecord(fx, dest), previousIndex: s, actualIndex: dest, changed: true, numEffects: n, effects: __esCompact(fx) };
  if (hz.length) out.expressionReferencesIgnored = hz;
  if (broken.length) out.expressionsBroken = broken;
  return out;
};
