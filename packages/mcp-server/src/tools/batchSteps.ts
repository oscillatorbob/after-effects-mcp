import { z } from "zod";
import { schemas } from "@engineroom/shared";
import { invalidArgsText } from "../util/errors.js";
import { resolveRunJsxSource, type RunJsxArgs } from "./runJsxSource.js";

/**
 * One parse for every op, whether it arrives as a tool call or as a step of
 * `run_batch`.
 *
 * Until this existed a batch step was `{op, args: unknown}` and its args went to
 * After Effects exactly as written: no defaults, no cross-field rules, no enum
 * checks, and a mistyped key reached the handler as a field nobody read. The
 * same call made directly and made inside a batch behaved differently — and the
 * batch is the path every bulk build goes through.
 *
 * Two decisions live here.
 *
 * **Unknown keys are refused at every depth, on both paths.** The JSON Schema a
 * client is shown already says `additionalProperties: false` for every object
 * (zod-to-json-schema emits it whatever the zod mode), but zod's own default is
 * to *strip* unknown keys, so `set_layer({blendMode: "ADD"})` — one letter off
 * `blendingMode` — validated, lost the field, and reported success. The strict
 * copy is derived from the published schema rather than hand-kept beside it, so
 * the two cannot drift; the published schema itself is untouched, because it is
 * also what the tool list is emitted from.
 *
 * **A batch is validated whole before any of it is sent.** An invalid step 50
 * must not leave steps 0-49 applied: nothing in a batch rolls back, so the only
 * way to make a structural mistake cost nothing is to find it before the first
 * write. Every invalid step is reported at once, by index, so one round trip
 * fixes the lot.
 */

const { OpSchemas, OpMutation } = schemas;

/** Ops that never reach the panel, so a batch — which runs inside it — cannot run them. */
const SERVER_ONLY = new Set(
  Object.keys(OpMutation).filter((op) => (OpMutation as Record<string, string>)[op] === "server")
);

/**
 * Bridged ops that have no handler in the JSX bundle under their own name: the
 * server answers them by forwarding an internal read and keeping the result. A
 * batch step naming one would reach the panel as `Unknown op` part-way through.
 */
const SERVER_ASSEMBLED = new Set(["snapshot_comp", "diff_comp"]);

/**
 * Ops whose result only makes sense packaged by the server around a direct
 * call. A screenshot answers with a file the panel reads, converts and checks
 * for staleness, and that the server wraps as image content — none of which
 * happens to a batch step, which came back as a bare temp-file record and left
 * the PNG on disk. Excluded until batch image results are designed on purpose;
 * `times` (the contact sheet) is part of screenshot_frame and goes with it.
 */
const DIRECT_ONLY = new Set(["screenshot_frame", "screenshot_layer"]);

/** The inline cutoff in batch.jsx. A nested batch over it would start a job nobody drives. */
export const NESTED_BATCH_INLINE_MAX = 500;
/** How many invalid steps one error names before it summarises the rest. */
export const MAX_REPORTED_STEP_ERRORS = 20;

type AnyZod = z.ZodTypeAny;
const strictCache = new WeakMap<object, AnyZod>();

/**
 * A copy of `schema` in which every object refuses unknown keys. Wrappers are
 * rebuilt around the strict inner schema with their own `_def` otherwise intact,
 * so defaults, refinements (`crossField`) and descriptions behave exactly as in
 * the original.
 */
export function deepStrict<T extends AnyZod>(schema: T): T {
  const hit = strictCache.get(schema);
  if (hit) return hit as T;
  const out = rebuild(schema, 0);
  strictCache.set(schema, out);
  return out as T;
}

function rebuild(node: AnyZod, depth: number): AnyZod {
  if (depth > 32) return node;
  const def = (node as { _def: Record<string, unknown> & { typeName?: string } })._def;
  const Ctor = node.constructor as new (def: unknown) => AnyZod;
  const inner = (s: unknown) => rebuild(s as AnyZod, depth + 1);
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, AnyZod>)();
      const next: Record<string, AnyZod> = {};
      for (const k of Object.keys(shape)) next[k] = inner(shape[k]);
      // "passthrough" is a deliberate choice somebody made; only the default
      // "strip" — the silent one — is tightened.
      const unknownKeys = def.unknownKeys === "passthrough" ? "passthrough" : "strict";
      return new Ctor({ ...def, shape: () => next, unknownKeys });
    }
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodReadonly":
      return new Ctor({ ...def, innerType: inner(def.innerType) });
    case "ZodEffects":
      return new Ctor({ ...def, schema: inner(def.schema) });
    case "ZodArray":
      return new Ctor({ ...def, type: inner(def.type) });
    case "ZodUnion":
      return new Ctor({ ...def, options: (def.options as AnyZod[]).map(inner) });
    case "ZodDiscriminatedUnion": {
      const opts = (def.options as AnyZod[]).map(inner);
      return z.discriminatedUnion(def.discriminator as string, opts as unknown as [z.ZodDiscriminatedUnionOption<string>, ...z.ZodDiscriminatedUnionOption<string>[]]);
    }
    default:
      return node;
  }
}

export function isKnownOp(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(OpSchemas, name);
}

/**
 * Validate one op's arguments exactly as a direct tool call would, returning
 * the parsed value — defaults applied, unknown keys refused. Throws the zod
 * error; callers turn it into prose with `invalidArgsText`.
 */
export function parseOpArgs(name: string, raw: unknown): unknown {
  const schema = OpSchemas[name as keyof typeof OpSchemas] as AnyZod | undefined;
  if (!schema) throw new Error(`Unknown op: ${name}`);
  return deepStrict(schema).parse(raw ?? {});
}

export interface BatchStep {
  op: string;
  args?: unknown;
}

/** Thrown when any step of a batch is invalid. Nothing has been sent when this is raised. */
export class BatchValidationError extends Error {
  constructor(
    message: string,
    readonly problems: { index: number; op: string; error: string }[]
  ) {
    super(message);
    this.name = "BatchValidationError";
  }
}

/**
 * Parse every step of a batch, recursing into nested batches, and return the
 * steps with their parsed args. Throws `BatchValidationError` naming every bad
 * step — index, op and problem — if any step fails; in that case nothing about
 * the batch may be sent to After Effects.
 */
export function validateBatchOps(ops: BatchStep[], path: string = ""): BatchStep[] {
  const problems: { index: number; op: string; error: string }[] = [];
  const parsed: BatchStep[] = [];
  ops.forEach((step, i) => {
    const where = path ? `${path}.${i}` : String(i);
    const op = step?.op;
    try {
      parsed.push({ op, args: parseStep(op, step?.args, where) });
    } catch (e) {
      if (e instanceof BatchValidationError) {
        // A nested batch has already named its own steps by their full path.
        for (const p of e.problems) problems.push(p);
      } else {
        problems.push({ index: i, op: String(op), error: stepErrorText(String(op), e, where) });
      }
    }
  });
  if (problems.length > 0) throw new BatchValidationError(batchErrorMessage(problems, ops.length, path), problems);
  return parsed;
}

function parseStep(op: string, raw: unknown, where: string): unknown {
  if (typeof op !== "string" || op.length === 0) {
    throw new Error("`op` must be a tool name");
  }
  if (!isKnownOp(op)) throw new Error(`Unknown op "${op}". A batch step must name a tool, e.g. "set_layer".`);
  if (SERVER_ONLY.has(op)) {
    throw new Error(
      `${op} is answered by the MCP server itself and never reaches After Effects, so it cannot run inside a batch. Call it on its own.`
    );
  }
  if (SERVER_ASSEMBLED.has(op)) {
    throw new Error(
      `${op} is assembled by the MCP server from an internal read, so it cannot run inside a batch. Call it on its own, or pass diff:true to run_batch.`
    );
  }
  if (DIRECT_ONLY.has(op)) {
    throw new Error(
      `${op} cannot run inside a batch: its image is packaged by the server around a direct call, and a batch ` +
        `step would return a bare temp-file record instead. Call ${op} directly, before or after the batch.`
    );
  }
  const args = parseOpArgs(op, raw);
  if (op === "run_batch") {
    const inner = args as { ops: BatchStep[]; singleUndo?: boolean };
    if (inner.ops.length > NESTED_BATCH_INLINE_MAX && inner.singleUndo !== true) {
      throw new Error(
        `a nested run_batch of ${inner.ops.length} ops would be chunked into a background job inside the outer batch, ` +
          `which nothing drives. Flatten it into the outer batch, or keep it to ${NESTED_BATCH_INLINE_MAX} ops.`
      );
    }
    return { ...inner, ops: validateBatchOps(inner.ops, where) };
  }
  // The same substitution a direct run_jsx call gets: the server reads
  // `scriptPath` and `libraries`, because the panel cannot. Without it a batch
  // step could only ever pass inline `code`.
  if (op === "run_jsx") return resolveRunJsxSource(args as RunJsxArgs);
  return args;
}

function stepErrorText(op: string, e: unknown, where: string): string {
  const text = (e as { issues?: unknown })?.issues ? invalidArgsText(op, e) : (e as Error)?.message ?? String(e);
  return `step ${where} (${op}): ${text}`;
}

function batchErrorMessage(problems: { error: string }[], total: number, path: string): string {
  const shown = problems.slice(0, MAX_REPORTED_STEP_ERRORS).map((p) => p.error);
  const more = problems.length - shown.length;
  const scope = path ? `nested batch at step ${path}` : "run_batch";
  return [
    `${scope}: ${problems.length} of ${total} step${total === 1 ? "" : "s"} failed validation. ` +
      `Nothing was sent to After Effects — no step ran, so there is nothing to undo. Fix ${
        problems.length === 1 ? "it" : "them"
      } and send the whole batch again.`,
    ...shown,
    ...(more > 0 ? [`… and ${more} more invalid step${more === 1 ? "" : "s"}.`] : []),
  ].join("\n");
}
