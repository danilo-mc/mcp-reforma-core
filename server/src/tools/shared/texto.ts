/** Simple Portuguese text search helpers (no LLM): normalization, stopwords and term-overlap ranking. */

export const STOPWORDS_PT: ReadonlySet<string> = new Set(
  (
    "a o e as os um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas para pra " +
    "com sem sob sobre entre ate apos ao aos à às que se sua seu suas seus ou nao mais menos como " +
    "quando onde qual quais quem cujo esta este estas estes essa esse essas esses isto isso aquilo " +
    "tal outro outra outros outras demais exceto inclusive etc ser sao foi ter tem art inciso lc " +
    "servico servicos produto produtos operacao operacoes venda vendas fornecimento"
  ).split(/\s+/),
);

/** lowercase, strip accents, keep only letters/digits as separators. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Light stemming: drop common plural endings so "bebidas" matches "bebida". */
export function stem(token: string): string {
  if (token.length > 5 && token.endsWith("oes")) return `${token.slice(0, -3)}ao`;
  if (token.length > 5 && token.endsWith("ais")) return `${token.slice(0, -3)}al`;
  if (token.length > 4 && token.endsWith("es") && /[rzs]es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/** Normalized, de-duplicated search terms (stopwords and 1-letter tokens removed). */
export function tokenize(s: string): string[] {
  const out = new Set<string>();
  for (const t of normalizeText(s).split(" ")) {
    if (t.length < 2 || STOPWORDS_PT.has(t)) continue;
    out.add(stem(t));
  }
  return [...out];
}

export interface WeightedField {
  text: string;
  weight: number;
}

export interface TermScore {
  score: number;
  /** Query terms found in the document. */
  termos: string[];
}

/**
 * Term-overlap score: for each query term, the best weight among fields that contain it
 * (exact token = weight; prefix match of ≥ 4 chars = weight / 2).
 */
export function scoreDocument(queryTerms: string[], fields: WeightedField[]): TermScore {
  const tokenized = fields.map((f) => ({ tokens: tokenize(f.text), weight: f.weight }));
  let score = 0;
  const termos: string[] = [];
  for (const q of queryTerms) {
    let best = 0;
    for (const f of tokenized) {
      for (const t of f.tokens) {
        if (t === q) best = Math.max(best, f.weight);
        else if (q.length >= 4 && t.length >= 4 && (t.startsWith(q) || q.startsWith(t)))
          best = Math.max(best, f.weight / 2);
      }
    }
    if (best > 0) {
      score += best;
      termos.push(q);
    }
  }
  return { score, termos };
}
