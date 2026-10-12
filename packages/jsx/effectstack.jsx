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
    var nameOk = want.name === null || want.name === got.name;
    if (want.matchName === got.matchName && nameOk && want.body !== got.body) {
      // Same effect in the same place, different contents: say that, not
      // "X, expected X".
      return "effect " + (i + 1) + " (" + got.matchName + " \"" + got.name + "\") changed — a value, key, expression or its on/off state differs";
    }
    if (want.body !== got.body || !nameOk) {
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

// ---------------------------------------------------------------------------
// set_effect_enabled / set_effect_param — writes to one effect, by locator
// ---------------------------------------------------------------------------
// Both used to take a bare effectIndex, which after any add/remove/duplicate/
// move names whatever effect now sits there. Now: the effect by the C5 locator
// (__esResolve, fingerprint included), the lock refused by the C5 policy, the
// value through B1 (set_property_values for a static write, its validators for
// a key), and afterwards the whole stack checked by fingerprint — every other
// effect identical, and on the target everything but the one thing written.
// A failure puts the write back and says exactly what was and was not restored.

// The target, resolved and fingerprinted before anything is written.
function __esTarget(args, op) {
  var t = __esLayerArgs(args);
  var fx = __esRequireParade(t.l, op);
  __esRequireUnlocked(t.l, op);
  var i = __esResolve(fx, args.effect, "effect", op);
  return { c: t.c, l: t.l, i: i, before: __esRecord(fx, i), prints: __esPrints(fx) };
}

// A print's body is "matchName#on|off#" followed by one line per parameter.
// The header is split off by length, not by searching for "#": nothing is
// assumed about what a matchName or a value contains.
function __esBodyHead(pr) {
  var on = pr.body.substring(pr.matchName.length + 1, pr.matchName.length + 4) === "on#";
  return pr.matchName + "#" + (on ? "on" : "off") + "#";
}

// The stack now against the stack before: every other effect identical, the
// target identical apart from what `allowed(beforePrint, nowPrint)` excuses.
// Returns the first difference as a sentence, or null.
function __esUnintended(t, allowed) {
  var now = __esPrints(__esParade(t.l));
  if (now.length !== t.prints.length) return "the stack went from " + t.prints.length + " to " + now.length + " effects";
  for (var e = 0; e < now.length; e++) {
    if (e === t.i - 1) {
      var why = allowed(t.prints[e], now[e]);
      if (why) return why;
    } else if (now[e].full !== t.prints[e].full) {
      return "effect " + (e + 1) + " (" + now[e].matchName + " \"" + now[e].name + "\") changed too";
    }
  }
  return null;
}

// Undo this call's write with `restore` (null: nothing of this call landed),
// then verify the whole stack against the before-prints. The sentence says
// exactly which of the two held — never "nothing changed" unless the stack
// reads as it did.
function __esRollback(t, restore) {
  var restoreNote = null;
  if (restore) {
    try { restore(); } catch (e) { restoreNote = "putting the value back failed (" + __pwMsg(e) + ")"; }
  }
  var still = __esCompare(__esPrints(__esParade(t.l)), t.prints);
  if (!restoreNote && still === null) {
    return restore ? "The write was put back and the whole stack verified as it was before the call." :
      "Nothing of this call landed, and the whole stack verified as it was before the call.";
  }
  return "Rollback was INCOMPLETE: " +
    (restoreNote ? restoreNote + "; " : (restore ? "the write was put back, but " : "nothing of this call landed to put back, but ")) +
    (still === null ? "the stack nevertheless reads as it was" : "the stack still differs — " + still) +
    ". Read it with get_effect_stack and inspect_property_tree before retrying; Edit > Undo reverts the whole call.";
}

// How far a requested key time can be from where After Effects stores it —
// and, equally, how close two distinct keys can be. Measured on 26.5x89 in a
// 30 fps comp: AE rounds a key time to the nearest frameDuration/1024 (1/30720
// s): at 1 s, offsets of 0.25, 0.40 and 0.49 of that step land ON the key at
// 1 s, 0.51 to 1.4 make a distinct key one step later, 1.6 and 2 two steps
// later; 0.0123 → 0.0123046875. Past that, float32 spacing takes over (2^-11 s
// at 4096–8192 s, 2^-10 s at 8192–16384 s: 10000 + 1/120 is stored as
// 10000.0087890625, 0.00046 s off, and 10000 + 1e-5 lands ON the key at
// 10000). Every measured error was within one such step and no two distinct
// keys were closer than one. This tolerance only confirms that a key which
// demonstrably changed is the one asked for — it never stands in for a change:
// one step is also the gap between two distinct keys. Never relative:
// __pwClose's 1e-6 × t is 0.01 s at t = 10000 and took a key 1/120 s away for
// the one written.
function __esFloat32Spacing(t) {
  var a = Math.abs(t);
  if (!(a > 0)) return 0;
  var e = Math.floor(Math.log(a) / Math.LN2);
  if (Math.pow(2, e + 1) <= a) e++;
  if (Math.pow(2, e) > a) e--;
  return Math.pow(2, e - 23);
}
function __esKeyTimeTol(t, frameDuration) {
  var grid = frameDuration > 0 ? frameDuration / 1024 : 1 / 30720;
  return Math.max(grid, __esFloat32Spacing(t)) + 1e-12;
}

// Everything about one parameter a write could disturb besides the value it
// meant to set: every key (stored time, value, interpolation) and the
// expression with its on/off state.
function __esParamState(p) {
  var s = { keys: [], expr: "", exprOn: false };
  var n = 0;
  try { n = p.numKeys; } catch (e) { n = 0; }
  for (var k = 1; k <= n; k++) {
    var v = p.keyValue(k);
    var ii = null, oi = null;
    try { ii = p.keyInInterpolationType(k); oi = p.keyOutInterpolationType(k); } catch (e2) {}
    s.keys.push({ t: p.keyTime(k), v: v instanceof Array ? v.slice(0) : v, ii: ii, oi: oi });
  }
  try { s.expr = p.canSetExpression ? p.expression : ""; s.exprOn = !!p.expressionEnabled; } catch (e3) {}
  return s;
}
function __esSameKey(a, b) { return a.t === b.t && __pwSame(a.v, b.v) && a.ii === b.ii && a.oi === b.oi; }
function __esExprProblem(was, now, pname) {
  if (was.expr === now.expr && was.exprOn === now.exprOn) return null;
  return "the expression on \"" + pname + "\" changed as well (" + (was.expr === now.expr ? "on/off " + was.exprOn + " → " + now.exprOn : "its text") + ")";
}

OPS.set_effect_enabled = function (args) {
  var op = "set_effect_enabled";
  var t = __esTarget(args, op);
  var want = !!args.enabled;
  var was = t.before.enabled;
  if (was === want) {
    return { changed: false, previousEnabled: was, enabled: was, before: t.before, after: t.before, note: "Already " + (was ? "on" : "off") + "; nothing was written." };
  }
  __esParade(t.l).property(t.i).enabled = want;
  var problem = null;
  if (__esParade(t.l).property(t.i).enabled !== want) problem = "the write did not land: effect " + t.i + " still reads enabled " + was;
  else {
    // On the target only the on/off flag may differ.
    problem = __esUnintended(t, function (b, n) {
      var flipped = b.matchName + "#" + (want ? "on" : "off") + "#" + b.body.substring(__esBodyHead(b).length);
      return (n.body === flipped && n.name === b.name) ? null : "a parameter or the name of effect " + t.i + " changed as well";
    });
  }
  if (problem) {
    throw new Error(op + ": " + problem + ". " + __esRollback(t, function () { __esParade(t.l).property(t.i).enabled = was; }));
  }
  return { changed: true, previousEnabled: was, enabled: want, before: t.before, after: __esRecord(__esParade(t.l), t.i) };
};

OPS.set_effect_param = function (args) {
  var op = "set_effect_param";
  var keyed = __checkTimeKeyframe(args.time, args.keyframe, op);
  var t = __esTarget(args, op);
  var eff = __esParade(t.l).property(t.i);
  var effLabel = "effect " + t.i + " (" + eff.matchName + " \"" + eff.name + "\")";

  // The parameter: a direct parameter of this effect, matchName first and the
  // display name as the fallback. Two matches is refused, never the first.
  var pi = 0, matches = 0, j;
  if (args.paramMatchName) {
    for (j = 1; j <= eff.numProperties; j++) if (eff.property(j).matchName === args.paramMatchName) { pi = j; matches++; }
  }
  if (!matches && args.paramName) {
    for (j = 1; j <= eff.numProperties; j++) if (eff.property(j).name === args.paramName) { pi = j; matches++; }
  }
  var asked = (args.paramMatchName ? "\"" + args.paramMatchName + "\"" : "") + (args.paramMatchName && args.paramName ? " / " : "") + (args.paramName ? "\"" + args.paramName + "\"" : "");
  if (matches === 0) throw new Error(op + ": " + effLabel + " has no parameter " + asked + ". inspect_property_tree with the effect's path lists them. Nothing was changed.");
  if (matches > 1) throw new Error(op + ": " + asked + " matches " + matches + " parameters of " + effLabel + ". Pass paramMatchName, or use inspect_property_tree and set_property_values with the exact path. Nothing was changed.");
  var path = [__ES_PARADE, t.i, pi];
  var p = eff.property(pi);
  var pmn = p.matchName, pname = p.name;
  if (__itIsGroup(p)) throw new Error(op + ": " + asked + " on " + effLabel + " is a group, not a parameter — inspect_property_tree and set_property_values reach what is inside it. Nothing was changed.");

  var written, restore = null, problem = null;
  var S0 = __esParamState(p);
  if (!keyed) {
    // ---- static: B1 validates, writes, reads back and rolls itself back ----
    var prevRaw = __pwRead(p, __pwExpressionOn(p), t.c.time);
    var res;
    try {
      res = OPS.set_property_values({ compId: t.c.id, layerId: t.l.id, updates: [{ path: path, value: args.value }] });
    } catch (eB) {
      // B1's sentence covers its own write. It cannot see the rest of the
      // stack, so its "nothing changed" is repeated only once the whole stack
      // verifies as it was; otherwise the error says what still differs.
      var m = __pwMsg(eB);
      if (m.indexOf("set_property_values: ") === 0) m = m.substring("set_property_values: ".length);
      else if (m.indexOf("set_property_values on ") === 0) m = m.substring("set_property_values on ".length);
      var still = __esCompare(__esPrints(__esParade(t.l)), t.prints);
      if (still === null) throw new Error(op + " on " + effLabel + ": " + m);
      var cut = -1, ends = [". Nothing had been written", ". Rolled back every write", ". Rollback was INCOMPLETE", ". Nothing was changed"];
      for (var c2 = 0; c2 < ends.length; c2++) { var at2 = m.indexOf(ends[c2]); if (at2 >= 0 && (cut < 0 || at2 < cut)) cut = at2; }
      var head = cut >= 0 ? m.substring(0, cut) : m;
      var b1Rolled = cut >= 0 && m.indexOf(". Rolled back every write") === cut;
      throw new Error(op + " on " + effLabel + ": " + head + ". Rollback was INCOMPLETE: " +
        (b1Rolled ? "set_property_values put its own write back, but " : "") +
        "the stack still differs — " + still + ". Read it with get_effect_stack and inspect_property_tree before retrying; Edit > Undo reverts the whole call.");
    }
    written = res.updates[0];
    restore = function () { walkProperty(t.l, path).setValue(prevRaw); };
    // The value is B1's to verify; everything else about the parameter is ours.
    var S1s = __esParamState(walkProperty(t.l, path));
    if (S1s.keys.length !== 0) problem = "\"" + pname + "\" gained " + S1s.keys.length + " keyframe(s)";
    else problem = __esExprProblem(S0, S1s, pname);
  } else {
    // ---- one key: B1's value rules, AE's own key, the key read back ----
    var vt = __pvtName(p.propertyValueType);
    var label = "\"" + pname + "\" (" + pmn + ", " + vt + ")";
    var isVec = __PW_VECTOR_DIMS[vt] !== undefined;
    if (vt !== "OneD" && vt !== "COLOR" && !isVec) throw new Error(op + ": " + label + " cannot be keyed by this tool — set_keyframes with the path from inspect_property_tree handles every keyable type. Nothing was changed.");
    var canVary = true;
    try { canVary = p.canVaryOverTime; } catch (eC) {}
    if (!canVary) throw new Error(op + ": " + label + " cannot be animated. Nothing was changed.");
    var v = args.value, w;
    if (vt === "OneD") {
      if (!__pwIsNum(v)) throw new Error(op + ": " + label + " takes a single number, got " + __pwJson(v) + ". Nothing was changed.");
      var dd = false;
      try { dd = !!p.isDropdownEffect; } catch (eD) {}
      if (dd && !__pwIsInt(v)) throw new Error(op + ": " + label + " is a menu and takes a whole number, got " + v + ". Nothing was changed.");
      var rr = __pwRange(p, v);
      if (rr) throw new Error(op + ": " + label + ": " + v + " " + rr + ". Nothing was changed.");
      w = v;
    } else {
      var dims = isVec ? __PW_VECTOR_DIMS[vt] : 4;
      var okLen = vt === "COLOR" ? (__pwIsArray(v) && (v.length === 3 || v.length === 4)) : (__pwIsArray(v) && v.length === dims);
      if (!okLen) throw new Error(op + ": " + label + " takes " + (vt === "COLOR" ? "[r, g, b] or [r, g, b, a]" : "exactly " + dims + " numbers") + ", got " + __pwJson(v) + ". Nothing was changed.");
      var np = __pwNumbers(p, v);
      if (np) throw new Error(op + ": " + label + ": " + np + ". Nothing was changed.");
      w = v.slice(0);
      if (vt === "COLOR" && w.length === 3) { var cur = p.valueAtTime(args.time, true); w.push(cur && cur.length === 4 ? cur[3] : 1); }
    }
    try { p.setValueAtTime(args.time, w); }
    catch (eK) { throw new Error(op + ": After Effects refused " + __pwJson(w) + " for " + label + " at " + args.time + " s: " + __pwMsg(eK) + ". " + __esRollback(t, null)); }

    // Which key did the write make or change? Decided by comparing the key
    // list before and after by STORED time — exact, since an untouched key
    // keeps its stored time to the bit — and never by "the nearest key".
    var tol = __esKeyTimeTol(args.time, t.c.frameDuration);   // one stored-time step at this time
    var S1 = __esParamState(walkProperty(t.l, path));
    var K0 = S0.keys, K1 = S1.keys, land = -1, landNew = false, kk, kj;
    if (K1.length === K0.length + 1) {
      var fresh = [];
      for (kk = 0; kk < K1.length; kk++) {
        var known = false;
        for (kj = 0; kj < K0.length; kj++) if (K0[kj].t === K1[kk].t) { known = true; break; }
        if (!known) fresh.push(kk);
      }
      if (fresh.length === 1) { land = fresh[0]; landNew = true; }
      else problem = "the keys of \"" + pname + "\" moved: " + fresh.length + " key times are new";
    } else if (K1.length === K0.length) {
      var changed = [];
      for (kk = 0; kk < K1.length; kk++) {
        if (K1[kk].t !== K0[kk].t) { problem = "the key at " + K0[kk].t + " s of \"" + pname + "\" moved to " + K1[kk].t + " s"; break; }
        if (!__esSameKey(K1[kk], K0[kk])) changed.push(kk);
      }
      if (!problem && changed.length) {
        // A key changed: the write is the changed key nearest the requested
        // time, within one stored-time step (AE stores a time that close ON the
        // existing key — 10000 + 1e-5 updates the key at 10000).
        var best = -1, bestD = Infinity;
        for (kj = 0; kj < changed.length; kj++) {
          var d = Math.abs(K1[changed[kj]].t - args.time);
          if (d < bestD) { bestD = d; best = changed[kj]; }
        }
        if (bestD <= tol) land = best;
      } else if (!problem) {
        // Nothing changed. That is a no-op on a key only if the requested time
        // IS that key's stored time: one storage step is also the closest two
        // distinct keys can be (1 s and 1 + (1/30)/1024 s are two keys), so
        // proximity cannot tell a no-op from a write that never landed.
        for (kk = 0; kk < K1.length; kk++) if (K1[kk].t === args.time && __pwSame(K1[kk].v, w)) { land = kk; break; }
        if (land < 0) {
          for (kk = 0; kk < K1.length; kk++) {
            if (Math.abs(K1[kk].t - args.time) <= tol && __pwSame(K1[kk].v, w)) {
              problem = "no key changed: \"" + pname + "\" already holds " + __pwJson(w) + " at " + K1[kk].t + " s, but that is not the requested " + args.time + " s, and since nothing changed the write cannot be shown to have landed on it rather than been dropped — pass the stored time " + K1[kk].t + " to address that key, or a different value";
              break;
            }
          }
        }
      }
    } else {
      problem = "\"" + pname + "\" went from " + K0.length + " to " + K1.length + " keys";
    }
    if (!problem && land < 0) {
      var near = -1, nearD = Infinity;
      for (kk = 0; kk < K1.length; kk++) { var dn = Math.abs(K1[kk].t - args.time); if (dn < nearD) { nearD = dn; near = kk; } }
      problem = "the key did not land: requested " + __pwJson(w) + " at " + args.time + " s, and After Effects has no such key there" +
        (near >= 0 ? " (the nearest is " + __pwJson(K1[near].v) + " at " + K1[near].t + " s, " + nearD + " s away — a different key)" : "");
    }
    if (land >= 0) {
      var storedT = K1[land].t;
      var prevV = landNew ? null : K0[land].v;
      restore = landNew ?
        function () { var q = walkProperty(t.l, path); for (var r = 1; r <= q.numKeys; r++) if (q.keyTime(r) === storedT) { q.removeKey(r); return; } } :
        function () { walkProperty(t.l, path).setValueAtTime(storedT, prevV); };
      if (!problem && Math.abs(storedT - args.time) > tol) problem = "the key landed at " + storedT + " s, not " + args.time + " s";
      if (!problem && !__pwSame(K1[land].v, w)) problem = "the key did not land: requested " + __pwJson(w) + " at " + args.time + " s, After Effects reads " + __pwJson(K1[land].v);
      // Every other key exactly as it was.
      if (!problem) {
        var rest0 = [], rest1 = [];
        for (kk = 0; kk < K0.length; kk++) if (landNew || kk !== land) rest0.push(K0[kk]);
        for (kk = 0; kk < K1.length; kk++) if (kk !== land) rest1.push(K1[kk]);
        for (kk = 0; kk < rest0.length && !problem; kk++) {
          if (!__esSameKey(rest0[kk], rest1[kk])) problem = "the key at " + rest0[kk].t + " s of \"" + pname + "\" changed as well (" + __pwJson(rest0[kk].v) + " → " + __pwJson(rest1[kk].v) + ")";
        }
      }
      written = { previousValue: prevV, actualValue: K1[land].v, storedTime: storedT };
    }
    if (!problem) problem = __esExprProblem(S0, S1, pname);
  }
  if (problem) throw new Error(op + ": " + problem + ". " + __esRollback(t, restore));

  // ---- the rest of the stack, and the rest of this effect, untouched ----
  var prefix = "/" + pmn + "=";
  problem = __esUnintended(t, function (b, n) {
    function others(pr) {
      var head = __esBodyHead(pr);
      var lines = pr.body.substring(head.length).split("\n"), out = [head];
      for (var k = 0; k < lines.length; k++) if (lines[k].indexOf(prefix) !== 0) out.push(lines[k]);
      return out.join("\n");
    }
    return (others(n) === others(b) && n.name === b.name) ? null : "another parameter (or the name or on/off state) of effect " + t.i + " changed as well";
  });
  if (problem) throw new Error(op + ": " + problem + ". " + __esRollback(t, restore));

  var out = {
    ok: true,
    keyed: keyed,
    path: path,
    param: { name: pname, matchName: pmn, previousValue: written.previousValue, actualValue: written.actualValue, time: keyed ? args.time : null },
    before: t.before,
    after: __esRecord(__esParade(t.l), t.i),
  };
  if (keyed) out.param.storedTime = written.storedTime;   // where AE keeps the key (nearest frameDuration/1024, or float32 spacing)
  if (written.expressionEnabled) { out.param.expressionEnabled = true; out.param.evaluatedValue = written.evaluatedValue; }
  return out;
};
