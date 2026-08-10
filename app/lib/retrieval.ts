export interface KnowledgeCandidate {
  id: string;
  canonicalKey: string;
  kind: "issue" | "decision" | "runbook" | "conversation" | "person" | "project" | "note";
  title: string;
  content: string;
  sourceUri?: string;
  updatedAt?: string;
}

export interface RankedEvidence extends KnowledgeCandidate {
  retrievalScore: number;
  matchedTerms: string[];
}

const stopWords = new Set([
  "a", "al", "algo", "and", "como", "con", "de", "del", "el", "en", "es", "esta", "for",
  "from", "la", "las", "lo", "los", "of", "or", "para", "por", "que", "se", "the", "to", "un",
  "una", "y",
]);

export function extractTerms(value: string) {
  return Array.from(new Set(value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []))
    .filter((token) => !stopWords.has(token));
}

const kindBoost: Record<KnowledgeCandidate["kind"], number> = {
  runbook: 5,
  decision: 4,
  issue: 4,
  conversation: 2,
  project: 1,
  person: 0,
  note: 2,
};

export function retrieveEvidence(query: string, candidates: KnowledgeCandidate[], limit = 6): RankedEvidence[] {
  const queryTerms = extractTerms(query).slice(0, 60);
  if (!queryTerms.length) return [];

  return candidates
    .map((candidate) => {
      const titleTerms = new Set(extractTerms(candidate.title));
      const bodyTerms = new Set(extractTerms(candidate.content));
      const keyTerms = new Set(extractTerms(candidate.canonicalKey));
      const matchedTerms = queryTerms.filter((term) => titleTerms.has(term) || bodyTerms.has(term) || keyTerms.has(term));
      const titleMatches = matchedTerms.filter((term) => titleTerms.has(term)).length;
      const keyMatches = matchedTerms.filter((term) => keyTerms.has(term)).length;
      const bodyMatches = matchedTerms.filter((term) => bodyTerms.has(term)).length;
      const retrievalScore = titleMatches * 6 + keyMatches * 4 + bodyMatches * 2 + kindBoost[candidate.kind];
      return { ...candidate, retrievalScore, matchedTerms };
    })
    .filter((candidate) => candidate.matchedTerms.length > 0)
    .sort((a, b) => b.retrievalScore - a.retrievalScore || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, Math.min(limit, 12)));
}
