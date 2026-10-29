import type { InboundMessage, JsonSchema, Model, RouterDecision, Tool, Turn } from "@wappy_ai/core";
import { selectTools } from "./tool-selector.js";
import { boundToolResult, type BoundToolResultOptions } from "./bound-tool-result.js";
import type { TokenEstimator } from "./context-budget.js";
import { cancelSelectionId, confirmSelectionId, type ConfirmFlow } from "./confirm.js";

export interface CreateToolInvokerOptions {
  model: Model;
  tools: Tool[];
  /** Budget for BM25-selecting candidate tools before asking the model to decide (T6.5's own
   * mechanism, reused here) — keeps the decision prompt bounded even with a large toolset. Default 1000. */
  maxSchemaTokens?: number;
  estimator?: TokenEstimator;
  /** Bounds the raw tool result before it becomes a prompt-context finding (T6.6, finally wired for
   * real). Default `{maxBytes: 2000, maxArrayItems: 10}`. */
  boundOptions?: BoundToolResultOptions;
  /** Fired (best-effort, never blocks or throws) when the chosen tool's `execute()` resolves
   * `ok:false` or itself throws — e.g. the underlying API is down — matching §10's "their API down
   * -> caught -> honest reply, escalate hook fired" (T8.6). */
  onToolFailure?: (info: { toolName: string; error: string }) => void | Promise<void>;
  /** Required for a `confirmBefore: true` tool to ever actually execute (§8 "write/delete tools
   * gated by confirmBefore"; T8.5): such a tool's execution is held pending instead of run
   * immediately. Omitting this while a confirmBefore tool is in the pool is a safe default, not a
   * silent gap — the tool is simply never executed, with an honest finding explaining why, rather
   * than skipping the safety gate the app author presumably wanted by marking it confirmBefore. */
  confirmFlow?: ConfirmFlow;
  /** M19: how many earlier turns the tool choice sees besides the latest message. A request often
   * spans turns ("book a visit" → "Saturday" → "Ravi"), and "there" or "that one" only make sense
   * with what came before — from the last message alone, the tool is missed or called with half its
   * arguments. Default 4; 0 = the latest message only (the behaviour before M19). */
  contextTurns?: number;
}

const DEFAULT_CONTEXT_TURNS = 4;
/** Each earlier turn is cut to this before it joins the tool-choice prompt — context, not a transcript. */
const MAX_CONTEXT_TURN_CHARS = 500;

const DEFAULT_MAX_SCHEMA_TOKENS = 1000;
const DEFAULT_BOUND_OPTIONS: BoundToolResultOptions = { maxBytes: 2000, maxArrayItems: 10 };
/** Caps how much of `decision.args` (model-controlled) gets echoed into the confirmation-request
 * summary/finding text — bounds a prompt-injection surface into the downstream compose call the
 * same way every other model-adjacent value in this file is bounded, not because a legitimate tool
 * call needs a long args description here (it's a one-line human-readable summary, not the args
 * actually passed to `execute()`, which are unaffected by this cap). */
const MAX_SUMMARY_ARGS_CHARS = 300;

interface ToolDecision {
  toolName?: string;
  args?: unknown;
}

function decisionSchema(toolNames: string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      toolName: { type: "string", enum: toolNames, description: "Name of the single tool to call for this request. Omit entirely if none of the available tools can help." },
      args: { type: "object", description: "Arguments for the chosen tool, matching its parameters schema." },
    },
  };
}

async function safeNotifyFailure(onToolFailure: CreateToolInvokerOptions["onToolFailure"], toolName: string, error: string): Promise<void> {
  if (!onToolFailure) return;
  try {
    await onToolFailure({ toolName, error });
  } catch {
    // best-effort notification only — an escalation webhook outage must never cost the user their reply
  }
}

function failureFinding(toolName: string, error: string): string {
  return `Tool call to ${toolName} failed (${error}) — tell the user honestly that you couldn't complete this right now and that the team will follow up. Do not fabricate a result.`;
}

/**
 * Builds the real `AgentDeps.invokeTools` hook (§9 Scenario C, finally wired for real in M8): picks
 * candidate tools by BM25 (T6.5's own mechanism), asks the model to decide which ONE (if any) tool
 * actually applies and with what arguments via a plain structured-output call — deliberately NOT the
 * AI SDK's own auto-executing tool loop (`Model.generate({tools})`'s other path in `model.ts`), since
 * that would make the tool's real HTTP call happen INSIDE the decision call: invisible to and
 * unconfirmable by this function, untraceable as "called exactly once", and unusable with `testkit`'s
 * `mockModel` (which never touches `req.tools` at all, only ever returning whatever `toolCalls` a
 * test scripts). Instead, this calls that ONE decided tool's real `execute()` itself, exactly once,
 * and returns its bounded result (T6.6's `boundToolResult`, finally given a real caller) as a single
 * finding string fed into the final compose call — the same shape `retrieveRag`'s snippets take.
 */
/** The last `n` turns with text, oldest first, as `user: …` / `agent: …` lines. */
function recentLines(history: Turn[] | undefined, n: number): string[] {
  if (!history || n <= 0) return [];
  return history
    .filter((t) => t.text && t.role !== "system")
    .slice(-n)
    .map((t) => `${t.role}: ${t.text!.slice(0, MAX_CONTEXT_TURN_CHARS)}`);
}

export function createToolInvoker(opts: CreateToolInvokerOptions): (input: { message: InboundMessage; decision: RouterDecision; history?: Turn[] }) => Promise<string[]> {
  const boundOptions = opts.boundOptions ?? DEFAULT_BOUND_OPTIONS;

  return async ({ message, history }) => {
    const query = message.text ?? "";
    const earlier = recentLines(history, opts.contextTurns ?? DEFAULT_CONTEXT_TURNS);
    // Candidates are picked against the earlier turns too: "Saturday" alone matches no tool.
    const selected = selectTools({ tools: opts.tools, message: [...earlier, query].join("\n"), maxTokens: opts.maxSchemaTokens ?? DEFAULT_MAX_SCHEMA_TOKENS, estimator: opts.estimator });
    if (selected.length === 0) return [];

    const result = await opts.model.generate({
      prompt: `${earlier.length ? `The conversation so far:\n${earlier.join("\n")}\n\n` : ""}The user said: "${query}"\n\nDecide whether one of the available tools should be called to help answer this, and if so, with what arguments${earlier.length ? " — taking anything the user already said earlier into account" : ""}. If none apply, omit toolName.`,
      responseSchema: decisionSchema(selected.map((t) => t.name)),
    });
    const decision = result.structured as ToolDecision | undefined;
    if (!decision?.toolName) return [];

    const tool = selected.find((t) => t.name === decision.toolName);
    if (!tool) return []; // model named a tool outside the candidate set it was actually offered — ignore, don't guess

    if (tool.confirmBefore) {
      if (!opts.confirmFlow) {
        return [`Tool "${tool.name}" requires confirmation before it can run, but no confirmation flow is configured — tell the user honestly that you can't complete this action right now.`];
      }
      const argsJson = JSON.stringify(decision.args ?? {});
      const boundedArgsJson = argsJson.length > MAX_SUMMARY_ARGS_CHARS ? `${argsJson.slice(0, MAX_SUMMARY_ARGS_CHARS)}…` : argsJson;
      const summary = `${tool.name} with arguments ${boundedArgsJson}`;
      const pending = await opts.confirmFlow.request({ contactId: message.contactId, toolName: tool.name, args: decision.args ?? {}, summary });
      // The button ids embed THIS SPECIFIC pending confirmation's id (confirmSelectionId/
      // cancelSelectionId) rather than bare "confirm"/"cancel" — a later, different confirmation
      // request for the same contact replaces this one, and a stale tap on THESE exact buttons must
      // not be mistaken for a reply to whatever replaced them (agent.ts's resolvePendingConfirmation
      // checks the embedded id against the current pending confirmation before acting on it).
      return [
        `This action (${summary}) requires user confirmation before it can proceed. In your reply, briefly explain what will happen and ask the user to confirm, including exactly two buttons: one with id "${confirmSelectionId(pending.id)}" and title "Confirm", and one with id "${cancelSelectionId(pending.id)}" and title "Cancel". Do NOT say this has already been done — it has NOT been executed yet.`,
      ];
    }

    let toolResult;
    try {
      toolResult = await tool.execute(decision.args ?? {});
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await safeNotifyFailure(opts.onToolFailure, tool.name, error);
      return [failureFinding(tool.name, error)];
    }
    if (!toolResult.ok) {
      const error = toolResult.error ?? "unknown error";
      await safeNotifyFailure(opts.onToolFailure, tool.name, error);
      return [failureFinding(tool.name, error)];
    }

    const bounded = boundToolResult(toolResult.data, boundOptions);
    const text = typeof bounded.shown === "string" ? bounded.shown : JSON.stringify(bounded.shown);
    if (bounded.hint) return [`${text} (${bounded.hint})`];
    return [text];
  };
}
