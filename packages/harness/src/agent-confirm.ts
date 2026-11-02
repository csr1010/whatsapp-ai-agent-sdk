import type { InboundMessage, SmartMessage } from "@wappy_ai/core";
import type { AgentDeps } from "./agent.js";
import { safeCall, trace } from "./agent-support.js";
import { CANCEL_ACTION, type ConfirmFlow, type ParsedConfirmSelection } from "./confirm.js";

const NOTHING_PENDING_TEXT = "There's nothing pending to confirm right now.";
const STALE_CONFIRMATION_TEXT = "That confirmation isn't valid anymore — please ask again.";
const CONFIRM_TOOL_UNAVAILABLE_TEXT = "Sorry, I couldn't complete that — please try again, or our team will follow up.";

/**
 * Resolves a contact's pending confirmation in response to a "confirm"/"cancel" button reply (T8.5).
 * `parsed.pendingId` — embedded in the button's own selectionId by `confirmSelectionId()`/
 * `cancelSelectionId()` when the confirmation was first requested — MUST match the CURRENT pending
 * confirmation's own id before anything executes: WhatsApp buttons are static once sent, so if this
 * contact was asked to confirm action A, didn't answer, and was later asked to confirm a different
 * action B (which replaces A as their one pending confirmation), a stale tap on A's old "Confirm"
 * button must not execute B — a confused-deputy replay, not hypothetical, since `request()`
 * unconditionally supersedes an earlier unresolved confirmation for the same contact. A mismatch
 * leaves the CURRENT pending confirmation untouched (it wasn't what the user actually replied to),
 * so a genuine reply to it can still resolve it later.
 *
 * `resolve()` is awaited BEFORE the tool ever runs (not after) so the pending state is gone the
 * instant this function starts acting on it — combined with `createAgent`'s own per-contact
 * serialization (two messages for the same contact are never handled concurrently), a duplicate
 * "confirm" delivered twice back-to-back can never execute the tool twice: the second one finds
 * nothing pending (§9 "confirm executes once even if 'yes' is delivered twice").
 */
export async function resolvePendingConfirmation(message: InboundMessage, parsed: ParsedConfirmSelection, confirmFlow: ConfirmFlow, deps: AgentDeps): Promise<SmartMessage> {
  const pending = await safeCall(() => confirmFlow.getPending(message.contactId), undefined);
  if (!pending) return { text: NOTHING_PENDING_TEXT };
  if (pending.id !== parsed.pendingId) return { text: STALE_CONFIRMATION_TEXT };

  await safeCall(async () => {
    await confirmFlow.resolve(message.contactId);
    return undefined;
  }, undefined);

  const tool = deps.tools?.find((t) => t.name === pending.toolName);
  const words = tool?.describe?.(pending.args);
  if (parsed.action === CANCEL_ACTION) {
    trace(deps.tracer, "tools", "invoke", { toolName: pending.toolName, confirmOutcome: "canceled" });
    return { text: words?.cancelled ?? `Okay, I've canceled that — ${pending.summary} was not carried out.` };
  }

  trace(deps.tracer, "tools", "invoke", { toolName: pending.toolName, confirmOutcome: "confirmed" });
  if (!tool) return { text: CONFIRM_TOOL_UNAVAILABLE_TEXT };

  const toolResult = await safeCall(() => tool.execute(pending.args), { toolName: pending.toolName, ok: false, error: "internal error invoking tool" });
  if (toolResult.ok) return { text: words?.done ?? `Done — ${pending.summary} completed.` };

  await safeCall(async () => {
    await deps.onEscalate?.(message, { intent: "confirm", needsRAG: false, needsTool: true, escalate: true, confidence: 1 });
    return undefined;
  }, undefined);
  return { text: `I couldn't complete that (${toolResult.error ?? "unknown error"}) — I've let the team know and they'll follow up.` };
}
