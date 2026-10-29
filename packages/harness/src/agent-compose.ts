// The model path: route -> (skill / RAG / tools / escalate) -> windowed history -> compose within
// budget. Only reached when no direct answer applies (refusal, confirm/cancel, Skill.respond).
import type { InboundMessage, RouterDecision, SessionProfile, SmartMessage, Turn } from "@wappy_ai/core";
import type { AgentDeps } from "./agent.js";
import { renderSessionProfile, safeCall, trace } from "./agent-support.js";
import { composeWithBudget } from "./compose-with-budget.js";
import { cancelSelectionId, confirmSelectionId } from "./confirm.js";
import { createContextBudget, type ContextBudget } from "./context-budget.js";
import { windowHistory } from "./history-window.js";
import { selectTools } from "./tool-selector.js";
import { TOOL_SCHEMAS_BUDGET_FRACTION } from "./assemble.js";

const SCOPE_GUARDRAIL = "If the user's request is genuinely unrelated to what you're configured to help with, say so honestly and directly rather than guessing or making something up.";

/** M12: replaces every per-skill format hint that used to be hand-authored per domain (e.g. a
 * products skill saying "prefer a list for multiple items"). One fixed instruction, zero domain
 * language, applies to every reply regardless of what connector or skill produced the content —
 * a cognitive question series, not a flat command, per the design this milestone settled on.
 * Runs on every compose call, including the cheapest path ("hi") — a deliberate trade against the
 * router's own cheapest-path principle, made explicitly, not by accident. */
export const FORMAT_REASONING = `Before you reply, work through these questions about how to present it, not just what to say:
1. What formats can I actually use? Plain text. Up to 3 quick-reply buttons. A list of up to 10 options. A single link as a tappable button. An image, video, or document, optionally paired with buttons or a list.
2. Does this reply have 2 or more distinct things the person could choose between? If yes, a list or buttons let them tap instead of type.
3. Is there exactly one clear next action, like opening a link? A tappable link button beats a raw URL in text.
4. Would an image, video, or document actually help here? If yes, attach it — pair it with buttons or a list too if you're also offering a choice.
5. Is this just a short, conversational answer with nothing to structure? Plain text is correct then. Don't force structure onto it.
6. Given all that, which single format fits best, and why? State that reason in formatRationale, specific to this exact reply, not a generic justification you'd give for any reply.`;

/** M12: the single, generic honesty rule that replaced three near-identical, hand-written
 * sentences (store-info/orders/products' own skill fragments each said this in different words). */
export const GROUNDING_HONESTY =
  "Only state what a tool call or retrieved document actually returned. Never invent a detail, a value, or a status that wasn't actually provided. If nothing relevant was found, or a tool call failed, say so honestly rather than guessing.";

/** Used when the caller doesn't supply one — a conservative, safe-by-default budget (§10 T6.1). */
const DEFAULT_CONTEXT_BUDGET: ContextBudget = createContextBudget("unrecognized");
const DEFAULT_MAX_RECENT_TURNS = 20;

export interface ComposedReply {
  reply: SmartMessage;
  /** M13: session-profile extraction drafted by the same compose call. */
  extracted: { facts?: Record<string, string>; currentState?: string; summary?: string };
}

/** M19 T19.4: a confirmation requested this turn always reaches the person as Confirm / Cancel
 * buttons — the compose model is asked to add them, but a safety step can't depend on it remembering. */
async function withConfirmButtons(reply: SmartMessage, contactId: string, pendingBefore: string | undefined, deps: AgentDeps): Promise<SmartMessage> {
  if (!deps.confirmFlow) return reply;
  const pending = await safeCall(() => deps.confirmFlow!.getPending(contactId), undefined);
  if (!pending || pending.id === pendingBefore) return reply;
  if (reply.buttons?.some((b) => b.id === confirmSelectionId(pending.id))) return reply;
  // Buttons replace a list or link button: WhatsApp sends one kind of interactive part per message.
  const rest: SmartMessage = { ...reply };
  delete rest.list;
  delete rest.cta;
  return { ...rest, text: rest.text ?? pending.summary, buttons: [{ id: confirmSelectionId(pending.id), title: "Confirm" }, { id: cancelSelectionId(pending.id), title: "Cancel" }] };
}

export async function routeAndCompose(message: InboundMessage, effectiveText: string | undefined, history: Turn[], sessionProfile: SessionProfile | undefined, deps: AgentDeps): Promise<ComposedReply> {
  trace(deps.tracer, "router", "route");
  let decision: RouterDecision;
  try {
    // The full tool pool's names, not just a skill's own subset — the router decides needsTool
    // (and which skill) BEFORE a skill is chosen, so it can't yet know a skill-scoped list.
    // Previously hardcoded to [] here, which made the router's own prompt literally say
    // "Available tools: (none)" even when tools existed — found by hand-testing a real
    // conversation: "show me your products" was declined because the router, told there were no
    // tools at all, never set needsTool even though searchProducts was fully wired.
    decision = await deps.router.route({ message: { ...message, text: effectiveText }, history, availableSkills: deps.skills?.names() ?? [], availableTools: deps.tools?.map((t) => t.name) ?? [] });
  } catch {
    decision = { intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0 };
  }

  const confident = decision.confidence >= (deps.confidenceThreshold ?? 0.3);
  const budget = deps.contextBudget ?? DEFAULT_CONTEXT_BUDGET;

  const skillFragments: string[] = [];
  let skillToolNames: string[] = [];
  if (confident && decision.skill) {
    const skill = await safeCall(async () => deps.skills?.get(decision.skill!), undefined);
    if (skill) {
      trace(deps.tracer, "skill", "selected", { skill: skill.name });
      skillFragments.push(skill.promptFragment);
      skillToolNames = skill.tools ?? [];
    }
  }

  // Tool-invocation findings are typically more directly actionable (e.g. "order 8842: shipped")
  // than generic RAG recall, so they're kept in their own array and placed AHEAD of recalledSnippets
  // when the two are combined below — capArrayFromEnd drops from the tail first, so this ordering
  // means generic RAG results are dropped before tool findings under budget pressure, not the reverse.
  const toolFindings: string[] = [];
  const recalledSnippets: string[] = [];
  if (confident && decision.needsRAG && deps.retrieveRag) {
    trace(deps.tracer, "rag", "retrieve");
    const snippets = await safeCall(() => deps.retrieveRag!({ contactId: message.contactId, query: effectiveText ?? "" }), []);
    recalledSnippets.push(...snippets);
  }

  // Which confirmation was pending before this turn — one requested now is the one the reply must offer.
  const pendingBefore = deps.confirmFlow ? (await safeCall(() => deps.confirmFlow!.getPending(message.contactId), undefined))?.id : undefined;

  const toolSchemas: string[] = [];
  if (confident && decision.needsTool) {
    if (deps.invokeTools) {
      trace(deps.tracer, "tools", "invoke");
      // Uses the same bounded/truncated text every other consumer (router, RAG query, selectTools,
      // the persisted turn) already uses — not the raw, unbounded message.
      const findings = await safeCall(() => deps.invokeTools!({ message: { ...message, text: effectiveText }, decision, history }), []);
      toolFindings.push(...findings.map((f) => `Tool result: ${f}`));
    }
    if (deps.tools && deps.tools.length > 0) {
      const selected = selectTools({ tools: deps.tools, message: effectiveText ?? "", alwaysInclude: skillToolNames, maxTokens: Math.floor(budget.promptBudget * TOOL_SCHEMAS_BUDGET_FRACTION) });
      toolSchemas.push(...selected.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })));
    }
  }

  if (decision.escalate && deps.onEscalate) {
    await safeCall(async () => {
      await deps.onEscalate!(message, decision);
      return undefined;
    }, undefined);
  }

  // §10 "out-of-scope ask -> honest decline": a standing instruction, not special-cased branching —
  // the model is trusted to say so plainly rather than guess when a request is genuinely unrelated
  // to what it's configured to help with. Kept as its own leading skill-like fragment.
  const windowed = await windowHistory({ model: deps.model, memory: deps.memory, contactId: message.contactId, history, maxRecentTurns: deps.maxRecentTurns ?? DEFAULT_MAX_RECENT_TURNS, clock: deps.clock, tracer: deps.tracer });

  const composed = await composeWithBudget({
    model: deps.model,
    input: {
      system: [deps.instructions?.trim(), SCOPE_GUARDRAIL, FORMAT_REASONING, GROUNDING_HONESTY].filter(Boolean).join("\n\n"),
      sessionProfile: renderSessionProfile(sessionProfile),
      skillFragments,
      toolSchemas,
      summary: windowed.summary,
      recalledSnippets: [...toolFindings, ...recalledSnippets],
      recentTurns: windowed.recentTurns,
      userMessage: effectiveText ?? "(no text)",
    },
    budget,
  });
  // One "llm" event (not two) carries both the compose step and its token-usage-per-section (T6.9)
  // — spine A's own assertion counts "llm" trace events as a proxy for underlying model calls, and
  // this compose step is exactly one such call (retries/shrinks happen inside composeWithBudget).
  trace(deps.tracer, "llm", "compose", { usage: composed.usage, dropped: composed.dropped, shrunkForContextLength: composed.shrunkForContextLength, formatRationale: composed.formatRationale });
  // M13: this same compose call drafted the extraction, for free.
  const reply = await withConfirmButtons(composed.reply, message.contactId, pendingBefore, deps);
  return { reply, extracted: { facts: composed.sessionFacts, currentState: composed.sessionCurrentState, summary: composed.sessionSummary } };
}
