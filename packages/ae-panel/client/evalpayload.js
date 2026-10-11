// evalpayload.js — the one place a request becomes ExtendScript source text.
//
// Every op reaches After Effects as a string handed to CSInterface.evalScript,
// so the request has to be written *into* a script. It used to travel as a
// JSON string literal that dispatch() then ran through JSON.parse — and
// ExtendScript's native JSON.parse is pathologically slow on large input
// (measured on AE 26.5: 6.9 s for a 98 KB request that the ExtendScript
// compiler reads as a literal in 13 ms). So the request is now written as a
// data literal the compiler builds directly, and handed to dispatchValue().
//
// That is only safe because the literal can never be anything but data:
//
//   1. It is JSON.stringify output. JSON text contains no identifiers except
//      true/false/null, no operators except a leading minus, no calls and no
//      comments — every quote and backslash inside a string is escaped, so no
//      string can end early and let what follows run as code.
//   2. Every character outside printable ASCII is then written as \uXXXX.
//      JSON and JavaScript only disagree about U+2028/U+2029 (a line
//      terminator inside an ES3 string literal), and that cannot arise once
//      the text is pure ASCII; it also leaves nothing for the CEP→ExtendScript
//      string handoff to re-encode. The escape is only ever inside a string,
//      because JSON.stringify writes nothing non-ASCII anywhere else.
//   3. A request with an object key "__proto__" is NOT sent as a literal. In
//      an object literal that key sets the prototype; JSON.parse makes it an
//      own property. Such a request takes the JSON-string path, unchanged.
//
// Raw caller text is never concatenated into a script anywhere else. Anything
// that wants to send a value to ExtendScript goes through this module.

"use strict";

var NON_ASCII = /[^\x20-\x7e]/g;

function escapeChar(c) {
  var h = c.charCodeAt(0).toString(16);
  return "\\u" + "0000".slice(h.length) + h;
}

// JSON text, as an ExtendScript expression that evaluates to the same value.
// Pure printable ASCII. Throws on what JSON.stringify cannot represent.
function toLiteral(value) {
  var json = JSON.stringify(value === undefined ? null : value);
  return json.replace(NON_ASCII, escapeChar);
}

// True when the JSON text of a request has an object key the literal path
// would evaluate differently from JSON.parse. Conservative by construction:
// `"__proto__":` can only appear unescaped as a key (a string value is never
// followed by a colon, and a quote inside a string is written \"), and the one
// false positive — a key that itself contains `"__proto__` — just takes the
// slower path.
function hasProtoKey(json) {
  return json.indexOf('"__proto__":') !== -1;
}

// The script that runs one op. `literalDispatch` is whether the bundle loaded
// in ExtendScript defines dispatchValue(); a bundle that predates it is sent
// the JSON-string form it has always understood.
function buildDispatchScript(payload, literalDispatch) {
  var literal = toLiteral(payload);
  if (literalDispatch && !hasProtoKey(literal)) {
    return { script: "JSON.stringify(dispatchValue(" + literal + "))", mode: "literal", bytes: literal.length };
  }
  // The legacy form: the request's JSON as one string literal, which
  // dispatch() parses. toLiteral of a string is that string literal.
  return { script: "JSON.stringify(dispatch(" + toLiteral(JSON.stringify(payload)) + "))", mode: "json", bytes: literal.length };
}

module.exports = { toLiteral: toLiteral, hasProtoKey: hasProtoKey, buildDispatchScript: buildDispatchScript };
