import { createClient, type Client } from "@libsql/client";
import { describe, expect, test } from "vitest";
import { createLibsqlCommitmentStore } from "./commitments.js";
import { createLibsqlSessionProfileStore } from "./session-profile.js";
import { createLibsqlTaskStore, moveTasks } from "./task-store.js";

const ttl = { ttlMs: 1000 };

describe("M27: what someone's in the middle of", () => {
  test("a new task pauses the current one, and finishing it brings the old one back", () => {
    let t = moveTasks([], { op: "start", name: "order", state: { size: "L" } }, 1, ttl);
    t = moveTasks(t, { op: "start", name: "complaint" }, 2, ttl);
    expect(t.map((x) => [x.name, x.status])).toEqual([["complaint", "active"], ["order", "paused"]]);
    t = moveTasks(t, { op: "finish" }, 3, ttl);
    expect(t.map((x) => [x.name, x.status])).toEqual([["order", "active"]]);
    expect(t[0]!.state).toEqual({ size: "L" });
  });

  test("starting what's already under way carries on, it doesn't start twice", () => {
    let t = moveTasks([], { op: "start", name: "order", state: { size: "L" } }, 1, ttl);
    t = moveTasks(t, { op: "start", name: "order", state: { day: "Sat" } }, 2, ttl);
    expect(t).toHaveLength(1);
    expect(t[0]!.state).toEqual({ size: "L", day: "Sat" });
  });

  test("a paused task can be picked up out of order: real chats jump around", () => {
    let t = moveTasks([], { op: "start", name: "a" }, 1, ttl);
    t = moveTasks(t, { op: "start", name: "b" }, 2, ttl);
    t = moveTasks(t, { op: "start", name: "c" }, 3, ttl);
    t = moveTasks(t, { op: "resume", name: "a" }, 4, ttl);
    expect(t.map((x) => [x.name, x.status])).toEqual([["a", "active"], ["c", "paused"], ["b", "paused"]]);
  });

  test("a move with nothing to act on changes nothing", () => {
    const t = moveTasks([], { op: "start", name: "a" }, 1, ttl);
    expect(moveTasks(t, { op: "resume", name: "nope" }, 2, ttl)).toEqual(t);
    expect(moveTasks([], { op: "finish" }, 2, ttl)).toEqual([]);
    expect(moveTasks([], { op: "update", state: { a: "b" } }, 2, ttl)).toEqual([]);
  });

  test("a task can be finished by name, wherever it sits", () => {
    let t = moveTasks([], { op: "start", name: "a" }, 1, ttl);
    t = moveTasks(t, { op: "start", name: "b" }, 2, ttl);
    expect(moveTasks(t, { op: "finish", name: "a" }, 3, ttl).map((x) => [x.name, x.status])).toEqual([["b", "active"]]);
    expect(moveTasks(t, { op: "finish", name: "b" }, 3, ttl).map((x) => [x.name, x.status])).toEqual([["a", "active"]]);
    expect(moveTasks(t, { op: "finish", name: "nope" }, 3, ttl)).toEqual(t);
  });

  test("the pile can't grow without end", () => {
    let t = moveTasks([], { op: "start", name: "t0" }, 0, ttl);
    for (let i = 1; i < 20; i++) t = moveTasks(t, { op: "start", name: `t${i}` }, i, { ...ttl, most: 5 });
    expect(t).toHaveLength(5);
    expect(t[0]!.name).toBe("t19");
  });

  test("tasks survive a restart, and stale ones are gone", async () => {
    const url = "file:/tmp/wappy-m27-" + Date.now() + ".db";
    const a = createLibsqlTaskStore({ url });
    await a.save("c1", moveTasks([], { op: "start", name: "order" }, 1, ttl));
    const b = createLibsqlTaskStore({ url });
    expect((await b.list("c1", 2)).map((x) => x.name)).toEqual(["order"]);
    expect(await b.list("c1", 5000)).toEqual([]);
    expect(await b.list("nobody", 2)).toEqual([]);
  });
});

describe("M27: what we've promised", () => {
  test("a promise is logged once, read back, and kept per person", async () => {
    const s = createLibsqlCommitmentStore({ url: ":memory:" });
    const c = { id: "m1:c0", contactId: "c1", kind: "quote", text: "₹100 for the small one", at: 5 };
    await s.log(c); await s.log(c);
    await s.log({ ...c, id: "m2:c0", contactId: "c2" });
    expect(await s.list("c1")).toEqual([c]);
  });
});

describe("M27: the odd paths", () => {
  test("an update adds to what the current task has gathered, and a mode stays with it", () => {
    let t = moveTasks([], { op: "start", name: "order", mode: "orders" }, 1, ttl);
    t = moveTasks(t, { op: "update", state: { day: "Sat" } }, 2, ttl);
    expect(t[0]).toMatchObject({ mode: "orders", state: { day: "Sat" }, updatedAt: 2, expiresAt: 1002 });
  });

  test("a task lasts a week unless told otherwise", () => {
    expect(moveTasks([], { op: "start", name: "a" }, 0)[0]!.expiresAt).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("finishing the only task leaves none", () => {
    expect(moveTasks(moveTasks([], { op: "start", name: "a" }, 1, ttl), { op: "finish" }, 2, ttl)).toEqual([]);
  });

  test("a store can share a client, and retries after the database was briefly away", async () => {
    let fails = 1;
    const real = createClient({ url: ":memory:" });
    const flaky = new Proxy(real, { get: (c, k: keyof Client) => k === "executeMultiple" ? async (sql: string) => { if (fails-- > 0) throw new Error("away"); return c.executeMultiple(sql); } : typeof c[k] === "function" ? (c[k] as (...a: unknown[]) => unknown).bind(c) : c[k] });
    const tasks = createLibsqlTaskStore({ client: flaky });
    await expect(tasks.list("c1", 1)).rejects.toThrow("away");
    expect(await tasks.list("c1", 1)).toEqual([]);
    fails = 1;
    const promises = createLibsqlCommitmentStore({ client: flaky });
    await expect(promises.list("c1")).rejects.toThrow("away");
    expect(await promises.list("c1")).toEqual([]);
  });
});

describe("M27: fact stamps in the profile store", () => {
  test("stamps are saved, and a file from before them still works", async () => {
    const url = "file:/tmp/wappy-m27-old-" + Date.now() + ".db";
    const old = createClient({ url });
    await old.executeMultiple("CREATE TABLE session_profiles (contactId TEXT PRIMARY KEY, facts TEXT NOT NULL, currentState TEXT, summary TEXT, expiresAt INTEGER NOT NULL);");
    await old.execute({ sql: "INSERT INTO session_profiles VALUES ('c0', '{}', NULL, NULL, 9000)", args: [] });
    const s = createLibsqlSessionProfileStore({ url });
    expect(await s.get("c0", 1)).toEqual({ contactId: "c0", facts: {}, expiresAt: 9000 });
    await s.set({ contactId: "c1", facts: { name: "J" }, factsAt: { name: 5 }, expiresAt: 9000 });
    expect((await s.get("c1", 1))!.factsAt).toEqual({ name: 5 });
    expect((await createLibsqlSessionProfileStore({ url }).get("c1", 1))!.factsAt).toEqual({ name: 5 });
  });
});
