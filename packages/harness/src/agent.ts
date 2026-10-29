import type { Agent, Clock, DeliveryResult, InboundMessage, MessageChannel, Memory, Model, Router, RouterDecision, SessionProfileStore, SmartMessage, TracedSystem, Tool, Tracer, Turn } from "@wappy_ai/core";
import { boundInboundText, DEFAULT_INBOUND_TEXT_LIMITS, type InboundTextLimits } from "./bound-inbound-text.js";
import type { ContextBudget } from "./context-budget.js";
import type { SkillRegistry } from "./skills.js";
import { parseConfirmSelection, type ConfirmFlow } from "./confirm.js";
import { safeAppend, safeCall, safeLoad, safeLoadSessionProfile, safeSetSessionProfile, summarizeReply, trace } from "./agent-support.js";
import { resolvePendingConfirmation } from "./agent-confirm.js";
import { routeAndCompose, type ComposedReply } from "./agent-compose.js";

// The agent's prompt rules live with the compose path; re-exported here, where callers always found them.
export { FORMAT_REASONING, GROUNDING_HONESTY } from "./agent-compose.js";

const REFUSAL_TEXT = "That message is too long for me to process — could you send it as a shorter message?";
const OVERSIZED_PLACEHOLDER = "(the user sent a message too large to process)";
/** M13: session profile TTL — renewed on every successful turn (a plain `set()`, no separate
 * "touch" verb). 30 minutes of inactivity resets the session to empty, matching the design's own
 * "session-scoped, not a permanent user profile" boundary (docs/milestones/M13.md). */
const DEFAULT_SESSION_PROFILE_TTL_MS = 30 * 60 * 1000;

/** TracedSystem values a MessageChannel is allowed to be traced under — deliberately closed (not
 * `channel.name` verbatim) so a customized channel name can't inject an out-of-union label into
 * `tracer.touched()`/`events()`. */
const KNOWN_TRACED_CHANNELS: ReadonlySet<string> = new Set<TracedSystem>(["whatsapp"]);

export interface AgentDeps {
  channel: MessageChannel;
  memory: Memory;
  router: Router;
  model: Model;
  clock: Clock;
  tracer: Tracer;
  skills?: SkillRegistry;
  /** M13: session profile (facts + current open thread + a coarser summary), TTL-bound. Unset =
   * feature off entirely, fully backward compatible — nothing is read or written. When set, read
   * at the very start of `handle()` alongside `memory.load()`, and written after a successful send. */
  sessionProfileStore?: SessionProfileStore;
  /** How long a session profile survives inactivity before a fresh session starts with nothing
   * carried over. Default 30 minutes. */
  sessionProfileTtlMs?: number;
  /** RAG hook — default: no-op (no extra context). Real implementation (§9 Scenario B): `knowledge.ts`'s `createKnowledgeRag()` (M8). */
  retrieveRag?: (input: { contactId: string; query: string }) => Promise<string[]>;
  /** Tool-invocation hook — default: no-op (no findings). Real implementation (§9 Scenario C): `invoke-tools.ts`'s `createToolInvoker()` (M8). */
  invokeTools?: (input: { message: InboundMessage; decision: RouterDecision; history?: Turn[] }) => Promise<string[]>;
  /** Pool available for runtime BM25 selection (T6.5) when a message needsTool — declaring available
   * tools to the model (for the prompt's textual tool-schema disclosure) is separate from actually
   * invoking one (that's `invokeTools`, e.g. `createToolInvoker({tools, ...})` using this same pool). Default []. */
  tools?: Tool[];
  /** Confirm-before-write flow (§8/§9 T8.5) — when set, an inbound message carrying
   * `selectionId: "confirm"`/`"cancel"` is intercepted HERE, before routing, and resolves the
   * contact's pending confirmation (executing the held tool call exactly once, or discarding it)
   * instead of going through the normal skill/RAG/tool/compose pipeline. Requesting a confirmation
   * in the first place is `createToolInvoker`'s job (via this same flow, passed to it separately) —
   * this dependency is what RESOLVES one once the user replies. Default: confirm/cancel selection
   * ids are treated as ordinary messages (no interception) when unset. */
  confirmFlow?: ConfirmFlow;
  /** M19: the app's standing instructions — who the agent is, how it talks, what it always needs
   * to know — placed at the start of every reply's system prompt, whatever the router picked.
   * Unset or empty = nothing added (the behaviour before M19). Counts toward the prompt budget. */
  instructions?: string;
  /** Bounds the whole assembled prompt (T6.1/T6.2); default is a conservative, model-agnostic budget. */
  contextBudget?: ContextBudget;
  /** Turns kept verbatim in the prompt; older history is summarized (T6.3). Default 20. */
  maxRecentTurns?: number;
  /** Below this, skill/RAG/tool augmentation is suppressed but a reply is still always sent (§9 confidence gate). Default 0.3. */
  confidenceThreshold?: number;
  onEscalate?: (message: InboundMessage, decision: RouterDecision) => void | Promise<void>;
  /** Id for the agent's own reply Turn to a given inbound message — MUST be deterministic per
   * `message.id` (and unique across contacts), since it's also the idempotency marker a replay is
   * checked against. Default: `${message.id}:reply`. */
  idGenerator?: (message: InboundMessage) => string;
  /** Thresholds for an oversized inbound message.text (§10) — truncated with a notice below
   * `refuseChars`, politely declined (no routing/compose, still exactly one reply) above it. */
  inboundTextLimits?: InboundTextLimits;
}

/**
 * Orchestrates one inbound message -> reply: load memory -> route -> (skill/RAG/tool) -> compose ->
 * confidence gate -> send -> persist -> trace, each step degrading rather than crashing (§9, §10).
 * Per-contact serialized so two rapid messages for the same contact never interleave or double-persist.
 */
export function createAgent(deps: AgentDeps): Agent {
  const chains = new Map<string, Promise<unknown>>();
  // handleOne is exception-safe by construction (every fallible step below has its own fallback,
  // plus an outer safety net), so prev's fulfill/reject handlers are identical either way.
  const serialize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const settle = prev.then(fn, fn);
    chains.set(key, settle);
    // Free this contact's slot once idle (no newer call queued behind this one), so a long-running
    // process serving many distinct contacts over time doesn't leak one Map entry per contact forever.
    // settle can never reject (handleSafely converts every throw into a resolved DeliveryResult), so
    // only the fulfillment arm is reachable — a symmetric reject arm would be permanently dead code.
    void settle.then(() => { if (chains.get(key) === settle) chains.delete(key); });
    return settle;
  };

  return {
    handle: (message) => serialize(message.contactId, () => handleSafely(message, deps)),
  };
}

async function handleSafely(message: InboundMessage, deps: AgentDeps): Promise<DeliveryResult> {
  try {
    return await handleOne(message, deps);
  } catch (e) {
    // Absolute last resort: some dependency (tracer, skill registry, clock, idGenerator, ...) threw
    // somewhere not already given a typed fallback above. Still answer honestly rather than reject.
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** M16: ask each registered skill with respond(), in order; a throwing responder is skipped. */
async function firstSkillResponse(message: InboundMessage, history: Turn[], deps: AgentDeps): Promise<SmartMessage | undefined> {
  const skills = deps.skills?.list() ?? [];
  for (const skill of skills) {
    if (!skill.respond) continue;
    const out = await safeCall(async () => skill.respond!({ message, history }), undefined);
    if (out === undefined || out === "") continue;
    trace(deps.tracer, "skill", "respond", { skill: skill.name });
    return typeof out === "string" ? { text: out } : out;
  }
  return undefined;
}

async function handleOne(message: InboundMessage, deps: AgentDeps): Promise<DeliveryResult> {
  trace(deps.tracer, "memory", "load", { contactId: message.contactId });
  const history = await safeLoad(deps.memory, message.contactId);
  // M13: read alongside memory.load() — deps.clock.now() drives the TTL check inside get(), so an
  // expired profile comes back as undefined here, not stale state from a prior session.
  const sessionProfile = await safeLoadSessionProfile(deps.sessionProfileStore, message.contactId, deps.clock.now());

  // The idempotency marker is the REPLY turn, not the inbound one: the inbound turn is persisted
  // unconditionally below, long before the message is actually answered, so checking for it would
  // treat "we started this turn" as "we finished it" — an ordinary send failure (not just a crash)
  // would then make a legitimate retry silently report "sent" without ever composing/sending anything.
  const replyTurnId = deps.idGenerator?.(message) ?? `${message.id}:reply`;
  if (history.some((t) => t.id === replyTurnId)) {
    return { status: "sent" }; // already fully answered in a prior attempt — never re-send
  }

  // An oversized message.text is bounded BEFORE anything else uses it: truncated (with a notice) for
  // normal processing, or — beyond refuseChars — skips routing/compose entirely for a fixed, honest
  // decline (§10 "extremely large -> polite refusal, still one reply"). Never store the raw oversized
  // text in Memory either, or a huge blob just moves from "in the prompt" to "in the next prompt."
  const bounded = message.text !== undefined ? boundInboundText(message.text, deps.inboundTextLimits ?? DEFAULT_INBOUND_TEXT_LIMITS) : undefined;
  const effectiveText = bounded ? (bounded.refuse ? OVERSIZED_PLACEHOLDER : bounded.text) : message.text;

  // Guarded the same way as the reply turn below: a retry of a message whose PREVIOUS attempt
  // persisted the user turn but failed before sending must not re-append it. This can't rely on the
  // Memory backend itself being idempotent-by-id (that's an implementation detail of
  // createLibsqlMemory, not part of the Memory interface's contract) — a non-deduping backend would
  // otherwise accumulate duplicate turns in history across every retry before an eventual success.
  if (!history.some((t) => t.id === message.id)) {
    const now = deps.clock.now();
    await safeAppend(deps.memory, { id: message.id, contactId: message.contactId, role: "user", text: effectiveText, timestamp: now });
  }

  // Only computed when a confirmFlow is configured at all — parseConfirmSelection() returning a
  // result additionally requires the selectionId to carry a specific pending confirmation's id
  // (confused-deputy protection; see resolvePendingConfirmation()'s own doc comment).
  const parsedConfirm = deps.confirmFlow ? parseConfirmSelection(message.selectionId) : undefined;

  let reply: SmartMessage;
  let direct: SmartMessage | undefined;
  // M13: only set on the compose path (refusal/confirm replies don't route through the model, so
  // there's nothing to extract) — merged over the existing profile, not replacing it, when written below.
  let extracted: ComposedReply["extracted"] = {};
  if (bounded?.refuse) {
    reply = { text: REFUSAL_TEXT };
  } else if (parsedConfirm) {
    // A confirm/cancel button reply carries no routable intent of its own (a bare "confirm" means
    // nothing to the router without the pending-confirmation context) — resolved here, before
    // routing, instead of through the normal skill/RAG/tool/compose pipeline.
    reply = await resolvePendingConfirmation(message, parsedConfirm, deps.confirmFlow!, deps);
  } else if ((direct = await firstSkillResponse({ ...message, text: effectiveText }, history, deps))) {
    // M16: a skill answered directly — no routing, no model call. Persist/dedupe/send below as usual.
    reply = direct;
  } else {
    ({ reply, extracted } = await routeAndCompose(message, effectiveText, history, sessionProfile, deps));
  }

  const channelSystem = KNOWN_TRACED_CHANNELS.has(deps.channel.name) ? (deps.channel.name as TracedSystem) : undefined;
  if (channelSystem) trace(deps.tracer, channelSystem, "send");
  let result: DeliveryResult;
  try {
    result = await deps.channel.send(message.contactId, reply);
  } catch (e) {
    result = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }

  // Only record the agent as having replied when something actually reached the user — a "failed"/
  // "queued" result must not leave a turn in history claiming the agent said something it didn't,
  // which would otherwise get fed back to the model as prior context on the contact's next message.
  //
  // Uses summarizeReply(), not reply.text directly, since a buttons/list/cta/media-only SmartMessage
  // has no `text` at all (§6.3 — the model is free to choose this from the start, not gated behind a
  // future milestone). On "fellBack" the channel actually delivered renderNumberedFallback()'s plain
  // text, not this summary — an acceptable approximation (same offer, reworded) rather than plumbing
  // the literal delivered text back through DeliveryResult, but worth revisiting if that mismatch
  // ever matters (e.g. the numbered options' exact wording becomes something the model must recall).
  if (result.status === "sent" || result.status === "fellBack") {
    await safeAppend(deps.memory, { id: replyTurnId, contactId: message.contactId, role: "agent", text: summarizeReply(reply), timestamp: deps.clock.now() });

    // M13: written at the same point the reply gets persisted — facts MERGE (a fact once learned
    // isn't lost just because this turn didn't re-state it), currentState/summary REPLACE wholesale
    // when this turn produced a new one (else carried over as-is — "allowed to lag", not forced to
    // null every turn). expiresAt is always stamped fresh here, which is also how the TTL renews.
    if (deps.sessionProfileStore) {
      const now = deps.clock.now();
      const nextCurrentState = extracted.currentState ?? sessionProfile?.currentState;
      const nextSummary = extracted.summary ?? sessionProfile?.summary;
      await safeSetSessionProfile(deps.sessionProfileStore, {
        contactId: message.contactId,
        facts: { ...(sessionProfile?.facts ?? {}), ...(extracted.facts ?? {}) },
        ...(nextCurrentState !== undefined ? { currentState: nextCurrentState } : {}),
        ...(nextSummary !== undefined ? { summary: nextSummary } : {}),
        expiresAt: now + (deps.sessionProfileTtlMs ?? DEFAULT_SESSION_PROFILE_TTL_MS),
      });
    }
  }

  return result;
}
