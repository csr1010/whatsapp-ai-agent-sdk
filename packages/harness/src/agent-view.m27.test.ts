import { describe, expect, test } from "vitest";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy_ai/testkit";
import { createInMemoryTracer } from "@wappy_ai/core";
import type { Clock, Commitment, CommitmentStore, InboundMessage, Model, ModelRequest, RouterDecision, SessionProfile, SessionProfileStore, Task, TaskStore, Tool } from "@wappy_ai/core";
import { createAgent, type AgentDeps } from "./agent.js";
import { createToolInvoker } from "./invoke-tools.js";

const msg = (id = "m1"): InboundMessage => ({ id, contactId: "c1", channel: "whatsapp", text: "hi", timestamp: 0 });
const said: RouterDecision = { intent: "x", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 };
const clock = (now = 1000): Clock => ({ now: () => now, setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {}, sleep: async () => {} });
const tool = (name: string, readOnly = true): Tool => ({ name, description: name, parameters: { type: "object" }, readOnly, confirmBefore: false, execute: async () => ({ toolName: name, ok: true, data: {} }) as never });
const tasks = (): TaskStore & { saved: Task[][] } => {
  const held = new Map<string, Task[]>(), saved: Task[][] = [];
  return { saved, list: async (c) => held.get(c) ?? [], save: async (c, t) => { held.set(c, t); saved.push(t); } };
};
const promises = (): CommitmentStore & { all: Commitment[] } => { const all: Commitment[] = []; return { all, log: async (c) => { all.push(c); }, list: async () => all }; };

function agent(more: Partial<AgentDeps>, decision: RouterDecision = said, sent = true) {
  const seen: ModelRequest[] = [];
  const model: Model = { generate: async (r) => { seen.push(r); return { structured: { formatRationale: "r", message: { text: "hello" } } }; } };
  const base = fakeChannel("whatsapp");
  const channel = sent ? base : { ...base, send: async () => ({ status: "failed" as const, reason: "down" }) };
  return { seen, run: createAgent({ channel, memory: fakeMemory(), router: { route: async () => decision }, model, clock: clock(), tracer: createInMemoryTracer(), ...more }) };
}

describe("M27: the view for this message", () => {
  test("nothing set: the prompt is what it always was", async () => {
    const a = agent({ instructions: "be kind" }), b = agent({ instructions: "be kind", taskStore: tasks(), commitmentStore: promises() });
    await a.run.handle(msg()); await b.run.handle(msg());
    expect(b.seen[0]!.system).toBe(a.seen[0]!.system);
    expect(b.seen[0]!.prompt).toBe(a.seen[0]!.prompt);
  });

  test("the view replaces the instructions and adds its notes", async () => {
    const a = agent({ instructions: "everything", viewFor: () => ({ instructions: "just this job", notes: ["They're midway through an order."] }) });
    await a.run.handle(msg());
    expect(a.seen[0]!.system).toContain("just this job");
    expect(a.seen[0]!.system).not.toContain("everything");
    expect(`${a.seen[0]!.system}${a.seen[0]!.prompt}`).toContain("midway through an order");
  });

  test("only the view's tools can be reached", async () => {
    let allowed: string[] | undefined;
    const a = agent({ tools: [tool("find"), tool("send", false)], invokeTools: async (i) => { allowed = i.allowedTools; return []; }, viewFor: () => ({ tools: ["find"] }) }, { ...said, needsTool: true });
    await a.run.handle(msg());
    expect(allowed).toEqual(["find"]);
    expect(JSON.stringify(a.seen[0])).not.toContain('"send"');
  });

  test("the invoker never offers a tool the view left out", async () => {
    const asked: string[] = [];
    const invoke = createToolInvoker({ tools: [tool("find"), tool("send", false)], model: { generate: async (r) => { asked.push(r.prompt); return { structured: {} }; } } });
    await invoke({ message: { ...msg(), text: "find send" }, decision: said, allowedTools: ["find"] });
    expect(asked[0]).toContain("- find:");
    expect(asked[0]).not.toContain("- send:");
  });

  test("a view that fails doesn't cost the reply, and only harmless tools stay reachable", async () => {
    let allowed: string[] | undefined;
    const a = agent({ tools: [tool("find"), tool("send", false)], invokeTools: async (i) => { allowed = i.allowedTools; return []; }, viewFor: () => { throw new Error("no"); } }, { ...said, needsTool: true });
    expect((await a.run.handle(msg())).status).toBe("sent");
    expect(allowed).toEqual(["find"]);
  });

  test("the router can see what the contact is in the middle of", async () => {
    const store = tasks(), held: Task = { id: "t", name: "order", state: {}, status: "active", startedAt: 0, updatedAt: 0, expiresAt: 9e9 };
    await store.save("c1", [held]);
    let seen: Task[] | undefined;
    const a = agent({ taskStore: store, router: { route: async (i) => { seen = i.tasks; return said; } } });
    await a.run.handle(msg());
    expect(seen).toEqual([held]);
  });

  test("the view can hide what this job shouldn't read", async () => {
    const profiles: SessionProfileStore = { get: async () => ({ contactId: "c1", facts: { name: "Jane", budget: "low" }, expiresAt: 9e9 }), set: async () => {} };
    const a = agent({ sessionProfileStore: profiles, viewFor: () => ({ hideMemory: ["budget"] }) });
    await a.run.handle(msg());
    const text = `${a.seen[0]!.system}${a.seen[0]!.prompt}`;
    expect(text).toContain("Jane");
    expect(text).not.toContain("low");
  });
});

describe("M27: tasks and promises", () => {
  test("the view's move is saved once the reply is out", async () => {
    const store = tasks();
    const a = agent({ taskStore: store, viewFor: () => ({ move: { op: "start", name: "order" } }) });
    await a.run.handle(msg());
    expect(store.saved[0]!.map((t) => t.name)).toEqual(["order"]);
  });

  test("a failed send saves nothing, so a retry can't apply the move twice", async () => {
    const store = tasks();
    const a = agent({ taskStore: store, viewFor: () => ({ move: { op: "start", name: "order" } }) }, said, false);
    await a.run.handle(msg());
    expect(store.saved).toEqual([]);
  });

  test("no move, no write", async () => {
    const store = tasks();
    await agent({ taskStore: store }).run.handle(msg());
    expect(store.saved).toEqual([]);
  });

  test("the task store being down costs the place, not the reply", async () => {
    const down: TaskStore = { list: async () => { throw new Error("down"); }, save: async () => { throw new Error("down"); } };
    const a = agent({ taskStore: down, viewFor: () => ({ move: { op: "start", name: "order" } }) });
    expect((await a.run.handle(msg())).status).toBe("sent");
  });

  test("the review can change the reply, log a promise and end a task", async () => {
    const store = tasks(), log = promises();
    await store.save("c1", [{ id: "t", name: "order", state: {}, status: "active", startedAt: 0, updatedAt: 0, expiresAt: 9e9 }]);
    store.saved.length = 0;
    const channel = fakeChannel("whatsapp");
    const a = agent({ channel, taskStore: store, commitmentStore: log, reviewReply: () => ({ reply: { text: "checked" }, commitments: [{ kind: "quote", text: "₹100" }], move: { op: "finish" } }) });
    await a.run.handle(msg("m9"));
    expect(JSON.stringify(channel)).toContain("checked");
    expect(log.all).toEqual([{ id: "m9:c0", contactId: "c1", kind: "quote", text: "₹100", at: 1000 }]);
    expect(store.saved[0]).toEqual([]);
  });

  test("the store's lifetime setting reaches the task, and a stored task reaches the view", async () => {
    const store = tasks(), seen: Task[][] = [];
    const a = agent({ taskStore: store, taskTtlMs: 50, viewFor: (i) => { seen.push(i.tasks); return { move: { op: "start", name: "order" } }; } });
    await a.run.handle(msg());
    expect(store.saved[0]![0]!.expiresAt).toBe(1050);
    expect(seen[0]).toEqual([]);
  });

  test("a confirmed tap and a review with nothing to say write nothing", async () => {
    const store = tasks(), log = promises();
    await agent({ taskStore: store, commitmentStore: log, reviewReply: () => undefined }).run.handle(msg());
    expect(store.saved).toEqual([]);
    expect(log.all).toEqual([]);
  });

  test("a review that fails still sends the reply", async () => {
    const a = agent({ reviewReply: () => { throw new Error("no"); } });
    expect((await a.run.handle(msg())).status).toBe("sent");
  });
});

describe("M27: what the review of the first version found", () => {
  const held = (name: string, status: Task["status"] = "active"): Task => ({ id: name, name, state: {}, status, startedAt: 0, updatedAt: 0, expiresAt: 9e9 });

  test("a store that can't be read isn't taken to be empty, so its tasks aren't overwritten", async () => {
    let saved = 0;
    const flaky: TaskStore = { list: async () => { throw new Error("down"); }, save: async () => { saved++; } };
    await agent({ taskStore: flaky, viewFor: () => ({ move: { op: "start", name: "order" } }) }).run.handle(msg());
    expect(saved).toBe(0);
  });

  test("what ended during the message is settled inside it, whichever path it took", async () => {
    const store = tasks();
    await store.save("c1", [held("order"), held("other", "paused")]);
    store.saved.length = 0;
    await agent({ taskStore: store, movesAfter: () => [{ op: "finish", name: "order" }] }).run.handle(msg());
    expect(store.saved[0]!.map((t) => [t.name, t.status])).toEqual([["other", "active"]]);
  });

  test("a host can hold one task at a time", async () => {
    const store = tasks();
    await store.save("c1", [held("order")]);
    await agent({ taskStore: store, mostTasks: 1, viewFor: () => ({ move: { op: "start", name: "other" } }) }).run.handle(msg());
    expect(store.saved.at(-1)!.map((t) => t.name)).toEqual(["other"]);
  });

  test("a fact hidden by name is hidden however the model worded it", async () => {
    const profiles: SessionProfileStore = { get: async () => ({ contactId: "c1", facts: { Budget_Range: "low", name: "Jane" }, expiresAt: 9e9 }), set: async () => {} };
    const a = agent({ sessionProfileStore: profiles, viewFor: () => ({ hideMemory: ["budget"] }) });
    await a.run.handle(msg());
    expect(`${a.seen[0]!.system}${a.seen[0]!.prompt}`).not.toContain("low");
  });

  test("saying a fact again doesn't make it younger; changing it does", async () => {
    let last: SessionProfile = { contactId: "c1", facts: { size: "L", day: "Sat" }, factsAt: { size: 1, day: 1 }, expiresAt: 9e9 };
    const s: SessionProfileStore = { get: async () => last, set: async (p) => { last = p; } };
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", sessionFacts: { size: "L", day: "Sun" }, message: { text: "hi" } } }) };
    await createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([said]), model, clock: clock(), tracer: createInMemoryTracer(), sessionProfileStore: s, factLifetimeMs: () => 1e9 }).handle(msg());
    expect(last.factsAt).toEqual({ size: 1, day: 1000 });
  });
});

describe("M27: what a person is told about an action", () => {
  const said = { intent: "x", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 };
  const held = { id: "p1", contactId: "c1", toolName: "send", args: { a: 1 }, summary: "send with arguments {}", createdAt: 0, expiresAt: 9e9 };
  const flow = () => ({ request: async () => held, getPending: async () => held, resolve: async () => held }) as never;
  const tap = (selectionId: string) => ({ ...msg(), selectionId });
  const sends = (describe?: Tool["describe"]) => [{ ...tool("send", false), ...(describe ? { describe } : {}) }];

  test("a tool can say it in words, whatever happens", async () => {
    const words = () => ({ doing: "your request", done: "That's gone to the team.", cancelled: "Fine, nothing was sent." });
    const channel = fakeChannel("whatsapp");
    await agent({ channel, confirmFlow: flow(), tools: sends(words) }, said).run.handle(tap("confirm:p1"));
    expect(JSON.stringify(channel)).toContain("That's gone to the team.");
    const other = fakeChannel("whatsapp");
    await agent({ channel: other, confirmFlow: flow(), tools: sends(words) }, said).run.handle(tap("cancel:p1"));
    expect(JSON.stringify(other)).toContain("Fine, nothing was sent.");
  });

  test("the words a person is asked to confirm come from the tool", async () => {
    let summary = "";
    const invoke = createToolInvoker({ tools: [{ ...tool("send", false), confirmBefore: true, describe: () => ({ doing: "your request", done: "", cancelled: "" }) }], confirmFlow: { request: async (r: { summary: string }) => { summary = r.summary; return held; } } as never, model: { generate: async () => ({ structured: { toolName: "send", args: {} } }) } });
    await invoke({ message: { ...msg(), text: "send" }, decision: said });
    expect(summary).toBe("your request");
  });
});

describe("M27: each fact has its own lifetime", () => {
  const stored = (): SessionProfileStore & { last?: SessionProfile } => {
    const s: SessionProfileStore & { last?: SessionProfile } = { get: async () => s.last, set: async (p) => { s.last = p; } };
    return s;
  };
  const life = (name: string) => (name === "quick" ? 100 : undefined);

  test("a fact past its lifetime is gone, the rest stay", async () => {
    const s = stored();
    s.last = { contactId: "c1", facts: { quick: "a", lasting: "b" }, factsAt: { quick: 500, lasting: 500 }, expiresAt: 9e9 };
    const a = agent({ sessionProfileStore: s, factLifetimeMs: life });
    await a.run.handle(msg());
    const text = `${a.seen[0]!.system}${a.seen[0]!.prompt}`;
    expect(text).toContain("lasting: b");
    expect(text).not.toContain("quick: a");
    expect(s.last!.facts).toEqual({ lasting: "b" });
  });

  test("a new fact is stamped when it's learned", async () => {
    const s = stored();
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", sessionFacts: { name: "Jane" }, message: { text: "hi" } } }) };
    await createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([said]), model, clock: clock(), tracer: createInMemoryTracer(), sessionProfileStore: s, factLifetimeMs: life }).handle(msg());
    expect(s.last!.factsAt).toEqual({ name: 1000 });
  });
});
