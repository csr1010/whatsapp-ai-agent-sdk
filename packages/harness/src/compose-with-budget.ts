import { z } from "zod";
import { SmartMessageSchema, type Model, type SmartMessage } from "@wappy_ai/core";
import { assemblePrompt, type AssembleInput, type AssembleResult } from "./assemble.js";
import type { ContextBudget } from "./context-budget.js";

const REPAIR_NOTE = "\n\n(Your previous reply didn't match the required JSON schema — respond again with valid JSON only.)";
const FALLBACK_TEXT = "Sorry, I'm having trouble putting together a reply right now — please try again shortly.";
/** Used only on the fallback-degrade path (no real compose ever succeeded) — never a fabricated
 * justification for a format the model didn't actually choose. */
const FALLBACK_RATIONALE = "(no rationale — compose failed, this is the honest-degrade fallback text)";

/**
 * M12: the compose call's response is wrapped with `formatRationale`, LOCAL to this module only —
 * this does NOT change the core `SmartMessage`/`MessageChannel.send()` contract; `reply` below is
 * still exactly a `SmartMessage`, unwrapped, before it ever reaches a caller. Capturing the
 * rationale (not just prompting for good format choice and discarding the reasoning) makes a bad
 * format choice debuggable later — traced by agent.ts after a successful call.
 */
/** M13: extends the same wrapper with the session-profile extraction fields — zero extra model
 * calls, the same compose call that already produces `formatRationale` also drafts these. All
 * three are optional: the model may have nothing worth extracting on a given turn ("summary" is
 * explicitly allowed to lag `currentState`, and not every reply introduces a new fact). */
const ComposeResponseSchema = z.object({
  formatRationale: z.string().min(1).max(300),
  sessionFacts: z.record(z.string(), z.string()).optional(),
  sessionCurrentState: z.string().optional(),
  sessionSummary: z.string().optional(),
  message: SmartMessageSchema,
});
const composeResponseJsonSchema = z.toJSONSchema(ComposeResponseSchema);

/** Provider-agnostic detection of a "context too long" failure (§10 T6.8): checks the normalized
 * `code` convention used by testkit's mockModel first, then falls back to matching common phrasing
 * across providers, since there's no single error type shared by every model provider. */
function isContextLengthError(e: unknown): boolean {
  if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "context_length_exceeded") return true;
  const message = e instanceof Error ? e.message : String(e);
  return /context.?length|too many tokens|maximum context|token limit|context window/i.test(message);
}

function shrinkBudget(budget: ContextBudget, factor: number): ContextBudget {
  return { estimator: budget.estimator, promptBudget: Math.floor(budget.promptBudget * factor) };
}

export interface ComposeWithBudgetOptions {
  model: Model;
  input: AssembleInput;
  budget: ContextBudget;
}

export interface ComposeWithBudgetResult {
  reply: SmartMessage;
  /** M12: the model's own stated reason for the format it picked — captured for tracing, never
   * sent to WhatsApp. `FALLBACK_RATIONALE` on the honest-degrade path (no real compose succeeded). */
  formatRationale: string;
  /** M13: session-profile extraction from this same compose call — all optional, absent on the
   * fallback-degrade path (never a fabricated extraction, same principle as `FALLBACK_RATIONALE`). */
  sessionFacts?: Record<string, string>;
  sessionCurrentState?: string;
  sessionSummary?: string;
  usage: Record<string, number>;
  dropped: string[];
  /** True if a context-length error triggered the shrink-and-retry (§10 T6.8). */
  shrunkForContextLength: boolean;
}

/**
 * Assembles a prompt (T6.2) and composes a SmartMessage (+ M12's formatRationale), with ONE repair
 * attempt across two distinct failure modes: malformed/invalid structured output (or any other
 * error) gets the same repair-note retry as compose.ts's composeSmartMessage; a context-length
 * error specifically SHRINKS the budget by 25% and retries instead (adding a repair note would
 * only make an oversized prompt worse). Still degrades to whatever text either attempt produced,
 * or an honest fallback, never a crash or a silent reply (§10).
 */
const str = (v: unknown, max = Infinity): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);

/** The reply out of a response whose wrapper didn't validate: `message` must be a valid SmartMessage;
 * each extra is kept only if it's usable, and only string-valued facts are kept. */
function salvage(structured: unknown): Pick<ComposeWithBudgetResult, "reply" | "formatRationale" | "sessionFacts" | "sessionCurrentState" | "sessionSummary"> | undefined {
  if (!structured || typeof structured !== "object") return undefined;
  const s = structured as Record<string, unknown>;
  const message = SmartMessageSchema.safeParse(s.message);
  if (!message.success) return undefined;
  const facts = s.sessionFacts && typeof s.sessionFacts === "object" && !Array.isArray(s.sessionFacts)
    ? Object.fromEntries(Object.entries(s.sessionFacts).filter((e): e is [string, string] => typeof e[1] === "string"))
    : undefined;
  return {
    reply: message.data,
    formatRationale: str(s.formatRationale, 300) ?? FALLBACK_RATIONALE,
    ...(facts && Object.keys(facts).length ? { sessionFacts: facts } : {}),
    ...(str(s.sessionCurrentState) ? { sessionCurrentState: str(s.sessionCurrentState) } : {}),
    ...(str(s.sessionSummary) ? { sessionSummary: str(s.sessionSummary) } : {}),
  };
}

export async function composeWithBudget(opts: ComposeWithBudgetOptions): Promise<ComposeWithBudgetResult> {
  let budget = opts.budget;
  let input = opts.input;
  let lastText: string | undefined;
  let lastAssembled: AssembleResult | undefined;
  let shrunkForContextLength = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const assembled = assemblePrompt(input, budget);
    lastAssembled = assembled;
    try {
      const result = await opts.model.generate({ prompt: assembled.prompt, system: opts.input.system, responseSchema: composeResponseJsonSchema });
      if (result.text) lastText = result.text;
      const parsed = ComposeResponseSchema.safeParse(result.structured);
      if (parsed.success) {
        return {
          reply: parsed.data.message,
          formatRationale: parsed.data.formatRationale,
          sessionFacts: parsed.data.sessionFacts,
          sessionCurrentState: parsed.data.sessionCurrentState,
          sessionSummary: parsed.data.sessionSummary,
          usage: assembled.usage,
          dropped: assembled.dropped,
          shrunkForContextLength,
        };
      }
      // M19 T19.3: a valid reply is kept even when only the extras around it are off (facts that
      // aren't plain strings, an over-long rationale) — they're nice to have; the reply is the point.
      const salvaged = salvage(result.structured);
      if (salvaged) return { ...salvaged, usage: assembled.usage, dropped: assembled.dropped, shrunkForContextLength };
      input = { ...opts.input, userMessage: opts.input.userMessage + REPAIR_NOTE };
    } catch (e) {
      if (isContextLengthError(e)) {
        shrunkForContextLength = true;
        budget = shrinkBudget(budget, 0.75);
        input = opts.input; // don't also grow the prompt with a repair note when the problem is size
      } else {
        input = { ...opts.input, userMessage: opts.input.userMessage + REPAIR_NOTE };
      }
    }
  }

  // lastAssembled is always set: the loop above runs at least twice (attempt < 2 starts at 0) and
  // assigns it unconditionally on every iteration before anything that could exit early.
  return { reply: { text: lastText ?? FALLBACK_TEXT }, formatRationale: FALLBACK_RATIONALE, usage: lastAssembled!.usage, dropped: lastAssembled!.dropped, shrunkForContextLength };
}
