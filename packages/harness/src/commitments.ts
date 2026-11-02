import { createClient, type Client } from "@libsql/client";
import type { CommitmentStore } from "@wappy_ai/core";

export type LibsqlCommitmentStoreOptions =
  | {
      /** `:memory:`, a local `file:...` path, or a remote `libsql://...`/`https://...` URL. */
      url: string;
      authToken?: string;
    }
  | { client: Client };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  contactId TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commitments_contact ON commitments(contactId, at);
`;

/** M27: LibSQL-backed `CommitmentStore`. Append-only: a promise made stays made. */
export function createLibsqlCommitmentStore(opts: LibsqlCommitmentStoreOptions): CommitmentStore {
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
    async log(c) {
      await ensureSchema();
      await client.execute({ sql: "INSERT INTO commitments (id, contactId, kind, text, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING", args: [c.id, c.contactId, c.kind, c.text, c.at] });
    },

    async list(contactId) {
      await ensureSchema();
      const result = await client.execute({ sql: "SELECT id, contactId, kind, text, at FROM commitments WHERE contactId = ? ORDER BY at ASC, rowid ASC", args: [contactId] });
      return result.rows.map((r) => ({ id: r.id as string, contactId: r.contactId as string, kind: r.kind as string, text: r.text as string, at: r.at as number }));
    },
  };
}
