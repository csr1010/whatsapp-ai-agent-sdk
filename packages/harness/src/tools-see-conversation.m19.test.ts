import { describe, expect, test } from "vitest";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy_ai/testkit";
import { createInMemoryTracer, systemClock } from "@wappy_ai/core";
import type { InboundMessage, Model, ModelRequest, RouterDecision, Tool, Turn } from "@wappy_ai/core";
import { createAgent } from "./agent.js";
import { createToolInvoker } from "./invoke-tools.js";

const NEEDS_TOOL: RouterDecision = { intent: "book", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 };
const msg = (id: string, text: string): InboundMessage => ({ id, contactId: "c1", channel: "whatsapp", text, timestamp: 0 });
const turn = (id: string, role: Turn["role"], text: string): Turn => ({ id, contactId: "c1", role, text, timestamp: 0 });

const bookVisit: Tool = {
  name: "bookVisit", description: "book a visit to a place", parameters: { type: "object", properties: { place: { type: "string" }, day: { type: "string" } } },
  readOnly: true, confirmBefore: false, execute: async (args) => ({ toolName: "bookVisit", ok: true, data: args }),
};
const history = [turn("t1", "user", "I'd like to book a visit to Golden Terra"), turn("t2", "agent", "Sure — which day suits you?")];

describe("M19: the tool choice sees the conversation, not just the latest message", () => {
  test("a reply that only makes sense with what came before still reaches the tool, with the earlier turns in the prompt", async () => {
    const prompts: string[] = [];
    const model: Model = { generate: async (r: ModelRequest) => { prompts.push(r.prompt); return { structured: { toolName: "bookVisit", args: { place: "Golden Terra", day: "Saturday" } } }; } };
    const findings = await createToolInvoker({ model, tools: [bookVisit] })({ message: msg("m3", "Saturday"), decision: NEEDS_TOOL, history });
    expect(findings).toEqual([JSON.stringify({ place: "Golden Terra", day: "Saturday" })]);
    expect(prompts[0]).toContain("user: I'd like to book a visit to Golden Terra");
    expect(prompts[0]).toContain('The user said: "Saturday"');
    // T19.2: what the tool does and the parameter names it reads are in front of the model
    expect(prompts[0]).toContain("- bookVisit: book a visit to a place");
    expect(prompts[0]).toContain('"place"');
  });

  test("contextTurns: 0 keeps the latest-message-only behaviour", async () => {
    let called = false;
    const model: Model = { generate: async () => { called = true; return { structured: {} }; } };
    expect(await createToolInvoker({ model, tools: [bookVisit], contextTurns: 0 })({ message: msg("m3", "Saturday"), decision: NEEDS_TOOL, history })).toEqual([]);
    expect(called).toBe(false); // "Saturday" alone matches no tool
  });
});

describe("M19: the agent passes history to invokeTools and puts its standing instructions in every reply", () => {
  test("invokeTools receives the earlier turns; compose's system prompt starts with the instructions", async () => {
    const systems: string[] = [];
    const model: Model = { generate: async (r) => { systems.push(r.system ?? ""); return { structured: { text: "ok" } }; } };
    const seen: (Turn[] | undefined)[] = [];
    const agent = createAgent({
      channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([NEEDS_TOOL, NEEDS_TOOL]), model, clock: systemClock, tracer: createInMemoryTracer(),
      instructions: "You are the assistant for Example Co.",
      invokeTools: async ({ history }) => { seen.push(history); return []; },
    });
    await agent.handle(msg("m1", "I'd like to book a visit"));
    await agent.handle(msg("m2", "Saturday"));
    expect(seen[1]?.map((t) => t.role)).toEqual(["user", "agent"]);
    expect(seen[1]?.[0]?.text).toBe("I'd like to book a visit");
    expect(systems.at(-1)!.startsWith("You are the assistant for Example Co.")).toBe(true);
  });

  test("no instructions = the system prompt is unchanged", async () => {
    const systems: string[] = [];
    const model: Model = { generate: async (r) => { systems.push(r.system ?? ""); return { structured: { text: "ok" } }; } };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([{ ...NEEDS_TOOL, needsTool: false }]), model, clock: systemClock, tracer: createInMemoryTracer() });
    await agent.handle(msg("m1", "hi"));
    expect(systems.at(-1)!.startsWith("If the user's request is genuinely unrelated")).toBe(true);
  });
});

describe("M19 T19.3: a valid reply survives extras that don't validate", () => {
  test("nested facts and an over-long rationale are dropped; the reply is sent", async () => {
    const sent: unknown[] = [];
    const model: Model = { generate: async () => ({ structured: { message: { text: "Golden Terra is in Kothur." }, sessionFacts: { place: "Golden Terra", detail: { a: 1 } }, formatRationale: "x".repeat(400) } }) };
    const agent = createAgent({
      channel: { name: "test", receive: () => [], send: async (_to, m) => { sent.push(m); return { status: "sent" }; } },
      memory: fakeMemory(), router: fakeRouter([{ ...NEEDS_TOOL, needsTool: false }]), model, clock: systemClock, tracer: createInMemoryTracer(),
    });
    await agent.handle(msg("m1", "where is Golden Terra?"));
    expect(sent).toEqual([{ text: "Golden Terra is in Kothur." }]);
  });

  test.each([
    ["no object at all", "nope"],
    ["an invalid message", { message: { buttons: "x" }, formatRationale: 5 }],
  ])("nothing to salvage (%s) → the honest fallback", async (_label, structured) => {
    const sent: { text?: string }[] = [];
    const model: Model = { generate: async () => ({ structured }) };
    const agent = createAgent({
      channel: { name: "test", receive: () => [], send: async (_to, m) => { sent.push(m); return { status: "sent" }; } },
      memory: fakeMemory(), router: fakeRouter([{ ...NEEDS_TOOL, needsTool: false }]), model, clock: systemClock, tracer: createInMemoryTracer(),
    });
    await agent.handle(msg("m1", "hi"));
    expect(sent[0]?.text).toMatch(/trouble/);
  });

  test("usable extras are kept: string state and summary, facts as an array are dropped", async () => {
    const model: Model = { generate: async () => ({ structured: { message: { text: "ok" }, sessionFacts: ["a"], sessionCurrentState: "choosing", sessionSummary: "asked", formatRationale: "y".repeat(301) } }) };
    const sent: unknown[] = [];
    const agent = createAgent({
      channel: { name: "test", receive: () => [], send: async (_to, m) => { sent.push(m); return { status: "sent" }; } },
      memory: fakeMemory(), router: fakeRouter([{ ...NEEDS_TOOL, needsTool: false }]), model, clock: systemClock, tracer: createInMemoryTracer(),
    });
    await agent.handle(msg("m1", "hi"));
    expect(sent).toEqual([{ text: "ok" }]);
  });
});
