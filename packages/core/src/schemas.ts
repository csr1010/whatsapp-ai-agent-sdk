import { z } from "zod";

/**
 * Runtime schemas for the core data shapes (§3, §6.1, §6.3, §9 of SPEC.md).
 *
 * Layering rule for WhatsApp send-time limits (§6.1): this schema enforces
 * STRUCTURAL bounds only (button/row/section counts) because those can't be
 * fixed by truncation without changing meaning. TEXT LENGTH limits (button
 * title <=20, list row title <=24, row description <=72) are intentionally
 * NOT enforced here — @wappy_ai/whatsapp (M4) truncates them at send time, so
 * an over-length string is valid input at this layer and a renderer concern
 * downstream. See docs/CONTRACTS.md.
 */

export const InboundMediaSchema = z.object({
  kind: z.enum(["image", "document", "video", "audio", "voice", "location"]),
  url: z.string().optional(),
  mimeType: z.string().optional(),
  caption: z.string().optional(),
  /** Only meaningful when kind === "location". */
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});
export type InboundMedia = z.infer<typeof InboundMediaSchema>;

export const InboundMessageSchema = z.object({
  /** Channel-native message id, used for idempotency/dedupe (§6.2). */
  id: z.string().min(1),
  /** Opaque contact identifier, stable per sender on this channel. */
  contactId: z.string().min(1),
  /** Which MessageChannel produced this, e.g. "whatsapp". */
  channel: z.string().min(1),
  text: z.string().optional(),
  media: InboundMediaSchema.optional(),
  /**
   * The stable id of whatever discrete option the user picked (a button/list-row id, a quick-reply
   * payload, ...) — distinct from `text`, which carries the human-readable title and may be
   * duplicated, localized, or renamed. Routing must key off this, never off `text`.
   */
  selectionId: z.string().optional(),
  /** Epoch milliseconds. */
  timestamp: z.number(),
  /** Channel-native payload, kept for debugging/replay; never parsed by core. */
  raw: z.unknown().optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const SmartButtonSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
});
export const SmartButtonsSchema = z.array(SmartButtonSchema).min(1).max(3);

export const SmartListRowSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});
export const SmartListSectionSchema = z.object({
  title: z.string().optional(),
  rows: z.array(SmartListRowSchema).min(1),
});
export const SmartListSchema = z
  .object({
    buttonText: z.string().min(1),
    sections: z.array(SmartListSectionSchema).min(1).max(10),
  })
  .refine((l) => l.sections.reduce((n, s) => n + s.rows.length, 0) <= 10, {
    message: "list: total rows across all sections must be <= 10",
  });

export const SmartCtaSchema = z.object({
  text: z.string().min(1),
  url: z.string().url(),
});

/** An interactive message's header (§6.1/M12): image/video/document/text alongside body + action.
 * Meta's real Cloud API supports this on button/list interactive messages — verified against
 * their docs, not assumed — for a "preview, then text, then CTA/list" reply. Valid only alongside
 * buttons/list/cta (enforced below); a header on a plain text/media-only send is meaningless. */
export const SmartHeaderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1), subText: z.string().optional() }),
  z.object({ type: z.literal("image"), url: z.string().min(1) }),
  z.object({ type: z.literal("video"), url: z.string().min(1) }),
  z.object({ type: z.literal("document"), url: z.string().min(1), filename: z.string().optional() }),
]);

export const SmartMediaSchema = z.object({
  kind: z.enum(["image", "document", "video", "audio", "voice"]),
  url: z.string().min(1),
  caption: z.string().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
});

export const SmartMessageSchema = z
  .object({
    text: z.string().min(1).optional(),
    buttons: SmartButtonsSchema.optional(),
    list: SmartListSchema.optional(),
    cta: SmartCtaSchema.optional(),
    media: SmartMediaSchema.optional(),
    header: SmartHeaderSchema.optional(),
    /** id of an inbound message this reply quotes ("reply in context"). */
    quoteId: z.string().optional(),
    /** Reserved slot for WhatsApp Flows/forms (deferred; SPEC §6.1). Not validated in v0.1. */
    flow: z.unknown().optional(),
  })
  .refine((m) => Boolean(m.text ?? m.buttons ?? m.list ?? m.cta ?? m.media), {
    message: "SmartMessage: at least one of text/buttons/list/cta/media is required",
  })
  .refine((m) => !m.header || Boolean(m.buttons ?? m.list ?? m.cta), {
    message: "SmartMessage: header is only valid alongside buttons/list/cta (Meta's own constraint)",
  });
export type SmartMessage = z.infer<typeof SmartMessageSchema>;

/** JSON Schema for SmartMessage — this is what the model is asked to emit (§6.3). */
export const smartMessageJsonSchema = z.toJSONSchema(SmartMessageSchema);

export const DeliveryStatusSchema = z.enum(["sent", "failed", "queued", "fellBack"]);
export const DeliveryResultSchema = z
  .object({
    status: DeliveryStatusSchema,
    messageId: z.string().optional(),
    /** Actionable, human-readable reason — never a raw stack trace (§10). */
    reason: z.string().optional(),
  })
  .refine((d) => (d.status === "failed" || d.status === "fellBack" ? Boolean(d.reason) : true), {
    message: "DeliveryResult: reason is required when status is failed or fellBack",
  });
export type DeliveryResult = z.infer<typeof DeliveryResultSchema>;

export const TurnSchema = z.object({
  id: z.string().min(1),
  contactId: z.string().min(1),
  role: z.enum(["user", "agent", "system"]),
  text: z.string().optional(),
  timestamp: z.number(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const RouterDecisionSchema = z.object({
  intent: z.string().min(1),
  skill: z.string().optional(),
  needsRAG: z.boolean(),
  needsTool: z.boolean(),
  escalate: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

/** M13: a small, structured, per-contact profile — facts (name, location, ...), the fresh open
 * thread right now (`currentState`, updated every turn, never compressed), and a coarser
 * `summary` allowed to lag behind it. TTL-bound via `expiresAt`; session-scoped, not a permanent
 * cross-session user profile (see docs/milestones/M13.md — that's explicitly deferred). */
export const SessionProfileSchema = z.object({
  contactId: z.string().min(1),
  facts: z.record(z.string(), z.string()),
  currentState: z.string().optional(),
  summary: z.string().optional(),
  expiresAt: z.number(),
  /** M27: when each fact was learned, for facts with their own lifetime. */
  factsAt: z.record(z.string(), z.number()).optional(),
});
export type SessionProfile = z.infer<typeof SessionProfileSchema>;

/** M27: something a contact is in the middle of. Survives restarts; can be paused and picked up again. */
export const TaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mode: z.string().optional(),
  /** What's been gathered so far, kept so the task can resume. */
  state: z.record(z.string(), z.string()),
  status: z.enum(["active", "paused"]),
  startedAt: z.number(),
  updatedAt: z.number(),
  expiresAt: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

/** M27: what this message does to a contact's tasks. */
export const TaskMoveSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("start"), name: z.string().min(1), mode: z.string().optional(), state: z.record(z.string(), z.string()).optional() }),
  z.object({ op: z.literal("update"), state: z.record(z.string(), z.string()) }),
  z.object({ op: z.literal("resume"), name: z.string().min(1) }),
  z.object({ op: z.literal("finish"), name: z.string().min(1).optional() }),
]);
export type TaskMove = z.infer<typeof TaskMoveSchema>;

/** M27: something the business has promised a contact. Logged, never edited. */
export const CommitmentSchema = z.object({
  id: z.string().min(1),
  contactId: z.string().min(1),
  kind: z.string().min(1),
  text: z.string().min(1),
  at: z.number(),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

export const ToolResultSchema = z.object({
  toolName: z.string().min(1),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;
