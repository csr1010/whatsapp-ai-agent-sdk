// Small fail-safe wrappers the agent loop uses: every one turns a dependency's throw into a
// fallback, so a memory, profile, tracer or hook outage never costs the user their reply (§10).
import type { Memory, SessionProfile, SessionProfileStore, SmartMessage, TracedSystem, Tracer, Turn } from "@wappy_ai/core";

export async function safeLoad(memory: Memory, contactId: string): Promise<Turn[]> {
  try {
    return await memory.load(contactId);
  } catch {
    return []; // degrade to a "new contact" view rather than blocking the whole turn on a memory outage
  }
}

export async function safeAppend(memory: Memory, turn: Turn): Promise<void> {
  try {
    await memory.append(turn);
  } catch {
    // best-effort: a persistence hiccup must not cost the user their reply
  }
}

/** M13: `undefined` on any failure (missing store, backend outage, expired) — a session-profile
 * hiccup degrades to "no profile this turn," never blocks the reply, same posture as `safeLoad`. */
export async function safeLoadSessionProfile(store: SessionProfileStore | undefined, contactId: string, now: number): Promise<SessionProfile | undefined> {
  if (!store) return undefined;
  try {
    return await store.get(contactId, now);
  } catch {
    return undefined;
  }
}

/** Only ever called from behind an `if (deps.sessionProfileStore)` guard at the call site — takes
 * a required `store`, not `| undefined`, so there's no redundant/untested defensive branch here. */
export async function safeSetSessionProfile(store: SessionProfileStore, profile: SessionProfile): Promise<void> {
  try {
    await store.set(profile);
  } catch {
    // best-effort: a persistence hiccup must not cost the user their reply
  }
}

/** Renders a `SessionProfile` into the small text block `assemble.ts`'s `sessionProfile` input
 * expects — kept here (not in assemble.ts, which stays decoupled from the profile's shape) since
 * this is the one caller that actually has a `SessionProfile` to render. `undefined` when there's
 * nothing worth including (no facts, no currentState, no summary) — an all-empty profile renders
 * to nothing rather than an empty placeholder section. */
export function renderSessionProfile(profile: SessionProfile | undefined): string | undefined {
  if (!profile) return undefined;
  const lines: string[] = [];
  const factEntries = Object.entries(profile.facts);
  if (factEntries.length > 0) lines.push(`Known facts about this contact: ${factEntries.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  if (profile.currentState) lines.push(`Current state of this thread: ${profile.currentState}`);
  if (profile.summary) lines.push(`Session summary so far: ${profile.summary}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Runs an optional hook (RAG/tools/escalate), swallowing a throw so one integration's outage
 * degrades to "no extra context" rather than losing the whole turn (§10, "each step with a fallback"). */
export async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * A textual stand-in for what was persisted to memory: `SmartMessage.text` is independent of
 * `buttons`/`list`/`cta`/`media` (§6.3 "the model controls UX intent — buttons vs list vs text"), so
 * a rich reply with no `text` set would otherwise persist as `Turn.text: undefined` — which
 * model.ts's `toModelMessages()` then filters out entirely, making the agent's own reply invisible
 * to itself on the next turn. Every real caller here (`composeSmartMessage`'s degrade path always
 * sets `text`; every other reply in this file — refusal, oversized-decline, confirm/cancel — also
 * always sets `text`) only ever produces a `SmartMessage` satisfying `SmartMessageSchema`'s own
 * `.refine()`, which requires at least one of text/buttons/list/cta/media — so `parts` is never
 * empty here; no fallback-to-undefined branch is reachable to simplify away.
 */
export function summarizeReply(message: SmartMessage): string {
  const parts: string[] = [];
  // M19 T19.6: the options offered are remembered numbered, with the text — the person's next message
  // is often "1", "the second one" or a button's title typed out, and it only means something if the
  // agent can see what it offered. (Before, a reply with text kept only its text.)
  const n = (titles: string[]) => titles.map((t, i) => `${i + 1}. ${t}`).join(", ");
  if (message.buttons) parts.push(`buttons: ${n(message.buttons.map((b) => b.title))}`);
  if (message.list) parts.push(`list: ${n(message.list.sections.flatMap((s) => s.rows.map((r) => r.title)))}`);
  if (message.cta) parts.push(`link "${message.cta.text}": ${message.cta.url}`);
  if (message.media) parts.push(message.media.caption ? `${message.media.kind}: ${message.media.caption}` : message.media.kind);
  // A SmartMessage always has text or at least one of these (its schema's own refine).
  if (!parts.length) return String(message.text);
  return message.text ? `${message.text}\n[offered — ${parts.join("; ")}]` : `[${parts.join("; ")}]`;
}

export function trace(tracer: Tracer, system: TracedSystem, event: string, data?: unknown): void {
  try {
    tracer.record(system, event, data);
  } catch {
    // observability must never cost the user their reply
  }
}
