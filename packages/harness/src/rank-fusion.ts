/** The usual constant for reciprocal rank fusion: large enough that a first place doesn't drown
 * out agreement between rankings. */
const RRF_K = 60;

export interface FusedRank {
  id: string;
  score: number;
}

/**
 * Merges rankings by position, not score: BM25 and cosine scores live on different scales and can't
 * be added, but "ranked 2nd here and 3rd there" can. Each ranking lists ids best first.
 */
export function reciprocalRankFusion(rankings: string[][], k = RRF_K): FusedRank[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
