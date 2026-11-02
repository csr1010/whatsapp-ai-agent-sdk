import type { Commitment, DeliveryResult, InboundMessage, RouterDecision, SessionProfile, SmartMessage, Task, ToolResult, Turn } from "./schemas.js";

/** JSON Schema object, as produced by zod's toJSONSchema and consumed by Model tool-calling. */
export type JsonSchema = Record<string, unknown>;

/** A single callable tool (§3, §8). */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Never mutates external state; safe to auto-call without confirmation. */
  readOnly: boolean;
  /** Requires explicit user/operator confirmation before executing, regardless of readOnly. */
  confirmBefore: boolean;
  execute(args: unknown): Promise<ToolResult>;
}

/** Generates Tools from a source (OpenAPI spec, Shopify, custom code) (§3, §8). */
export interface ToolProvider {
  name: string;
  listTools(): Promise<Tool[]> | Tool[];
}

/** Prompt fragment + tools + optional memory schema for one capability (§17 glossary). */
export interface Skill {
  name: string;
  description: string;
  promptFragment: string;
  /** Names of tools (from registered ToolProviders) this skill may use. */
  tools?: string[];
  /** M27: the job this skill belongs to, for a host that groups skills. Core never interprets it. */
  mode?: string;
  /** Opaque, skill-owned shape persisted alongside Memory; core never interprets it. */
  memorySchema?: unknown;
  /**
   * M16: answer directly, without routing or a model call (commands, opt-outs, exact matches, echo).
   * Tried before routing, in registration order; the first non-undefined result is the reply. The
   * agent still persists turns, dedupes replays and sends through the channel as usual. Return
   * undefined to let the normal route + compose path handle the message.
   */
  respond?(input: SkillRespondInput): SmartMessage | string | undefined | Promise<SmartMessage | string | undefined>;
}

export interface SkillRespondInput {
  /** The inbound message, with text already bounded the same way the rest of the pipeline sees it. */
  message: InboundMessage;
  /** This contact's history as loaded for this turn (oldest first). */
  history: Turn[];
}

/**
 * M16: the unit a host installs on a number — an app/agent package. Depends only on core types, so
 * the same app runs self-hosted (wired by hand) or on a multi-tenant host (wired per tenant).
 */
export interface WappyApp {
  /** Stable id, unique across apps (e.g. "echo"). */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Skills this app adds to the agent on the number it's installed on. */
  skills?: Skill[];
  /** Tools this app contributes (its skills reference them by name). */
  tools?: Tool[];
}

/**
 * receive() returns an array: one webhook payload may batch several message
 * events, or contain zero when it's a status/read-receipt-only notification
 * (§6.2). send() takes an explicit recipient because a channel serves many
 * contacts.
 */
export interface MessageChannel {
  name: string;
  receive(rawWebhook: unknown): Promise<InboundMessage[]> | InboundMessage[];
  send(to: string, message: SmartMessage): Promise<DeliveryResult>;
}

export interface Memory {
  load(contactId: string): Promise<Turn[]>;
  append(turn: Turn): Promise<void>;
  /** Semantic recall scoped to one contact's history/knowledge. Returns text snippets. */
  recall(contactId: string, query: string): Promise<string[]>;
}

/** M13: one focused store for the session profile, same pattern as `@wappy_ai/whatsapp`'s
 * `SeenStore`/`SessionWindowTracker` — not an overload of `Memory` (turn history is a separate
 * concern from a structured, TTL-bound profile). */
export interface SessionProfileStore {
  /** `undefined` when no profile exists for this contact, OR it exists but `now > expiresAt` — a
   * caller never has to separately check expiry; an expired profile IS an absent one. */
  get(contactId: string, now: number): Promise<SessionProfile | undefined>;
  /** Upsert. Callers always pass a fresh `expiresAt`, so calling this after every successful turn
   * is also how the TTL renews — there's no separate "touch" operation. */
  set(profile: SessionProfile): Promise<void>;
}

/** M27: one focused store, newest task first. One writer per contact, so a whole-list save is safe. */
export interface TaskStore {
  /** Expired tasks are absent, same contract as `SessionProfileStore.get`. */
  list(contactId: string, now: number): Promise<Task[]>;
  save(contactId: string, tasks: Task[]): Promise<void>;
}

/** M27: append-only. Logging the same id twice keeps the first, so a retried message can't double up. */
export interface CommitmentStore {
  log(commitment: Commitment): Promise<void>;
  list(contactId: string): Promise<Commitment[]>;
}

export interface RouterInput {
  message: InboundMessage;
  history: Turn[];
  availableSkills: string[];
  availableTools: string[];
  /** M27: what this contact is in the middle of, when a `TaskStore` is set. */
  tasks?: Task[];
}

export interface Router {
  route(input: RouterInput): Promise<RouterDecision>;
}

export interface ModelToolCall {
  name: string;
  args: unknown;
}

export interface ModelRequest {
  prompt: string;
  /** Sent as a system-role message when the underlying adapter supports it — kept separate from `prompt` so structured role separation survives even when the caller has already assembled everything into one deterministic prompt string (T6.2). */
  system?: string;
  history?: Turn[];
  tools?: Tool[];
  /** e.g. smartMessageJsonSchema, when the model must emit a SmartMessage (§6.3). */
  responseSchema?: JsonSchema;
}

export interface ModelResult {
  text?: string;
  structured?: unknown;
  toolCalls?: ModelToolCall[];
}

/** The model port — Vercel AI SDK or any provider sits behind this (§2.1). */
export interface Model {
  generate(req: ModelRequest): Promise<ModelResult>;
}

/** Orchestrates a single inbound message -> reply, wiring Router/Memory/Tools/Channel/Model (§3). */
export interface Agent {
  handle(message: InboundMessage): Promise<DeliveryResult>;
}
