// Live knowledge-base search for the agent (playbook §1): the AI looks
// facts up instead of guessing. Keyword-overlap ranking over the
// campaign's knowledge text plus the agent's FAQs — small, fast and
// deterministic; it returns nothing rather than a weak match.

const STOP = new Set(
  "a an the is are was were be to of in on for and or with what how much does do can i you we our your it this that my me about there any".split(" ")
);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$+.\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function chunkKnowledge(knowledgeText: string, faqs: Array<{ question: string; answer: string }>): string[] {
  const paragraphs = knowledgeText
    .split(/\n\s*\n|\n(?=[-•*]\s)|\n(?=#+\s)/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return [...paragraphs, ...faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`)];
}

export function searchKnowledge(chunks: string[], query: string, limit = 3): string[] {
  const q = new Set(terms(query));
  if (q.size === 0) return [];
  return chunks
    .map((chunk) => {
      const t = terms(chunk);
      const hits = t.filter((w) => q.has(w)).length;
      return { chunk, score: hits / Math.sqrt(t.length + 1) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.chunk);
}
