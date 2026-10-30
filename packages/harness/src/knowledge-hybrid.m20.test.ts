import { createClient } from "@libsql/client";
import { describe, expect, test } from "vitest";
import { createKnowledge } from "./knowledge.js";
import { reciprocalRankFusion } from "./rank-fusion.js";

const memClient = () => createClient({ url: ":memory:" });

// Vectors chosen so meaning and wording disagree: the paraphrase shares no word with its match,
// and the code has no vector neighbour worth the name.
const vectors: Record<string, number[]> = {
  "Walk-ins are welcome before 11am": [1, 0, 0],
  "Our licence number is KA-1123": [0, 1, 0],
  "Parking is behind the building": [0, 0, 1],
  "can I come without booking": [1, 0, 0],
  "KA-1123": [0.1, 0.1, 1],
  "walk-ins before 11am": [1, 0, 0],
  "before the building": [-1, -1, -1], // unlike everything: only keywords match it
};
const embed = async (texts: string[]) => texts.map((t) => vectors[t] ?? [0, 0, 0]);

async function store(extra: { embedDimensions?: number } = {}) {
  const k = createKnowledge({ client: memClient(), embed, hybrid: true, ...extra });
  await k.ingest("a", "Walk-ins are welcome before 11am");
  await k.ingest("b", "Our licence number is KA-1123");
  await k.ingest("c", "Parking is behind the building");
  return k;
}

describe("reciprocalRankFusion", () => {
  test("something both rankings like beats something only one ranks first", () => {
    const fused = reciprocalRankFusion([["x", "both"], ["y", "both"]]);
    expect(fused[0]?.id).toBe("both");
  });

  test("an id in one ranking only still comes back", () => {
    expect(reciprocalRankFusion([["x"], []]).map((f) => f.id)).toEqual(["x"]);
  });
});

for (const mode of [{ name: "stored in rows", opts: {} }, { name: "native vectors", opts: { embedDimensions: 3 } }]) {
  describe(`createKnowledge hybrid (${mode.name})`, () => {
    test("a paraphrase with no shared word is found through its meaning", async () => {
      const k = await store(mode.opts);
      expect((await k.recall("can I come without booking", { topK: 1 }))[0]?.sourceId).toBe("a");
    });

    test("an exact code is found through its words", async () => {
      const k = await store(mode.opts);
      expect((await k.recall("KA-1123", { topK: 1 }))[0]?.sourceId).toBe("b");
    });

    test("a chunk both rankers agree on ranks first", async () => {
      const k = await store(mode.opts);
      expect((await k.recall("walk-ins before 11am"))[0]?.sourceId).toBe("a");
    });

    test("topK is kept, nothing unrelated pads the result, and an empty store returns nothing", async () => {
      const k = await store(mode.opts);
      expect(await k.recall("before the building", { topK: 1 })).toHaveLength(1);
      expect(await k.recall("before the building", { topK: 5 })).toHaveLength(2);
      expect(await createKnowledge({ client: memClient(), embed, hybrid: true, ...mode.opts }).recall("anything")).toEqual([]);
    });
  });
}

test("hybrid without an embedder is refused — it would quietly be keywords only", () => {
  expect(() => createKnowledge({ client: memClient(), hybrid: true })).toThrow(/embed/);
});
