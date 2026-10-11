import { z } from "zod";

/**
 * Single source of truth for op input contracts. The MCP server uses these as
 * tool input schemas (via zod-to-json-schema). The ExtendScript side validates
 * loosely — it trusts that the MCP server already validated.
 */

// ---------- primitives ----------
export const Color = z.tuple([z.number(), z.number(), z.number()]).describe("RGB 0..1");
export const ColorRGBA = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const Vec2 = z.tuple([z.number(), z.number()]);
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const VecAny = z.union([z.number(), Vec2, Vec3, z.array(z.number())]);

/**
 * Names of After Effects' own enumerations, looked up by name in the JSX
 * (`BlendingMode[name]` and friends). Until these were closed lists, a name AE
 * did not recognise looked up `undefined`, the handler kept the old value, and
 * the call reported success — `blendingMode: "TOTALLY_FAKE_MODE"` was a no-op
 * with `{ok:true}`. The schema now refuses anything off the list, and the JSX
 * refuses any name its running AE does not define, before it changes anything.
 *
 * The lists are AE's documented enumerations, every member of each checked
 * against `BlendingMode` / `TrackMatteType` / `MaskMode` in a live AE 26 — see
 * docs/fragile-areas-ae.md. `SILHOUETE_ALPHA` is AE's own spelling.
 */
export const BLENDING_MODES = [
  "NORMAL", "DISSOLVE", "DANCING_DISSOLVE",
  "DARKEN", "MULTIPLY", "COLOR_BURN", "CLASSIC_COLOR_BURN", "LINEAR_BURN", "DARKER_COLOR",
  "ADD", "LIGHTEN", "SCREEN", "COLOR_DODGE", "CLASSIC_COLOR_DODGE", "LINEAR_DODGE", "LIGHTER_COLOR",
  "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "LINEAR_LIGHT", "VIVID_LIGHT", "PIN_LIGHT", "HARD_MIX",
  "DIFFERENCE", "CLASSIC_DIFFERENCE", "EXCLUSION", "SUBTRACT", "DIVIDE",
  "HUE", "SATURATION", "COLOR", "LUMINOSITY",
  "STENCIL_ALPHA", "STENCIL_LUMA", "SILHOUETE_ALPHA", "SILHOUETTE_LUMA",
  "ALPHA_ADD", "LUMINESCENT_PREMUL",
] as const;
export const TRACK_MATTE_TYPES = ["NO_TRACK_MATTE", "ALPHA", "ALPHA_INVERTED", "LUMA", "LUMA_INVERTED"] as const;
export const MASK_MODES = ["NONE", "ADD", "SUBTRACT", "INTERSECT", "LIGHTEN", "DARKEN", "DIFFERENCE"] as const;

export const PropertyPath = z
  .array(z.union([z.string(), z.number()]))
  .min(1)
  .describe("Dotted property path into a layer, e.g. ['Transform','Position'] or ['Effects','Gaussian Blur','Blurriness'].");

export const Interpolation = z.object({
  in: z.enum(["linear", "bezier", "hold"]).optional(),
  out: z.enum(["linear", "bezier", "hold"]).optional(),
  easeIn: z.object({ influence: z.number(), speed: z.number() }).optional(),
  easeOut: z.object({ influence: z.number(), speed: z.number() }).optional(),
});

/**
 * The scoping vocabulary shared by the read tools. Every one of them names the
 * optional sections of its own response; omitting `include` returns all of them,
 * which is what every caller written before this existed already gets. `[]`
 * returns the identifying core alone — the cheapest useful answer.
 */
const includeParam = <T extends [string, ...string[]]>(sections: T, hint: string) =>
  z
    .array(z.enum(sections))
    .optional()
    .describe(`Sections to return: ${sections.join(", ")}. Omit for all of them; [] for ${hint}.`);

// ---------- cross-field rules ----------
/**
 * The rules about which *combinations* of fields are legal — "exactly one of
 * these three", "at least one of these two".
 *
 * **`zod-to-json-schema` drops refinements.** A `.refine()` is invisible in the
 * JSON Schema the model is shown, so the only way an agent learns the rule is
 * by breaking it: the call goes out, the server rejects it, and a turn is spent
 * on something the tool definition could have said up front. Three separate
 * 0.4.0 features landed on that edge independently (`reorder_layer`'s three
 * destinations, `screenshot_frame`'s `time`/`times`, `run_jsx`'s
 * `code`/`scriptPath`), and two more rules were being enforced further down
 * still — `set_temporal_ease` inside After Effects, `set_effect_param` as a
 * bare "Effect param not found".
 *
 * So a rule is **declared once, here**, and three things are generated from
 * that single declaration:
 *
 *   1. the zod check that rejects the call (`crossField`, below),
 *   2. the JSON Schema keywords the model sees before it calls
 *      (`crossFieldJsonSchema`, applied in `server.ts`'s emission pass),
 *   3. the sentence in the error when it is broken anyway
 *      (`crossFieldMessage`).
 *
 * Declaring it in one place is the point. A rule enforced in zod and described
 * in prose somewhere else is two statements that drift; the drift is invisible,
 * because the schema keeps working and only the *advice* goes stale.
 *
 * `tests/unit/schema-constraints.mjs` enumerates every `ZodEffects` in every op
 * schema and fails on any that is not one of these — a refinement it cannot
 * classify is the exact thing it exists to catch, so it throws rather than
 * skipping.
 */
export type CrossFieldKind =
  /** Exactly one field present. Neither zero nor two. */
  | "exactlyOne"
  /** Zero or one. Both together are two readings of the same question. */
  | "atMostOne"
  /** One or more. Zero means the call would do nothing. */
  | "atLeastOne"
  /**
   * `fields[0]` is present exactly when the boolean `fields[1]` is `true` —
   * `time` and `keyframe: true` go together. Either one alone is a write whose
   * meaning the other would have to supply: a `time` with no keyframe would be
   * a static write that ignores the time, and `keyframe: true` with no time has
   * no moment to key. Exactly two fields; the second must be a boolean.
   */
  | "requiresFlag";

export interface CrossFieldRule {
  kind: CrossFieldKind;
  /** At least two — a rule about one field is just `.optional()` or not. */
  fields: readonly [string, string, ...string[]];
  /**
   * Appended to the error. Say what to pass *instead*, not what went wrong —
   * the rest of the message already covers that.
   */
  then?: string;
}

/** Where `crossField` stashes the rule so the emission pass can find it again. */
export const CROSS_FIELD_RULE = Symbol.for("engineRoom.aeMcp.crossFieldRule");

const backticked = (fields: readonly string[]) => fields.map((f) => "`" + f + "`");

const joinWith = (parts: readonly string[], conjunction: string) => {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} ${conjunction} ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} ${conjunction} ${parts[parts.length - 1]}`;
};

/**
 * The sentence an agent gets when it breaks the rule.
 *
 * It has to do two things a raw zod dump does not: name **which** fields
 * arrived, and say what to do next. "Pass exactly one of a, b or c" is the same
 * sentence whether you passed none or all three, and an agent that cannot tell
 * those apart re-sends the same mistake.
 */
export function crossFieldMessage(rule: CrossFieldRule, present: readonly string[]): string {
  if (rule.kind === "requiresFlag") {
    const [value, flag] = rule.fields;
    const has = (f: string) => present.includes(f);
    const head = `\`${value}\` and \`${flag}: true\` go together`;
    const body =
      has(value) && !has(flag)
        ? ` — got \`${value}\` without \`${flag}: true\`, which would be a static write that ignores the time. Add \`${flag}: true\` to key the value at that time, or drop \`${value}\` to set it statically.`
        : has(flag) && !has(value)
          ? ` — got \`${flag}: true\` without \`${value}\`, so there is no moment to key. Pass \`${value}\`, or drop \`${flag}\` to set the value statically.`
          : has(value) && has(flag)
            ? ` — both were passed, which keys the value at \`${value}\`; drop both to set it statically instead.`
            : ` — neither \`${value}\` nor \`${flag}\` was passed, which sets the value statically; pass both to key it.`;
    return head + body + (rule.then ? " " + rule.then : "");
  }
  const want = joinWith(backticked(rule.fields), "or");
  const got = joinWith(backticked(present), "and");
  const head =
    rule.kind === "exactlyOne"
      ? `Pass exactly one of ${want}`
      : rule.kind === "atLeastOne"
        ? `Pass at least one of ${want}`
        : `Pass at most one of ${want}`;
  const body =
    present.length === 0
      ? rule.fields.length === 2
        ? " — neither was passed."
        : " — none of them was passed."
      : ` — got ${got}. Keep the one you meant and drop ${present.length === 2 ? "the other" : "the others"}.`;
  return head + body + (rule.then ? " " + rule.then : "");
}

/** Which of the rule's fields the caller actually sent. */
export function crossFieldPresent(rule: CrossFieldRule, value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  // For `requiresFlag` the flag counts as present only when it is `true`: a
  // defaulted or explicit `false` is the flag saying "no".
  if (rule.kind === "requiresFlag") {
    return rule.fields.filter((f, i) => (i === 1 ? obj[f] === true : obj[f] !== undefined));
  }
  return rule.fields.filter((f) => obj[f] !== undefined);
}

export function crossFieldSatisfied(rule: CrossFieldRule, value: unknown): boolean {
  const n = crossFieldPresent(rule, value).length;
  if (rule.kind === "requiresFlag") return n === 0 || n === 2;
  if (rule.kind === "exactlyOne") return n === 1;
  if (rule.kind === "atLeastOne") return n >= 1;
  return n <= 1;
}

/**
 * The JSON Schema form of a rule, in draft 2020-12 and nothing else.
 *
 * All three shapes are plain composition over `required`, which is the oldest
 * and most portable part of JSON Schema — no `if`/`then`, no `dependentRequired`,
 * nothing a converter or a client is likely to have skipped. `oneOf` means
 * exactly one subschema matches, and a subschema that only says
 * `{"required": ["x"]}` matches precisely when `x` is present, so `oneOf` over
 * one-element `required` lists *is* exclusive choice.
 *
 * Nothing here narrows what was already legal in a way the zod check does not:
 * `tests/unit/schema-constraints.mjs` probes every combination of the rule's
 * fields against both and fails if the two disagree on a single one.
 */
export function crossFieldJsonSchema(rule: CrossFieldRule): Record<string, unknown> {
  if (rule.kind === "requiresFlag") {
    // Still plain composition: both present with the flag `true`, or the value
    // absent and the flag anything but `true` (absent included — `properties`
    // constrains a key only when it is there).
    const [value, flag] = rule.fields;
    return {
      anyOf: [
        { required: [value, flag], properties: { [flag]: { const: true } } },
        { not: { required: [value] }, properties: { [flag]: { not: { const: true } } } },
      ],
    };
  }
  const each = rule.fields.map((f) => ({ required: [f] }));
  if (rule.kind === "exactlyOne") return { oneOf: each };
  if (rule.kind === "atLeastOne") return { anyOf: each };
  // "at most one" is the absence of every pair. Written as a negated `anyOf`
  // rather than as `oneOf` + an all-absent branch, because the negation is what
  // the rule actually says and reads that way to anything parsing it.
  const pairs: { required: string[] }[] = [];
  for (let i = 0; i < rule.fields.length; i++) {
    for (let j = i + 1; j < rule.fields.length; j++) {
      pairs.push({ required: [rule.fields[i], rule.fields[j]] });
    }
  }
  return { not: pairs.length === 1 ? pairs[0] : { anyOf: pairs } };
}

/**
 * Attach a rule to an object schema.
 *
 * Returns a `ZodEffects`, so anything reaching for `.shape` on the result needs
 * `objectShapeOf()` instead — that is the one cost of this, and it is why the
 * helper exists.
 */
function crossField<T extends z.ZodTypeAny>(schema: T, rule: CrossFieldRule) {
  const refined = schema.superRefine((value, ctx) => {
    if (crossFieldSatisfied(rule, value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: crossFieldMessage(rule, crossFieldPresent(rule, value)),
      // The first field of the rule, so the issue has somewhere to point. The
      // message names all of them, which is the part that matters.
      path: [rule.fields[0]],
    });
  });
  Object.defineProperty(refined, CROSS_FIELD_RULE, { value: rule, enumerable: false });
  return refined;
}

/** The rule attached to a schema node by `crossField`, if it carries one. */
export function crossFieldRuleOf(node: unknown): CrossFieldRule | undefined {
  if (!node || typeof node !== "object") return undefined;
  return (node as Record<symbol, CrossFieldRule | undefined>)[CROSS_FIELD_RULE];
}

/**
 * Where a rule sits inside a schema. `[]` is "into this array's element", so
 * `["cues", "[]"]` is the object inside `cues: z.array(...)`. An empty path is
 * the op's own arguments object.
 */
export const ARRAY_ELEMENT = "[]";

/**
 * Every refinement in a schema, located.
 *
 * **A refinement with no rule on it is returned with `rule: undefined`**, and
 * that is the whole reason this returns a list rather than a map. The emission
 * pass and the guard test both need to see an unclassified `ZodEffects` — one
 * is a constraint that will not reach the model, and silently walking past it
 * is the failure both of them exist to catch.
 */
export function crossFieldRulesIn(
  schema: unknown
): { path: string[]; rule: CrossFieldRule | undefined }[] {
  const found: { path: string[]; rule: CrossFieldRule | undefined }[] = [];
  const walk = (node: unknown, path: string[], depth: number): void => {
    const def = (node as { _def?: { typeName?: string; [k: string]: unknown } } | undefined)?._def;
    if (!def || depth > 16) return;
    switch (def.typeName) {
      case "ZodEffects":
        found.push({ path: [...path], rule: crossFieldRuleOf(node) });
        return walk(def.schema, path, depth + 1);
      case "ZodOptional":
      case "ZodDefault":
      case "ZodNullable":
      case "ZodReadonly":
        return walk(def.innerType, path, depth + 1);
      case "ZodObject": {
        const shape = (def.shape as () => Record<string, unknown>)();
        for (const key of Object.keys(shape)) walk(shape[key], [...path, key], depth + 1);
        return;
      }
      case "ZodArray":
        return walk(def.type, [...path, ARRAY_ELEMENT], depth + 1);
      case "ZodUnion":
      case "ZodDiscriminatedUnion": {
        const options = def.options as unknown[] | Map<unknown, unknown>;
        const list = Array.isArray(options) ? options : [...(options as Map<unknown, unknown>).values()];
        // Union branches share one JSON Schema location, so a rule inside one
        // has nowhere unambiguous to be injected. None exists today; the walk
        // still descends so the guard test can refuse one that appears.
        for (const opt of list) walk(opt, path, depth + 1);
        return;
      }
      default:
        return;
    }
  };
  walk(schema, [], 0);
  return found;
}

/**
 * The object shape under any number of `.superRefine()` wrappers.
 *
 * `ZodEffects` has no `.shape`, so a schema gains one the day a cross-field
 * rule is attached to it — and the caller that broke is never the one that
 * added the rule.
 */
export function objectShapeOf(schema: unknown): Record<string, z.ZodTypeAny> | undefined {
  let cur = schema as { _def?: { typeName?: string; schema?: unknown }; shape?: unknown };
  for (let i = 0; i < 16 && cur?._def?.typeName === "ZodEffects"; i++) {
    cur = cur._def.schema as typeof cur;
  }
  const shape = (cur as z.ZodObject<z.ZodRawShape> | undefined)?.shape;
  return shape as Record<string, z.ZodTypeAny> | undefined;
}

// ---------- comps ----------
export const ListComps = z
  .object({
    include: includeParam(["size", "timing", "bg", "counts"], "id + name only"),
  })
  .strict();
export const GetComp = z.object({ compId: z.number() });
export const GetCompTree = z.object({ compId: z.number(), depth: z.number().int().min(0).max(8).default(2) });
export const CreateComp = z.object({
  name: z.string().default("Untitled"),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  frameRate: z.number().positive().default(30),
  duration: z.number().positive().default(5),
  pixelAspect: z.number().positive().default(1),
  bgColor: Color.optional(),
});
export const SetComp = z.object({
  compId: z.number(),
  name: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  duration: z.number().positive().optional(),
  workAreaStart: z.number().optional(),
  workAreaDuration: z.number().positive().optional(),
  bgColor: Color.optional(),
});
export const DeleteComp = z
  .object({
    compId: z.number(),
    purgeUnusedSolids: z.boolean().default(false)
      .describe(
        "Also remove the solid footage items this comp's own layers used, once nothing else uses them. Off by default because a solid can be shared: one another comp still uses is kept and reported with the comps using it."
      ),
  })
  .strict();
export const SetActiveComp = z.object({ compId: z.number() });
export const DuplicateComp = z
  .object({
    compId: z.number(),
    name: z.string().optional().describe("Name for the copy. Omit to take AE's own ('<name> 2')."),
    folderId: z.number().optional()
      .describe("Project folder to put the copy in. Must be a folder item id from get_project_summary."),
    deep: z.boolean().default(false)
      .describe(
        "Also duplicate the nested precomps and re-point the copy's layers at them. Off by default, which matches AE's own Duplicate: a shallow copy shares its nested comps with the original, so editing one edits both."
      ),
    nameSuffix: z.string().optional()
      .describe("With deep:true, name each duplicated nested comp '<original><nameSuffix>'. Omit to let AE name them."),
  })
  .strict();
export const GetCurrentTime = z
  .object({
    compId: z.number().optional()
      .describe("Comp to read the playhead from. Omit to use the comp active in the viewer."),
  })
  .strict();
export const SetCurrentTime = crossField(
  z.object({
    compId: z.number().optional()
      .describe("Comp whose playhead to move. Omit to use the comp active in the viewer."),
    time: z.number().finite().nonnegative().optional()
      .describe("Target time in seconds, >= 0. Exactly one of `time` or `frame`."),
    frame: z.number().int().nonnegative().optional()
      .describe("Target frame number — an integer >= 0, converted to seconds as frame / comp.frameRate. Exactly one of `time` or `frame`."),
  }).strict(),
  // Refused outside the comp's own 0..duration rather than left to AE: nothing
  // in this codebase has ever measured what comp.time does with a value
  // outside that range, so the JSX handler checks it explicitly too — this
  // rule alone can't, since duration is only known once a comp is resolved.
  {
    kind: "exactlyOne",
    fields: ["time", "frame"],
    then: "`frame` converts to seconds as frame / comp.frameRate — pass whichever you already have.",
  }
);

// ---------- comp snapshots (half server-resident: the panel gathers, the server remembers) ----------
export const SnapshotComp = z
  .object({
    compId: z.number(),
    includeFingerprint: z.boolean().default(false)
      .describe(
        "Return the fingerprint itself as well as its id. Off by default — returning it reintroduces exactly the context cost a snapshot exists to avoid."
      ),
  })
  .strict();
export const DiffComp = z
  .object({
    since: z.string().describe("A snapshotId from an earlier snapshot_comp or diff_comp."),
    compId: z.number().optional().describe("Defaults to the comp the snapshot was taken of; pass it only to assert which comp you mean."),
    includeFingerprint: z.boolean().default(false)
      .describe("Return the new fingerprint as well as the diff. Off by default."),
  })
  .strict();

// ---------- layers ----------
// The sections __layerSummary (layers.jsx) can add to its id/index/name/type
// core. One list for list_layers and find_layers, because both read through
// that one function — a section named here and not there is a field the
// schema advertises and the panel never fills, which no test can see.
export const LAYER_SUMMARY_SECTIONS: ["flags", "timing", "parent"] = ["flags", "timing", "parent"];
export const ListLayers = z.object({
  compId: z.number(),
  include: includeParam(LAYER_SUMMARY_SECTIONS, "the id/index/name/type map alone"),
});
export const GetLayerFull = z.object({
  compId: z.number(),
  layerId: z.number(),
  includeChildren: z.boolean().default(false),
  include: includeParam(
    ["transform", "effects", "masks", "markers", "bounds", "text", "shape", "source"],
    "the layer header alone"
  ),
  maxKeyframes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Cap the keyframes serialized per property. Over the cap you get the first and last few plus a count of what was omitted — never a silent truncation. Omit for all of them."
    ),
  shapeDepth: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe("How deep to walk a shape layer's Contents tree. Default 4; drop to 1-2 on heavy shape layers."),
  // Not a member of `include`: that list's contract is that omitting it returns
  // everything, and materials have to be off unless asked for.
  shapeMaterials: z
    .boolean()
    .default(false)
    .describe(
      "Include each shape group's Material Options — the 48-property 3D extrusion block. Off by default: it applies only to an extruded shape under the Cinema 4D renderer, and on an ordinary 2D shape layer it is most of the bytes of the read. What was skipped is counted in the response."
    ),
  shapeDetail: z
    .enum(["full", "compact"])
    .optional()
    .describe(
      "How to serialize a shape layer's Contents. 'full' (default) is one JSON node per property. 'compact' is one indented line per group with that group's own properties folded onto it as name=value — several times smaller, and enough to see what a layer is made of and address its nodes by name."
    ),
});

export const CreateTextLayer = z.object({
  compId: z.number(),
  text: z.string().default(""),
  font: z.string().optional(),
  size: z.number().positive().optional(),
  color: Color.optional(),
  position: VecAny.optional(),
  tracking: z.number().optional()
    .describe("Letter-spacing. Omit it and the layer is created with tracking 0, because AE's addText() otherwise inherits whatever the user's Character panel was last left on (-20 is common) and the same call then renders differently on two machines. Not normalised when anchorAlign is 'none'."),
  anchorAlign: z.enum(["left", "center", "right", "none"]).default("left")
    .describe("How the text aligns to `position`, implemented as live paragraph justification with the anchor point left at [0,0]. Default 'left' makes `position` the start of the first baseline; 'center' and 'right' put it at the centre/end. Because it is justification rather than a measured anchor offset, the alignment stays correct when the Source Text changes later — retyped, driven by an expression, or edited through Essential Graphics. 'none' leaves AE's raw defaults alone: no justification, no anchor move, no tracking reset."),
  name: z.string().optional(),
});
// `shapes`, `fill`, `stroke` and `strokeWidth` used to be accepted here and
// ignored by the handler — a fill with no path renders nothing, so there was
// never a meaningful thing for them to do. They are gone rather than wired up:
// add_shape_content is the one way to put contents on a shape layer, and a
// field that validates and then does nothing is the silent success this
// codebase refuses. Passing one is now an unknown-key error.
export const CreateShapeLayer = z.object({
  compId: z.number(),
  name: z.string().optional(),
  position: z.union([Vec2, Vec3, z.literal("center")]).optional()
    .describe("Where the layer's origin goes. Defaults to [0,0], which makes the layer's coordinate space the comp's — so vertices and shape positions you write afterwards are in comp pixels. 'center' is After Effects' own spawn point (the comp centre), which offsets every path you add by half a frame. The Anchor Point stays at [0,0] either way. A new shape layer is 2D, so use [x,y]; a three-component position needs set_layer threeDLayer:true first."),
});
export const CreateSolidLayer = z.object({
  compId: z.number(),
  name: z.string().optional(),
  color: Color,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().positive().optional(),
});
export const CreateNullLayer = z.object({ compId: z.number(), name: z.string().optional() });
export const CreateAdjustmentLayer = z.object({ compId: z.number(), name: z.string().optional() });
export const CreatePrecompLayer = z.object({ compId: z.number(), sourceCompId: z.number(), position: VecAny.optional() });
export const CreateCameraLayer = z.object({ compId: z.number(), name: z.string().optional(), oneNode: z.boolean().default(false), position: VecAny.optional() });
export const CreateLightLayer = z.object({
  compId: z.number(),
  name: z.string().optional(),
  lightType: z.enum(["parallel", "spot", "point", "ambient"]).default("point"),
  color: Color.optional(),
  intensity: z.number().optional(),
  position: VecAny.optional(),
});
export const DuplicateLayer = z.object({ compId: z.number(), layerId: z.number(), count: z.number().int().positive().default(1) });
export const DeleteLayer = z.object({ compId: z.number(), layerId: z.number() });
export const SetLayer = z.object({
  compId: z.number(),
  layerId: z.number(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  locked: z.boolean().optional(),
  shy: z.boolean().optional(),
  solo: z.boolean().optional(),
  threeDLayer: z.boolean().optional(),
  // Keys into After Effects' own `BlendingMode` enumeration, looked up by name
  // in `layers.jsx`. A closed list, so a misspelling is refused here rather than
  // looked up as `undefined` and ignored (see BLENDING_MODES).
  blendingMode: z.enum(BLENDING_MODES).optional()
    .describe("After Effects' BlendingMode constant name, upper case with underscores (AE spells one SILHOUETE_ALPHA). Anything else is refused and nothing on the layer changes."),
  label: z.number().int().min(0).max(16).optional(),
  inPoint: z.number().optional(),
  outPoint: z.number().optional(),
  startTime: z.number().optional(),
  stretch: z.number().optional(),
  preserveTransparency: z.boolean().optional(),
  // Since AE 23 a matte names its source layer (`setTrackMatte`); `layerId`
  // used to be accepted here and ignored. Measured on 26.5 — see
  // docs/fragile-areas-ae.md, "Track mattes".
  trackMatte: z.object({
    type: z.enum(TRACK_MATTE_TYPES)
      .describe("ALPHA, ALPHA_INVERTED, LUMA or LUMA_INVERTED to set a matte; NO_TRACK_MATTE to clear one (same as trackMatte:null). Anything else is refused and nothing on the layer changes."),
    layerId: z.number().optional()
      .describe("The matte SOURCE layer's id, in the same comp. It may sit above or below this layer — nothing is reordered — and one source can matte several layers. Omit it to use the layer directly above, AE's classic rule; that is refused on the top layer. Cameras, lights and the layer itself are refused."),
  }).nullable().optional()
    .describe("Set or clear this layer's track matte. `null` clears it. The result's `trackMatte` reads the matte back from AE. Note: AE switches the source layer's video off when it becomes a matte and does NOT switch it back on when the matte is cleared — the result reports the source's `enabled`."),
});
export const ParentLayer = z.object({
  compId: z.number(),
  layerId: z.number(),
  parentLayerId: z.number().nullable(),
  preserveTransform: z.boolean().default(true)
    .describe("Keep the layer visually where it is (what AE's UI does). Leave on unless you want the layer to jump into the parent's coordinate space."),
});
/**
 * Reorder is the one op whose whole job is invalidating layer indexes, so an
 * index is the worst possible way to address its destination — the caller read
 * it before the move that is about to change it. The id-relative forms are
 * therefore first-class here rather than sugar, and `toIndex` stays for the
 * cases where the position is genuinely absolute ("put it on top").
 */
export const ReorderLayer = crossField(
  z.object({
    compId: z.number(),
    layerId: z.number(),
    toIndex: z.number().int().positive().optional()
      .describe("Where the layer ENDS UP: its 1-based index after the move, counting from the front (1 renders in front of everything, numLayers is the back). Clamped to the stack. Prefer beforeLayerId/afterLayerId when you are placing this layer relative to another one — an index you read earlier may already be stale."),
    beforeLayerId: z.number().optional()
      .describe("Put this layer directly IN FRONT OF (above) the layer with this id."),
    afterLayerId: z.number().optional()
      .describe("Put this layer directly BEHIND (below) the layer with this id."),
  }),
  // One destination, resolved before it can reach ExtendScript — two readings of
  // "where does it go" are a contract the schema should never let through.
  {
    kind: "exactlyOne",
    fields: ["toIndex", "beforeLayerId", "afterLayerId"],
    then: "`beforeLayerId`/`afterLayerId` are the safer two: this is the op that shifts every index below it, so an index read before the move may already be stale.",
  }
);

// ---------- transforms ----------
// `time` and `keyframe: true` go together on all three static-or-keyed setters
// (set_transform, set_effect_param, set_shape_property). A `time` without the
// flag used to be a static write that ignored the time whenever the property
// had no keys yet, and `keyframe: true` without a time silently wrote a static
// value — both reported success.
const TIME_NEEDS_KEYFRAME: CrossFieldRule = {
  kind: "requiresFlag",
  fields: ["time", "keyframe"],
};

export const SetTransform = crossField(z.object({
  compId: z.number(),
  layerId: z.number(),
  time: z.number().optional(),
  keyframe: z.boolean().default(false),
  properties: z.object({
    position: VecAny.optional(),
    scale: VecAny.optional(),
    rotation: z.number().optional(),
    anchorPoint: VecAny.optional(),
    opacity: z.number().min(0).max(100).optional(),
    orientation: Vec3.optional(),
    xRotation: z.number().optional(),
    yRotation: z.number().optional(),
    zRotation: z.number().optional(),
  }),
}), TIME_NEEDS_KEYFRAME);

// ---------- keyframes ----------
export const AddKeyframe = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
  time: z.number(),
  value: VecAny,
  interpolation: Interpolation.optional(),
});
export const RemoveKeyframe = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
  time: z.number(),
});
export const GetKeyframes = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
});
export const SetInterpolation = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
  keyIndex: z.number().int().positive(),
  in: z.enum(["linear", "bezier", "hold"]).optional(),
  out: z.enum(["linear", "bezier", "hold"]).optional(),
});
export const SetTemporalEase = crossField(
  z.object({
    compId: z.number(),
    layerId: z.number(),
    propertyPath: PropertyPath,
    keyIndex: z.number().int().positive(),
    easeIn: z.object({ influence: z.number(), speed: z.number() }).optional()
      .describe("One influence/speed pair, applied to every dimension of the property. At least one of easeIn/easeOut is required."),
    easeOut: z.object({ influence: z.number(), speed: z.number() }).optional()
      .describe("One influence/speed pair, applied to every dimension of the property."),
  }),
  // `keyframes.jsx` has always refused this, and still does — but it refused
  // from inside After Effects, which meant a round trip and a write lease spent
  // on a call that was never going to change anything.
  {
    kind: "atLeastOne",
    fields: ["easeIn", "easeOut"],
    then: "Each is one {influence, speed} pair; this tool sizes the ease array for the property itself.",
  }
);
export const SetSpatialTangents = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
  keyIndex: z.number().int().positive(),
  inTangent: z.array(z.number()).min(2).max(3),
  outTangent: z.array(z.number()).min(2).max(3),
});

// ---------- expressions ----------
export const GetExpression = z.object({ compId: z.number(), layerId: z.number(), propertyPath: PropertyPath });
export const SetExpression = z.object({ compId: z.number(), layerId: z.number(), propertyPath: PropertyPath, expression: z.string() });
export const ToggleExpression = z.object({ compId: z.number(), layerId: z.number(), propertyPath: PropertyPath, enabled: z.boolean() });
export const ClearExpression = z.object({ compId: z.number(), layerId: z.number(), propertyPath: PropertyPath });

// ---------- effects ----------
export const ListEffects = z.object({ compId: z.number(), layerId: z.number() });
export const AddEffect = z.object({ compId: z.number(), layerId: z.number(), matchName: z.string() });
export const RemoveEffect = z.object({ compId: z.number(), layerId: z.number(), effectIndex: z.number().int().positive() });
export const SetEffectParam = crossField(crossField(
  z.object({
    compId: z.number(),
    layerId: z.number(),
    effectIndex: z.number().int().positive(),
    paramName: z.string().optional()
      .describe("The parameter's display name as list_effects reports it, e.g. 'Blurriness'."),
    paramMatchName: z.string().optional()
      .describe("The parameter's matchName, e.g. 'ADBE Gaussian Blur 2-0001'. Tried before paramName when both are given, so it is the one to use when a display name is ambiguous or localised."),
    value: VecAny,
    time: z.number().optional(),
    keyframe: z.boolean().default(false),
  }),
  // Neither one is not a call with a default — it is a call that resolves no
  // property at all, and `effects.jsx` answers it with a bare "Effect param not
  // found", which reads like the *name* was wrong rather than absent.
  // Both together is legal and useful: matchName wins, name is the fallback.
  {
    kind: "atLeastOne",
    fields: ["paramName", "paramMatchName"],
    then: "list_effects on the layer reports both for every parameter of every effect.",
  }
), TIME_NEEDS_KEYFRAME);
export const SetEffectEnabled = z.object({ compId: z.number(), layerId: z.number(), effectIndex: z.number().int().positive(), enabled: z.boolean() });
// The result is cached for the AE session because enumerating app.effects is
// slow enough to time the bridge out (issue #26). `filter` is a case-insensitive
// substring match over displayName + matchName + category, so an agent looking
// for one effect never has to pull ~250 entries into its context.
export const ListAvailableEffects = z.object({
  filter: z.string().optional(),
  refresh: z.boolean().optional(),
}).strict();

// ---------- text ----------
export const SetText = z.object({
  compId: z.number(),
  layerId: z.number(),
  text: z.string().optional(),
  font: z.string().optional(),
  size: z.number().positive().optional(),
  fillColor: Color.optional(),
  strokeColor: Color.optional(),
  strokeWidth: z.number().nonnegative().optional(),
  tracking: z.number().optional(),
  leading: z.number().optional(),
  justification: z.enum(["left", "center", "right", "full"]).optional(),
  applyFill: z.boolean().optional(),
  applyStroke: z.boolean().optional(),
  fauxBold: z.boolean().optional(),
  fauxItalic: z.boolean().optional(),
  allCaps: z.boolean().optional(),
  smallCaps: z.boolean().optional(),
  baselineShift: z.number().optional(),
});
export const AddTextAnimator = z.object({
  compId: z.number(),
  layerId: z.number(),
  type: z.enum(["position", "scale", "rotation", "opacity", "tracking", "skew", "fillColor", "strokeColor"]),
  range: z.object({ start: z.number().default(0), end: z.number().default(100), offset: z.number().default(0) }).optional(),
});

// ---------- shapes ----------
export const SetShapePath = z.object({
  compId: z.number(),
  layerId: z.number(),
  shapePath: PropertyPath,
  vertices: z.array(Vec2),
  inTangents: z.array(Vec2).optional(),
  outTangents: z.array(Vec2).optional(),
  closed: z.boolean().default(true),
});
/**
 * One closed variant per shape node type. These are `.strict()` on purpose: an
 * unrecognised key must be a loud validation error, because zod's default
 * behaviour is to strip unknown keys, which would let a typo reach ExtendScript
 * as a silently-missing property and produce an empty shape that still reports
 * success.
 */
const ShapeColor = z.union([Color, ColorRGBA]);

export const ShapeContent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rect"),
    name: z.string().optional(),
    size: Vec2.optional(),
    position: Vec2.optional(),
    roundness: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("ellipse"),
    name: z.string().optional(),
    size: Vec2.optional(),
    position: Vec2.optional(),
  }).strict(),
  z.object({
    type: z.literal("star"),
    name: z.string().optional(),
    starType: z.number().optional().describe("1 = star, 2 = polygon"),
    points: z.number().optional().describe("Number of points/sides"),
    position: Vec2.optional(),
    rotation: z.number().optional(),
    innerRadius: z.number().optional(),
    outerRadius: z.number().optional(),
    innerRoundness: z.number().optional(),
    outerRoundness: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("path"),
    name: z.string().optional(),
    vertices: z.array(Vec2).optional().describe("Bezier vertices in layer space"),
    inTangents: z.array(Vec2).optional(),
    outTangents: z.array(Vec2).optional(),
    closed: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal("fill"),
    name: z.string().optional(),
    color: ShapeColor.optional(),
    opacity: z.number().optional().describe("0..100"),
    fillRule: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("stroke"),
    name: z.string().optional(),
    color: ShapeColor.optional(),
    opacity: z.number().optional().describe("0..100"),
    width: z.number().optional(),
    lineCap: z.number().optional(),
    lineJoin: z.number().optional(),
    miterLimit: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("trim"),
    name: z.string().optional(),
    start: z.number().optional().describe("0..100"),
    end: z.number().optional().describe("0..100"),
    offset: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("repeater"),
    name: z.string().optional(),
    copies: z.number().optional(),
    offset: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("merge"),
    name: z.string().optional(),
    mode: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("group"),
    name: z.string().optional(),
  }).strict(),
]);

export const AddShapeContent = z.object({
  compId: z.number(),
  layerId: z.number(),
  parentGroupPath: PropertyPath.optional(),
  content: ShapeContent,
  zOrder: z.enum(["front", "back"]).optional()
    .describe("Where the new node sits in its group's render stack. Index 1 renders in FRONT, and AE appends new content to the end — so the default, 'back', puts each node behind everything already there. 'front' moves it to index 1. Prefer ordering your calls front-to-back (details first, background rects last) over reaching for 'front': it needs an internal moveTo, which has been seen to disturb nested renders of the comp in AE 26.3."),
});
export const SetShapeProperty = crossField(z.object({
  compId: z.number(),
  layerId: z.number(),
  contentPath: PropertyPath,
  property: z.string(),
  value: VecAny,
  time: z.number().optional(),
  keyframe: z.boolean().default(false),
}), TIME_NEEDS_KEYFRAME);

// ---------- masks ----------
export const AddMask = z.object({
  compId: z.number(),
  layerId: z.number(),
  vertices: z.array(Vec2),
  inTangents: z.array(Vec2).optional(),
  outTangents: z.array(Vec2).optional(),
  closed: z.boolean().default(true),
  // A key into AE's `MaskMode`, looked up by name in `masks.jsx`; an
  // unrecognised one leaves the mode alone rather than erroring.
  mode: z.enum(MASK_MODES).default("ADD")
    .describe("Mask blend mode: ADD (default), NONE, SUBTRACT, INTERSECT, LIGHTEN, DARKEN or DIFFERENCE. Anything else is refused and no mask is added."),
});
export const SetMask = z.object({
  compId: z.number(),
  layerId: z.number(),
  maskIndex: z.number().int().positive(),
  vertices: z.array(Vec2).optional(),
  inTangents: z.array(Vec2).optional(),
  outTangents: z.array(Vec2).optional(),
  closed: z.boolean().optional(),
  mode: z.enum(MASK_MODES).optional()
    .describe("Mask blend mode: ADD, NONE, SUBTRACT, INTERSECT, LIGHTEN, DARKEN or DIFFERENCE. Anything else is refused and the mask is not changed."),
  inverted: z.boolean().optional(),
  expansion: z.number().optional(),
  feather: Vec2.optional(),
  opacity: z.number().optional(),
});
export const RemoveMask = z.object({ compId: z.number(), layerId: z.number(), maskIndex: z.number().int().positive() });

// ---------- markers ----------
export const AddMarker = z.object({
  compId: z.number(),
  layerId: z.number().optional(),
  time: z.number(),
  duration: z.number().nonnegative().default(0),
  comment: z.string().optional(),
  label: z.number().int().min(0).max(16).optional(),
  chapter: z.string().optional(),
  url: z.string().optional(),
  frameTarget: z.string().optional(),
});
export const RemoveMarker = z.object({
  compId: z.number(),
  layerId: z.number().optional(),
  markerIndex: z.number().int().positive(),
});

// ---------- vision ----------
/**
 * Omitted means "pick one from the comp size", not 1. The right factor is
 * derivable from the comp's dimensions, and a caller who forgets it was
 * previously served a full-resolution 4K frame — the single most expensive
 * accident available through these tools.
 */
const downsampleParam = z
  .number()
  .int()
  .min(1)
  .max(8)
  .optional()
  .describe(
    "Render at 1/N resolution. Omit and one is chosen from the comp size (long edge ~1280px: 2 at 1080p, 3 at 4K). Pass 1 for a full-resolution frame. The factor is always exactly what you asked for: the render sets the comp's resolution and puts it back, so a viewer left on Quarter or Third does not change the size of the frame you get."
  );
export const ScreenshotFrame = crossField(
  z.object({
    compId: z.number(),
    time: z.number().optional(),
    /**
     * Several times in one call, returned as one tiled sheet.
     *
     * Judging motion is a single visual question, and answering it used to cost
     * one call per frame — three image blocks resident for the rest of the
     * session, and three chances for After Effects to re-serve a stale buffer.
     * Capped at six because past that each tile is too small to read at the
     * pixel budget of one frame.
     */
    times: z
      .array(z.number())
      .min(2)
      .max(6)
      .optional()
      .describe(
        "2-6 times to render into one tiled contact sheet, in order, with the time burned into each tile. Cheaper than one call per frame and the whole point of it is judging motion. Mutually exclusive with `time`."
      ),
    downsample: downsampleParam,
  }),
  // Enforced here rather than in the panel: two readings of "which frame did
  // you want" reaching ExtendScript at all is a contract the schema should
  // never have let through. `atMostOne` and not `exactlyOne` — neither is a
  // legal call, and means the comp's current time.
  {
    kind: "atMostOne",
    fields: ["time", "times"],
    then: "`time` is one frame, `times` is a contact sheet of 2-6 of them; omit both for the comp's current time.",
  }
);
export const ScreenshotLayer = z.object({
  compId: z.number(),
  layerId: z.number(),
  time: z.number().optional(),
  downsample: downsampleParam,
  /**
   * screenshot_layer's own render is already genuinely transparent — measured
   * against the real op, not assumed: colour type 6, alpha 0 and black RGB
   * underneath outside the isolated layer. Any white a viewer shows there is
   * that viewer compositing the PNG onto white, not this tool. This exists
   * because that transparency is exactly what makes bright/white/glow content
   * hard to judge by eye, so an explicit opaque background is worth offering
   * — never a default, since the real alpha is the more useful answer for
   * everything that isn't a visual QA pass by a human.
   */
  background: z
    .union([z.literal("black"), Color])
    .optional()
    .describe(
      "Composite the isolated layer over a solid instead of leaving it transparent, for judging white/bright/glow/bloom content that a transparent PNG can hide or misrepresent depending on how it is displayed. Omit for the default: no background, real alpha, exactly the behaviour before this option existed. \"black\" is a shorthand; an [r,g,b] (0..1) triple sets any other solid colour. The background is a temporary solid placed behind the isolated layer for this one render and removed immediately afterward, in every case including a failed render — it never touches the target layer, any other layer, or anything about the project beyond that one frame."
    ),
});

/**
 * The write ops' opt-in structural diff. The before-fingerprint has to be taken
 * inside the same bridge call as the write — a separate snapshot_comp is a
 * second round-trip during which anything can happen — so these two are read by
 * the panel, not the server.
 */
const diffParam = z
  .boolean()
  .default(false)
  .describe(
    "Fingerprint the comp before and after this call and append only what changed (layers added/removed/renamed/retimed/re-parented, keyframe counts, expression and effect counts). A few dozen tokens instead of reading the comp back. If the call fails, the diff of what landed before it stopped is appended to the error."
  );
const diffCompIdParam = z
  .number()
  .optional()
  .describe("Which comp `diff` should fingerprint. Defaults to the comps this call names, else the comp open in the viewer.");

// ---------- batch ----------
export const RunBatch = z.object({
  ops: z.array(z.object({ op: z.string(), args: z.unknown() })),
  transactional: z.boolean().default(true)
    .describe("Stop at the first failing op instead of running the rest. Nothing rolls back either way — the ops before the failure stay applied, and the error says where it stopped."),
  undoGroupName: z.string().default("AE MCP Batch")
    .describe("What the user sees in After Effects' Edit > Undo menu. A chunked batch numbers its steps from this, e.g. \"AE MCP Batch (3)\"."),
  singleUndo: z.boolean().default(false)
    .describe("Force the whole batch into ONE undo step, whatever its size, by running it in a single blocking ExtendScript call. Up to 2000 ops. The cost is real: After Effects' interface is frozen for the entire batch and no progress is reported, so the user sees nothing until it finishes. Without it a batch over 500 ops is chunked and lands as one undo step per chunk of 25 — the result reports the exact count. Reach for this only when the user has to be able to undo the work with a single Cmd-Z."),
  diff: diffParam,
  diffCompId: diffCompIdParam,
});

// ---------- explore ----------
export const GetProjectSummary = z.object({}).strict();
export const FindLayers = z.object({
  compId: z.number().optional(),
  namePattern: z.string().optional(),
  type: z.string().optional(),
  hasEffectMatchName: z.string().optional(),
  // Same section names as list_layers, opposite default: a search is for
  // learning which layers exist and what to address them by, so omitting this
  // means the core alone rather than everything (issue #87). `includeParam`
  // is not reused because its sentence says "omit for all of them".
  include: z
    .array(z.enum(LAYER_SUMMARY_SECTIONS))
    .optional()
    .describe(
      `Sections to add to each match: ${LAYER_SUMMARY_SECTIONS.join(", ")} — the same names as list_layers. Omit it (or pass []) for id/index/name/sourceType plus compId/compName only; unlike list_layers, omitting it here does NOT return every section. The result echoes what was included.`
    ),
});

// ---------- property tree (read-only) ----------
/**
 * The generic walk of a layer's property tree, for everything get_layer_full
 * has no section for. Bounded three ways — depth, node count, keys per
 * property — and every bound that bites is reported, never applied silently.
 * The defaults come from live measurement on AE 26.5: a solid with ten effects
 * is ~390 nodes and a text layer with one animator ~290, most of it the Layer
 * Styles / Material Options groups that are collapsed by default.
 */
export const INSPECT_DEFAULT_COLLAPSE = [
  "ADBE Layer Styles",
  "ADBE Material Options Group",
  "ADBE Extrsn Options Group",
  "ADBE Plane Options Group",
  "ADBE Vector Materials Group",
] as const;
export const InspectPropertyTree = z
  .object({
    compId: z.number(),
    layerId: z.number(),
    path: PropertyPath.optional()
      .describe("Start the walk at this property or group instead of the layer root. Same format every path-taking tool uses — matchNames, display names or 1-based indices — and exactly what each returned node's `path` already is."),
    depth: z.number().int().min(0).max(12).default(4)
      .describe("Levels below the start node to expand. Groups at the limit are listed with childCount and childrenNotWalked:true. Text animator properties sit at depth 5 from the layer root; shape contents can reach 7."),
    maxNodes: z.number().int().min(1).max(2000).default(250)
      .describe("Stop after this many nodes and say where (truncated:true, truncation.nextUnvisited)."),
    includeValues: z.boolean().default(true)
      .describe("Read each property's current value. Unreadable ones are still listed, with valueReadable:false and the reason."),
    includeExpressions: z.boolean().default(true)
      .describe("Report expression text, enabled state and AE's expressionError on properties that have one."),
    includeKeys: z.boolean().default(false)
      .describe("List each animated property's keyframes: time, value, interpolation, per-dimension temporal ease, continuous/auto-bezier flags, spatial tangents and roving where spatial, label."),
    maxKeysPerProperty: z.number().int().min(1).max(500).default(10)
      .describe("With includeKeys, keep the first and last few of this many keys per property and count the rest."),
    includeHidden: z.boolean().default(true)
      .describe("List properties flagged hidden:true — slots After Effects refuses a value in, in the layer's current state (the ~100 inert slots of a text animator's Properties group, a 2D layer's Orientation). false leaves them out and counts them in hiddenOmitted."),
    collapse: z.array(z.string()).optional()
      .describe(`Group matchNames to list without expanding. Default: ${INSPECT_DEFAULT_COLLAPSE.join(", ")} — present on every layer, large, and usually inert. Pass [] to expand everything; a collapsed group can always be inspected directly with \`path\`.`),
  })
  .strict();

// ---------- property values (static write) ----------
/**
 * The static-write counterpart to inspect_property_tree: a path that tool
 * returns is accepted here unchanged. Static only — no `time`, no keys, no
 * interpolation; a property that already has keys is refused rather than
 * flattened (B2's set_keyframes owns animation).
 *
 * The value shapes mirror what inspect_property_tree reports, so a value read
 * there can be edited and written back: a number, an array of numbers, or a
 * Shape as {vertices, inTangents, outTangents, closed[, feather]}. Which one a
 * property takes is decided by its valueType inside After Effects, where every
 * update is checked before the first write (packages/jsx/propwrite.jsx).
 */
export const SET_PROPERTY_VALUES_MAX = 50;
const ShapePoint = z.tuple([z.number(), z.number()]);
export const ShapeFeatherValue = z
  .object({
    segLocs: z.array(z.number().int().min(0)),
    relSegLocs: z.array(z.number().min(0).max(1)),
    radii: z.array(z.number()),
    types: z.array(z.number().int()),
    interps: z.array(z.number().int()),
    tensions: z.array(z.number()),
    relCornerAngles: z.array(z.number()),
  })
  .strict()
  .describe("A mask's variable-width feather points, exactly as inspect_property_tree reports them: seven arrays of one length. Empty arrays remove every feather point. Omit `feather` to keep the mask's existing points.");
export const ShapePathValue = z
  .object({
    vertices: z.array(ShapePoint).min(1),
    inTangents: z.array(ShapePoint),
    outTangents: z.array(ShapePoint),
    closed: z.boolean(),
    feather: ShapeFeatherValue.optional(),
  })
  .strict()
  .describe("A SHAPE value (mask path or shape-layer path), as inspect_property_tree reports it. Tangents are relative to their vertex, one per vertex.");
export const StaticPropertyValue = z
  .union([z.number(), z.array(z.number()).min(2).max(4), ShapePathValue])
  .describe("A number (OneD, LAYER_INDEX, MASK_INDEX), an array of exactly the property's dimension count (TwoD 2, ThreeD 3 — a 2D layer's Position/Scale/Anchor Point still read and take 3; COLOR 4, or 3 to keep the current alpha), or a Shape object.");
export const SetPropertyValues = z
  .object({
    compId: z.number(),
    layerId: z.number(),
    updates: z
      .array(
        z
          .object({
            path: PropertyPath
              .describe("The property's path exactly as inspect_property_tree returned it (matchNames, display names or 1-based indices). Must end at a property, not a group."),
            value: StaticPropertyValue,
          })
          .strict()
      )
      .min(1)
      .max(SET_PROPERTY_VALUES_MAX)
      .describe(`1 to ${SET_PROPERTY_VALUES_MAX} static writes on this layer, applied in order. Every one is checked before the first is written; two that resolve to the same property are refused.`),
  })
  .strict();

// ---------- raw ----------
export const RunJsx = crossField(
  z.object({
    code: z.string().optional()
      .describe("The ExtendScript to run. Exactly one of `code` or `scriptPath`."),
    scriptPath: z.string().optional()
      .describe("Absolute path to a .jsx file to run instead of `code`. The server reads it, so a long script never enters the conversation. Exactly one of `code` or `scriptPath`."),
    libraries: z.array(z.string()).optional()
      .describe("Absolute paths to .jsx files inlined ahead of the script, sharing its scope, so their functions are callable from it. The server reads them, so their text never enters the conversation. They are re-evaluated on every call — keep them to declarations, not to work. Put shared helpers here rather than pasting them into every script."),
    undoGroup: z.boolean().default(true)
      .describe("Wrap the script in one undo step. Set false only for the operations AE refuses while an undo group is open — copyToComp on a layer with a parent or a linked expression. The script's changes then land as whatever undo steps AE records on its own."),
    diff: diffParam,
    diffCompId: diffCompIdParam,
  }),
  // `resolveRunJsxSource` refuses both and neither too, and keeps doing so —
  // it is reachable from `run_batch`, whose steps are never zod-validated. What
  // the rule buys here is the half that runs *before* the call: declared, it
  // reaches the emitted JSON Schema, so the model sees the choice rather than
  // discovering it.
  {
    kind: "exactlyOne",
    fields: ["code", "scriptPath"],
    then: "Prefer `scriptPath` for anything long — the server reads the file, so the script never enters the conversation.",
  }
);

// ---------- footage ----------
export const ImportFootage = z
  .object({
    path: z.string().min(1).describe("Absolute path to the file to import."),
    name: z.string().optional().describe("Rename the project item after import. Omit to keep the filename."),
    sequence: z.boolean().default(false)
      .describe("Import a numbered still as an image sequence rather than a single frame."),
    force: z.boolean().default(false)
      .describe(
        "Keep an item that failed validation instead of deleting it and throwing. The problem is still reported in `validation`. Only pass this when you know the dimensions are wrong and want the item anyway."
      ),
  })
  .strict();
export const CreateFootageLayer = z.object({
  compId: z.number(),
  itemId: z.number().describe("Project item id from import_footage or get_project_summary."),
  name: z.string().optional(),
  position: VecAny.optional(),
  startTime: z.number().optional(),
});
export const PurgeUnusedFootage = z
  .object({
    solidsOnly: z.boolean().default(true)
      .describe(
        "Only remove solids — the items behind solid and adjustment layers. Pass false to remove every footage item no comp uses, imported files and placeholders included, which is what AE's own Remove Unused Footage does. Comps and folders are never removed either way."
      ),
    dryRun: z.boolean().default(false)
      .describe("List what would be removed without removing anything — not even an undo step."),
    folderId: z.number().optional()
      .describe("Restrict the sweep to one project folder and everything nested under it. A folder id from get_project_summary; omit for the whole project."),
  })
  .strict();
export const ReplaceFootage = z
  .object({
    itemId: z.number().describe("The FootageItem's project item id (from import_footage or get_project_summary) whose source file to replace. Every layer already using this item keeps using it — nothing is deleted, re-imported or re-created."),
    filePath: z.string().min(1).describe("Absolute path to the replacement file."),
    sequence: z.boolean().default(false)
      .describe("Treat filePath as the first file of a numbered image sequence, replacing with the whole sequence (alphabetical order) rather than one frame. Same convention as import_footage's own `sequence` flag."),
  })
  .strict();

// ---------- render queue (Phase 1: inspect and enqueue, never render) ----------
export const GetRenderQueue = z.object({}).strict();
export const QueueComp = z
  .object({
    compId: z.number().describe("The comp to add to the Render Queue."),
    outputPath: z.string().min(1).optional().describe(
      "Absolute path for Output Module 1's file. Its parent directory must already exist — nothing is created — and After Effects may silently change the extension to match the active output-module template; the result's `outputs[]` reports what AE actually set, not an echo of this value. Omit to leave the output module at whatever this AE session last used, which is inherited, not blank."
    ),
  })
  .strict();

// ---------- audio ----------
export const AudioCue = z
  .object({
    footageId: z.number().optional()
      .describe("Project item id of an already-imported sound. Give this or `path`, not both."),
    path: z.string().min(1).optional()
      .describe("Absolute path to a sound file. Imported once per call however many cues name it, and an item already in the project from that path is reused rather than imported again."),
    time: z.number().describe("Comp time in seconds where the cue starts."),
    levelDb: z.number().optional()
      .describe("Level in decibels, the same unit After Effects shows. 0 is the file untouched, -6 is roughly half as loud, negative is quieter. Defaults to 0, written explicitly so the result is the same on every machine."),
    name: z.string().optional().describe("Layer name. Defaults to namePrefix + the file's basename without its extension."),
    inPoint: z.number().optional().describe("Trim the layer's in point to this COMP time. Must not be earlier than `time`. Omit to play from the start of the file."),
    outPoint: z.number().optional().describe("Trim the layer's out point to this COMP time. Omit to play to the end of the file."),
    label: z.union([z.number().int().min(0).max(16), z.string()]).optional()
      .describe("AE label colour, as an index 0-16 or a name (red, yellow, aqua, pink, lavender, peach, seafoam, blue, green, purple, orange, brown, fuchsia, cyan, sandstone, darkgreen)."),
    loop: z.boolean().optional()
      .describe("Loop the sound until `outPoint`, or until the end of the comp when no outPoint is given — for beds and ambiences. Enables time remapping with a wrap-around expression on Time Remap; the layer's in point still trims the front of the file the way it does on any layer. Default false: the file plays once."),
    fadeIn: z.number().min(0).optional()
      .describe("Seconds to fade in from `fadeFloorDb` up to `levelDb`, as keyframes on Audio Levels starting at the layer's in point. Default 0 (no fade). fadeIn + fadeOut must fit inside the cue's placed length or the cue is refused by index."),
    fadeOut: z.number().min(0).optional()
      .describe("Seconds to fade out from `levelDb` down to `fadeFloorDb`, ending at the layer's out point. Default 0 (no fade). fadeIn + fadeOut must fit inside the cue's placed length or the cue is refused by index."),
    stretch: z.number().positive().optional()
      .describe("Time stretch as a percentage: 100 is unchanged, 200 plays at half speed (lower pitch, twice as long), 50 at double speed. Must be greater than 0. The layer's start time and any trim are re-asserted after it, since After Effects moves them when stretch changes. Default 100."),
  })
  .strict();
export const PlaceAudioCues = z
  .object({
    compId: z.number(),
    cues: z.array(AudioCue).min(1).max(200),
    namePrefix: z.string().default("SFX_")
      .describe("Prefix for cues that do not name themselves. Pass \"\" for no prefix."),
    fadeFloorDb: z.number().optional()
      .describe("The level in decibels that every fadeIn starts from and every fadeOut ends at. Default -48, the bottom of After Effects' own Audio Levels slider and 1/256 of the recorded amplitude — near-silence. Must be below each faded cue's levelDb. One floor for the whole list."),
    dryRun: z.boolean().default(false)
      .describe("Resolve and check the whole list without importing, creating or changing anything — not even an undo step. Returns counts, the files it would import, the items it would reuse and the failing cues by index — never the whole resolved list."),
  })
  .strict();

// ---------- motion graphics templates ----------
export const ExportMogrt = z
  .object({
    compId: z.number(),
    destDir: z.string().optional()
      .describe("Folder to write the .mogrt into. Defaults to the folder holding the .aep."),
    name: z.string().optional()
      .describe(
        "Template name, which is also the output filename. Defaults to the comp name — AE's own default is the literal 'Untitled', so every scripted export would otherwise overwrite the same file."
      ),
    overwrite: z.boolean().default(false)
      .describe("Required to replace an existing .mogrt at that path."),
    posterTime: z.number().optional()
      .describe(
        "Comp time to render as the template's still thumbnail, replacing the black one AE writes. Omit to leave AE's thumbnail alone."
      ),
    suppressDialogs: z.boolean().default(true)
      .describe(
        "Suppress the modal font warning during export. Leave true: an unsuppressed dialog freezes the bridge until someone clicks it in AE. Set false only to see the dialog deliberately."
      ),
  })
  .strict();

// ---------- house style (a markdown file beside the .aep, read over the bridge) ----------
export const GetHouseStyle = z
  .object({
    detail: z.enum(["summary", "full"]).default("summary")
      .describe(
        "'summary' (default) is a few hundred tokens: palette as named hexes, type, motion defaults, layout rules, and what it could not summarise. 'full' returns the whole document — use it before editing the guide with set_house_style, or when the summary is not enough."
      ),
  })
  .strict();
export const SetHouseStyle = z
  .object({
    content: z.string().min(1).describe("The complete style guide as markdown. Replaces the file, so send the whole document."),
    overwrite: z.boolean().default(false)
      .describe("Required to replace an existing guide. Read it with get_house_style and merge first — this is not a patch."),
  })
  .strict();

// ---------- jobs ----------
// ---------- setup (handled in the MCP server, never forwarded to the panel) ----------
export const CheckSetup = z.object({}).strict();
export const SetupPanel = z.object({
  enableDebugMode: z.boolean().default(true)
    .describe("Also set Adobe's PlayerDebugMode preference, which AE requires to load this unsigned panel, and CEP's LogLevel where it was never set, so CEP's own log records why a panel failed to load (issue #91). Default true."),
  force: z.boolean().default(false)
    .describe("Replace an existing symlinked (development) install with a copy. Default false."),
}).strict();

/**
 * Guide topics. The prose lives in `packages/mcp-server/src/guides/*.md`, but the
 * names are part of the tool contract, so they are declared here and
 * `scripts/build-guides.mjs` fails the build if the two ever disagree.
 */
export const GUIDE_TOPICS = [
  "ae-setup",
  "after-effects",
  "animation",
  "assembly",
  "extendscript-gotchas",
  "issue-journal",
  "mogrt-and-footage",
  "shapes",
  "sound",
  "style-guide",
  "text",
  "whats-new",
] as const;
export const AeGuide = z
  .object({
    topic: z.enum(GUIDE_TOPICS).describe(
      "after-effects: the core — orienting, bounded reads, verifying a write, screenshots, the bridge failures — start here; it points at one topic per subject. animation: keyframes, easing, rigging, expressions. shapes: shape layers and their Contents. text: text layers. assembly: shots placed into a master comp, markers, retiming. extendscript-gotchas: read before writing raw ExtendScript for run_jsx. sound: sound effects and levels. mogrt-and-footage: exporting a .mogrt, importing footage. issue-journal: when a tool fought back. whats-new: what changed, one section per release, when a call behaves differently from what you expected or a project is being brought up to date after an upgrade. style-guide: capturing the user's look. ae-setup: connecting to AE when a tool cannot reach it."
    ),
    since: z
      .string()
      .regex(/^v?\d+\.\d+\.\d+$/, "must be a version like 0.4.0")
      .optional()
      .describe(
        "whats-new only: return just the releases newer than this version — the version named is the one already absorbed and is excluded — behind the guide's preamble, or one line saying nothing is newer. Use the version a project's docs record as last absorbed. The answer opens with the server's own version. Rejected on any other topic, since there is nothing there to filter."
      ),
  })
  .strict();

// ---------- project scaffold (handled in the MCP server, never forwarded to the panel) ----------
export const InitProject = z
  .object({
    dir: z.string().optional()
      .describe("Folder to create or fill, absolute or relative to the server's working directory. Ask the user if you do not know; do not invent one."),
    name: z.string().optional().describe("Project name for the generated docs. Defaults to the folder name."),
    client: z.enum(["auto", "claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "codex", "generic"])
      .default("auto")
      .describe("Which client's layout to write. 'auto' detects it from the MCP handshake — leave it alone unless the user says otherwise."),
    withMcpConfig: z.boolean().default(false)
      .describe("Also write a client MCP config pointing at this server. Default false: you are already connected, so the user does not need one."),
  })
  .strict();

// ---------- issue journal (handled in the MCP server, never forwarded to the panel) ----------
export const LogIssue = z
  .object({
    title: z.string().min(3).describe("One line naming the problem, specific enough to recognise again. Becomes the entry's id."),
    symptom: z.string().min(3).describe("What went wrong, including the exact error text and the call that produced it."),
    workaround: z.string().min(3).describe("What actually worked — concrete enough for the next session to apply without rediscovering it."),
    cause: z.string().optional().describe("Why it happens, if you worked it out."),
    tools: z.array(z.string()).optional().describe("Tool names involved, e.g. ['set_temporal_ease']. With errorText, this is what a later failure is matched on."),
    errorText: z.string().optional()
      .describe(
        "The exact error text the failing call returned, verbatim. The next time a call to one of `tools` fails with matching text, its error names this entry — and a later log_issue with the same tool and error text extends this entry instead of creating a second one under a different title."
      ),
    kind: z.enum(["tool-bug", "ae-quirk"]).default("tool-bug")
      .describe(
        "'tool-bug' (default): something these tools get wrong, which a later release may fix — so the entry is archived once it was last seen on an older server than the one running. 'ae-quirk': After Effects itself behaving unlike its documentation; no release changes that, so it is never archived by version."
      ),
    scope: z.enum(["project", "user"]).default("project")
      .describe(
        "'project' (default) for this project's footage, comps or files. 'user' for how these tools or After Effects behave — that journal travels with the person, so every future project starts knowing it. Reported back as 'home' when there is no project folder to write into."
      ),
  })
  .strict();
export const ListKnownIssues = z
  .object({
    status: z.enum(["all", "unreported", "reported"]).default("all"),
    tool: z.string().optional().describe("Only entries about this tool, e.g. 'set_temporal_ease'. Omit for everything."),
    query: z
      .string()
      .optional()
      .describe("Free-text filter: every whitespace-separated term must appear in an entry's title, symptom or tools."),
    id: z
      .string()
      .optional()
      .describe("Read one entry in full — cause and workaround included — by the id from a previous listing. Ignores the filters. Ids are unique only within a journal, so prefix with the entry's scope ('user:my-entry') when the listing shows one in each."),
    detail: z
      .enum(["index", "full"])
      .default("index")
      .describe(
        "'index' (default) is one line per entry: id, title, tools, kind, when and on which version it was last seen, counts — read the one you need with `id`. 'full' returns every matching entry's whole body and costs thousands of tokens."
      ),
    scope: z.enum(["all", "project", "user"]).default("all")
      .describe(
        "Which journal to read. 'all' (default) merges this project's with the user's cross-project one and tags every entry with the scope it came from."
      ),
    limit: z.number().int().positive().max(500).default(50)
      .describe("Most entries to return. Anything held back is counted in `omitted`."),
    includeArchived: z.boolean().default(false)
      .describe(
        "Also list archived entries — not seen for 30 days, last seen on an older server than this one, or retired with archive_issue — each flagged with its reason. Default false: they are hidden and only counted in `archivedCount`. An `id` read always returns the entry, archived or not."
      ),
  })
  .strict();
export const MarkIssueReported = z
  .object({
    id: z.string().describe("The entry id returned by log_issue or list_known_issues. Prefix with its scope ('user:my-entry') when the same id exists in both journals."),
    url: z.string().optional().describe("Link to the issue that was opened."),
  })
  .strict();
export const ArchiveIssue = z
  .object({
    id: z.string().describe("The entry id from log_issue or list_known_issues. Prefix with its scope ('user:my-entry') when the same id exists in both journals — only the one named moves."),
    reason: z.string().min(3).describe("Why it is being retired, one line — the URL of the report that already covers it, the release that fixed it, or where the lesson was moved to."),
  })
  .strict();

export const AwaitJob = z.object({ jobId: z.string(), timeoutMs: z.number().int().positive().default(600_000) });
export const GetJob = z.object({ jobId: z.string() });
export const CancelJob = z.object({ jobId: z.string() });

/**
 * Registry: op name -> zod schema. Used by MCP server to register tools and
 * by the panel/ExtendScript dispatcher as authoritative op list.
 */
export const OpSchemas = {
  // comps
  list_comps: ListComps,
  get_comp: GetComp,
  get_comp_tree: GetCompTree,
  create_comp: CreateComp,
  set_comp: SetComp,
  delete_comp: DeleteComp,
  set_active_comp: SetActiveComp,
  duplicate_comp: DuplicateComp,
  get_current_time: GetCurrentTime,
  set_current_time: SetCurrentTime,
  snapshot_comp: SnapshotComp,
  diff_comp: DiffComp,
  // layers
  list_layers: ListLayers,
  get_layer_full: GetLayerFull,
  create_text_layer: CreateTextLayer,
  create_shape_layer: CreateShapeLayer,
  create_solid_layer: CreateSolidLayer,
  create_null_layer: CreateNullLayer,
  create_adjustment_layer: CreateAdjustmentLayer,
  create_precomp_layer: CreatePrecompLayer,
  create_camera_layer: CreateCameraLayer,
  create_light_layer: CreateLightLayer,
  duplicate_layer: DuplicateLayer,
  delete_layer: DeleteLayer,
  set_layer: SetLayer,
  parent_layer: ParentLayer,
  reorder_layer: ReorderLayer,
  // transforms
  set_transform: SetTransform,
  // keyframes
  add_keyframe: AddKeyframe,
  remove_keyframe: RemoveKeyframe,
  get_keyframes: GetKeyframes,
  set_interpolation: SetInterpolation,
  set_temporal_ease: SetTemporalEase,
  set_spatial_tangents: SetSpatialTangents,
  // expressions
  get_expression: GetExpression,
  set_expression: SetExpression,
  toggle_expression: ToggleExpression,
  clear_expression: ClearExpression,
  // effects
  list_effects: ListEffects,
  add_effect: AddEffect,
  remove_effect: RemoveEffect,
  set_effect_param: SetEffectParam,
  set_effect_enabled: SetEffectEnabled,
  list_available_effects: ListAvailableEffects,
  // text
  set_text: SetText,
  add_text_animator: AddTextAnimator,
  // shapes
  set_shape_path: SetShapePath,
  add_shape_content: AddShapeContent,
  set_shape_property: SetShapeProperty,
  // masks
  add_mask: AddMask,
  set_mask: SetMask,
  remove_mask: RemoveMask,
  // markers
  add_marker: AddMarker,
  remove_marker: RemoveMarker,
  // vision
  screenshot_frame: ScreenshotFrame,
  screenshot_layer: ScreenshotLayer,
  // batch
  run_batch: RunBatch,
  // explore
  get_project_summary: GetProjectSummary,
  find_layers: FindLayers,
  inspect_property_tree: InspectPropertyTree,
  set_property_values: SetPropertyValues,
  // footage
  import_footage: ImportFootage,
  create_footage_layer: CreateFootageLayer,
  purge_unused_footage: PurgeUnusedFootage,
  replace_footage: ReplaceFootage,
  // render queue
  get_render_queue: GetRenderQueue,
  queue_comp: QueueComp,
  // audio
  place_audio_cues: PlaceAudioCues,
  // motion graphics templates
  export_mogrt: ExportMogrt,
  // raw
  run_jsx: RunJsx,
  // house style
  get_house_style: GetHouseStyle,
  set_house_style: SetHouseStyle,
  // jobs
  await_job: AwaitJob,
  get_job: GetJob,
  cancel_job: CancelJob,
  // setup
  check_setup: CheckSetup,
  setup_panel: SetupPanel,
  init_project: InitProject,
  // guidance
  ae_guide: AeGuide,
  // issue journal
  log_issue: LogIssue,
  list_known_issues: ListKnownIssues,
  mark_issue_reported: MarkIssueReported,
  archive_issue: ArchiveIssue,
} as const;

export type OpName = keyof typeof OpSchemas;

/**
 * What each op does to the live After Effects session.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  ADDING AN OP? ADD IT HERE TOO. `tests/unit/write-queue.mjs` fails the build
 *  when an op is in `OpSchemas` and not in this table, or the other way round.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * There is deliberately no default. Guessing "read" for an op nobody
 * classified would let a new writing tool run inside another write's undo group
 * and corrupt it silently, which is the exact failure this table exists to
 * prevent (issue #55) — so an unclassified op has to fail the build instead.
 *
 *   "write"  — changes the project or the application. The server serializes
 *              these behind one mutex: After Effects applies every change
 *              through a single undo stack, and two in flight interleave.
 *   "read"   — reaches the bridge and changes nothing. Never queued. Screenshots
 *              are here on purpose: they are slow *and* read-only, and putting
 *              them behind the write mutex would make every write wait on a render.
 *   "server" — never reaches the bridge at all (`SERVER_OPS` in server.ts).
 *              Not queued, and that is load-bearing: `await_job` blocks for as
 *              long as a batch runs and `cancel_job` is how a stuck one is
 *              released, so queueing either would deadlock against the job
 *              holding the lock.
 */
export const OpMutation = {
  // comps
  list_comps: "read",
  get_comp: "read",
  get_comp_tree: "read",
  create_comp: "write",
  set_comp: "write",
  delete_comp: "write",
  set_active_comp: "write",
  duplicate_comp: "write",
  get_current_time: "read",
  // Moves the CTI in the live project, so it serializes against other writes
  // like any other op that touches AE state — even though, unlike them, it
  // never opens an undo group (comps.jsx: it's viewer state, not an edit).
  set_current_time: "write",
  // Fingerprints: they forward a read to the panel and keep the answer in the
  // server. Nothing is written to the project or the undo stack, so they must
  // not queue — the point of a diff is checking on a write that is in flight.
  snapshot_comp: "read",
  diff_comp: "read",
  // layers
  list_layers: "read",
  get_layer_full: "read",
  create_text_layer: "write",
  create_shape_layer: "write",
  create_solid_layer: "write",
  create_null_layer: "write",
  create_adjustment_layer: "write",
  create_precomp_layer: "write",
  create_camera_layer: "write",
  create_light_layer: "write",
  duplicate_layer: "write",
  delete_layer: "write",
  set_layer: "write",
  parent_layer: "write",
  reorder_layer: "write",
  // transforms
  set_transform: "write",
  // keyframes
  add_keyframe: "write",
  remove_keyframe: "write",
  get_keyframes: "read",
  set_interpolation: "write",
  set_temporal_ease: "write",
  set_spatial_tangents: "write",
  // expressions
  get_expression: "read",
  set_expression: "write",
  toggle_expression: "write",
  clear_expression: "write",
  // effects
  list_effects: "read",
  add_effect: "write",
  remove_effect: "write",
  set_effect_param: "write",
  set_effect_enabled: "write",
  list_available_effects: "read",
  // text
  set_text: "write",
  add_text_animator: "write",
  // shapes
  set_shape_path: "write",
  add_shape_content: "write",
  set_shape_property: "write",
  // masks
  add_mask: "write",
  set_mask: "write",
  remove_mask: "write",
  // markers
  add_marker: "write",
  remove_marker: "write",
  // vision — read-only despite being the slowest thing here. `screenshot_*`
  // borrows the comp's resolutionFactor and restores it in a `finally`;
  // nothing in the project changes.
  screenshot_frame: "read",
  screenshot_layer: "read",
  // batch
  run_batch: "write",
  // explore
  get_project_summary: "read",
  find_layers: "read",
  // Never writes and never opens an undo group (noUndo in inspect.jsx).
  inspect_property_tree: "read",
  // The static-write counterpart: one undo group per call, every update
  // checked before the first write (propwrite.jsx).
  set_property_values: "write",
  // footage
  import_footage: "write",
  create_footage_layer: "write",
  // Removes project items. A dryRun changes nothing, but the table is per op,
  // not per call — a dry run waiting behind a batch costs a little time and a
  // real one interleaving with it costs the batch's undo step.
  purge_unused_footage: "write",
  replace_footage: "write",
  // render queue — Phase 1: inspect and enqueue. Render Queue state is not
  // part of AE's Undo stack (see renderqueue.jsx), so both use noUndo() at
  // the JSX layer; that is orthogonal to this table, which is about the
  // server's write queue, not Undo. queue_comp still mutates AE state and
  // must serialize behind other writes.
  get_render_queue: "read",
  queue_comp: "write",
  // audio cues — imports footage and adds layers.
  place_audio_cues: "write",
  // motion graphics templates — saves the project before exporting.
  export_mogrt: "write",
  // raw — the script is the caller's and may do anything. Assume the worst.
  run_jsx: "write",
  // house style — written over the bridge into a file beside the .aep.
  get_house_style: "read",
  set_house_style: "write",
  // jobs
  await_job: "server",
  get_job: "server",
  cancel_job: "server",
  // setup
  check_setup: "server",
  setup_panel: "server",
  init_project: "server",
  // guidance
  ae_guide: "server",
  // issue journal
  log_issue: "server",
  list_known_issues: "server",
  mark_issue_reported: "server",
  archive_issue: "server",
} as const satisfies Record<OpName, "write" | "read" | "server">;

export type OpEffect = (typeof OpMutation)[OpName];
