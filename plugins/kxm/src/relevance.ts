import type { ContextItem } from "./context.ts";

/**
 * Deterministic lexical relevance (BM25) for context ranking and recall.
 *
 * No model, no clock, no randomness: the same query and documents always
 * produce bit-identical scores, so arbiter packets and recall results stay
 * reproducible and testable.
 */

/** Words that carry no task signal. Dropped before scoring. */
export const RELEVANCE_STOPWORDS: ReadonlySet<string> = Object.freeze(new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "how", "if", "in",
  "into", "is", "it", "its", "of", "on", "or", "our", "should", "so", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "those", "to", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "why", "will", "with", "would", "you", "your",
]));

/** BM25 term-frequency saturation. */
export const RELEVANCE_K1 = 1.2;
/** BM25 document-length normalization. */
export const RELEVANCE_B = 0.75;

const MIN_TOKEN_CHARS = 2;
const MAX_TOKEN_CHARS = 64;

function foldPlural(token: string): string {
  if (/^\p{N}+$/u.test(token)) return token;
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("sses")) return token.slice(0, -2);
  if (
    token.length > 3
    && token.endsWith("s")
    && !token.endsWith("ss")
    && !token.endsWith("us")
    && !token.endsWith("is")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

/** NFKC-normalized, lowercased, stopword-free, plural-folded tokens in text
 * order, duplicates kept. */
export function relevanceTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_TOKEN_CHARS || raw.length > MAX_TOKEN_CHARS) continue;
    if (RELEVANCE_STOPWORDS.has(raw)) continue;
    tokens.push(foldPlural(raw));
  }
  return tokens;
}

/** Index-aligned BM25 scores of each document against the query. Terms are
 * summed in first-occurrence query order so the float result is bit-stable. */
export function scoreRelevance(query: string, documents: readonly string[]): number[] {
  const scores = documents.map(() => 0);
  const terms = [...new Set(relevanceTokens(query))];
  if (terms.length === 0 || documents.length === 0) return scores;

  const indexed = documents.map((document) => {
    const tokens = relevanceTokens(document);
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    return { length: tokens.length, frequencies };
  });
  const count = indexed.length;
  let totalLength = 0;
  for (const document of indexed) totalLength += document.length;
  const averageLength = totalLength > 0 ? totalLength / count : 1;

  const inverseFrequency = new Map<string, number>();
  for (const term of terms) {
    let documentFrequency = 0;
    for (const document of indexed) {
      if (document.frequencies.has(term)) documentFrequency += 1;
    }
    inverseFrequency.set(term, Math.log(1 + (count - documentFrequency + 0.5) / (documentFrequency + 0.5)));
  }

  indexed.forEach((document, index) => {
    let score = 0;
    for (const term of terms) {
      const frequency = document.frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const lengthNorm = 1 - RELEVANCE_B + RELEVANCE_B * (document.length / averageLength);
      score += inverseFrequency.get(term)! * ((frequency * (RELEVANCE_K1 + 1)) / (frequency + RELEVANCE_K1 * lengthNorm));
    }
    scores[index] = score;
  });
  return scores;
}

/** Relevance rounded to three decimals for audits and responses. */
export function roundRelevance(score: number): number {
  return Math.round(score * 1000) / 1000;
}

/** The text a context item is ranked on: its summary plus its state key.
 * Kind, id and sourceRef are excluded. */
export function contextItemRelevanceText(item: ContextItem): string {
  return item.stateKey !== undefined ? `${item.summary} ${item.stateKey}` : item.summary;
}

/** Locale-independent code-unit order for identifiers. */
export function compareCodeUnitIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface RankedRecallItem {
  item: ContextItem;
  relevance: number;
}

/** Rank recall candidates: exact-phrase hits first, then BM25 any-token hits,
 * then id. An empty query is a phrase hit for every item (id order). Items
 * that neither contain the phrase nor share a token are dropped. */
export function rankRecall(query: string, items: readonly ContextItem[], limit: number): RankedRecallItem[] {
  const needle = query.toLowerCase();
  const scores = scoreRelevance(query, items.map(contextItemRelevanceText));
  const ranked: { item: ContextItem; score: number; phraseHit: boolean }[] = [];
  items.forEach((item, index) => {
    const score = scores[index] ?? 0;
    const phraseHit = needle === ""
      || item.summary.toLowerCase().includes(needle)
      || (item.stateKey ?? "").toLowerCase().includes(needle);
    if (phraseHit || score > 0) ranked.push({ item, score, phraseHit });
  });
  ranked.sort((left, right) =>
    (right.phraseHit ? 1 : 0) - (left.phraseHit ? 1 : 0)
    || right.score - left.score
    || compareCodeUnitIds(left.item.id, right.item.id),
  );
  return ranked.slice(0, limit).map(({ item, score }) => ({ item, relevance: roundRelevance(score) }));
}
