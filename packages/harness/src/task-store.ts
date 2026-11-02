import { createClient, type Client } from "@libsql/client";
import type { Task, TaskMove, TaskStore } from "@wappy_ai/core";

export type LibsqlTaskStoreOptions =
  | {
      /** `:memory:`, a local `file:...` path, or a remote `libsql://...`/`https://...` URL. */
      url: string;
      authToken?: string;
    }
  | { client: Client };

/** A paused task nobody came back to shouldn't resurface next month. */
const DEFAULT_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Few people juggle more than this in one chat; past it the oldest goes rather than growing without end. */
const DEFAULT_MOST_TASKS = 5;

export interface MoveOptions {
  ttlMs?: number;
  most?: number;
}

/**
 * M27: what a move does to a contact's tasks, newest first. Pure, so a retried message can recompute
 * it from what was saved. A list rather than a strict stack: `resume` can take any paused task,
 * because real chats jump around. A move with nothing to act on changes nothing.
 */
export function moveTasks(tasks: Task[], move: TaskMove, now: number, o: MoveOptions = {}): Task[] {
  const expiresAt = now + (o.ttlMs ?? DEFAULT_TASK_TTL_MS);
  const touched = (t: Task, state?: Record<string, string>): Task => ({ ...t, state: { ...t.state, ...state }, status: "active", updatedAt: now, expiresAt });
  const paused = (ts: Task[]): Task[] => ts.map((t) => ({ ...t, status: "paused" }));
  const toFront = (name: string, state?: Record<string, string>) => {
    const t = tasks.find((x) => x.name === name);
    return t ? [touched(t, state), ...paused(tasks.filter((x) => x !== t))] : undefined;
  };

  switch (move.op) {
    case "start": {
      const next = toFront(move.name, move.state) ?? [{ id: `${move.name}-${now}`, name: move.name, ...(move.mode ? { mode: move.mode } : {}), state: move.state ?? {}, status: "active" as const, startedAt: now, updatedAt: now, expiresAt }, ...paused(tasks)];
      return next.slice(0, o.most ?? DEFAULT_MOST_TASKS);
    }
    case "update": {
      const [first, ...rest] = tasks;
      return first ? [touched(first, move.state), ...rest] : tasks;
    }
    case "resume":
      return toFront(move.name) ?? tasks;
    case "finish": {
      const done = move.name ? tasks.find((t) => t.name === move.name) : tasks[0];
      if (!done) return tasks;
      const rest = tasks.filter((t) => t !== done);
      if (done !== tasks[0]) return rest;
      const [next, ...others] = rest;
      return next ? [touched(next), ...others] : [];
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  contactId TEXT PRIMARY KEY,
  tasks TEXT NOT NULL
);
`;

/** M27: LibSQL-backed `TaskStore`, one row per contact: the agent is the only writer, one message at a time. */
export function createLibsqlTaskStore(opts: LibsqlTaskStoreOptions): TaskStore {
  const client: Client = "client" in opts ? opts.client : createClient({ url: opts.url, authToken: opts.authToken });
  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (!ready) {
      ready = client.executeMultiple(SCHEMA).catch((e: unknown) => {
        ready = undefined; // let the next call retry instead of permanently caching a transient failure
        throw e;
      });
    }
    return ready;
  };

  return {
    async list(contactId, now) {
      await ensureSchema();
      const result = await client.execute({ sql: "SELECT tasks FROM tasks WHERE contactId = ?", args: [contactId] });
      const row = result.rows[0];
      if (!row) return [];
      return (JSON.parse(row.tasks as string) as Task[]).filter((t) => now <= t.expiresAt);
    },

    async save(contactId, tasks) {
      await ensureSchema();
      await client.execute({ sql: "INSERT INTO tasks (contactId, tasks) VALUES (?, ?) ON CONFLICT(contactId) DO UPDATE SET tasks = excluded.tasks", args: [contactId, JSON.stringify(tasks)] });
    },
  };
}
