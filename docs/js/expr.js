// Expressions de plusieurs mots autour du mot touché : verbes à particule (look into, give up),
// verbes prépositionnels (put up with), locutions (in spite of, make up one's mind).
// Fonctions pures, sans dictionnaire ni DOM : testables avec Node (expr.test.mjs).
//
// On part de chaque mot proche (jusqu'à 6 mots avant le mot touché) et de ses lemmes possibles
// (« looked » → look). Pour chaque expression du dictionnaire qui commence par ce lemme, on
// vérifie qu'elle se lit dans la phrase :
//   - mot à mot (look into → « looked into ») ;
//   - avec la particule séparée par un complément de 1 à 3 mots (« turned the offer down ») ;
//   - avec des variables : one's → my/her/their… ; oneself → myself/herself… ;
//     someone/something → 1 à 3 mots (« make someone laugh » → « made her laugh »).
// Une expression ne franchit pas une ponctuation (virgule, point…).

/** Particules qui peuvent être séparées du verbe par un complément (turn it down). */
export const SEPARABLE = new Set([
  "up", "down", "out", "off", "in", "on", "over", "away", "back", "around", "round", "through",
  "aside", "apart", "together", "forward", "along", "about", "across", "by", "behind",
]);
const POSSESSIVES = new Set(["my", "your", "his", "her", "its", "our", "their", "one's"]);
const REFLEXIVES = new Set(["myself", "yourself", "himself", "herself", "itself", "ourselves", "yourselves", "themselves", "oneself"]);
const POSSESSIVE_SLOTS = new Set(["one's", "someone's", "somebody's"]);
// Après une particule séparée, un déterminant signale plutôt une préposition :
// « put the book on the table » n'est pas « put on ».
const DETERMINERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "my", "your", "his", "her", "its", "our",
  "their", "some", "any", "every", "each", "no", "another",
]);
const OBJECT_SLOTS = new Set(["someone", "somebody", "something", "sb", "sth"]);

const PUNCT = /^[\s"'“”‘’«»()[\]{}.,;:!?…—–\-*_]+|[\s"'“”‘’«»()[\]{}.,;:!?…—–\-*_]+$/g;
const CLAUSE_END = /[.,;:!?…—–)\]"”]$/;

/** Mot de la page → {t: forme normalisée, end: une ponctuation le suit}. */
export function normalizeToken(raw) {
  const s = String(raw ?? "").trim();
  return { t: s.replace(/’/g, "'").replace(PUNCT, "").toLowerCase(), end: CLAUSE_END.test(s) };
}

/** Une clé du dictionnaire est-elle une expression exploitable ? Renvoie ses mots, sinon null. */
export function patternWords(key) {
  if (!/^[a-z][a-z' -]*$/i.test(key)) return null;
  const words = key.toLowerCase().replace(/’/g, "'").split(" ").filter(Boolean);
  return words.length >= 2 && words.length <= 6 ? words : null;
}

/**
 * Tente de lire l'expression `words` dans `tokens` à partir de la position `start`.
 * `firstLemmas` : lemmes possibles de tokens[start]. Renvoie {end, positions, gaps, slots} ou null.
 * `positions` : indices des mots de la phrase qui correspondent à des mots de l'expression.
 */
export function matchAt(words, tokens, start, firstLemmas) {
  if (!firstLemmas.has(words[0])) return null;
  const best = { r: null };
  // Recherche en profondeur : k = mot de l'expression, p = position dans la phrase
  const go = (k, p, positions, gaps, slots) => {
    if (k === words.length) {
      const r = { end: p, positions, gaps, slots };
      if (!best.r || score(words, r) > score(words, best.r)) best.r = r;
      return;
    }
    // On ne franchit pas une ponctuation : le mot précédent ne doit pas clore la proposition
    if (p >= tokens.length || tokens[p - 1].end) return;
    const w = words[k], tok = tokens[p];
    if (POSSESSIVE_SLOTS.has(w)) {
      if (POSSESSIVES.has(tok.t) || /'s$/.test(tok.t)) go(k + 1, p + 1, positions, gaps, slots + 1);
      return;
    }
    if (w === "oneself") {
      if (REFLEXIVES.has(tok.t)) go(k + 1, p + 1, positions, gaps, slots + 1);
      return;
    }
    if (OBJECT_SLOTS.has(w)) {
      for (let n = 1; n <= 3 && p + n <= tokens.length; n++) {
        if (n > 1 && tokens[p + n - 2].end) break;
        go(k + 1, p + n, positions, gaps, slots + n);
      }
      return;
    }
    if (tok.t === w) go(k + 1, p + 1, [...positions, p], gaps, slots);
    // Particule séparée du verbe par un complément : « turned [the offer] down »
    if (k === 1 && words.length === 2 && SEPARABLE.has(w)) {
      for (let n = 1; n <= 3; n++) {
        const q = p + n;
        if (q >= tokens.length || tokens[q - 1].end) break;
        const next = tokens[q].end ? null : tokens[q + 1];
        if (tokens[q].t === w && !SEPARABLE.has(tokens[p].t) && !(next && DETERMINERS.has(next.t))) {
          go(k + 1, q + 1, [...positions, q], gaps + n, slots);
        }
      }
    }
  };
  go(1, start + 1, [start], 0, 0);
  return best.r;
}

/** Plus c'est long et littéral, mieux c'est ; les trous et les variables coûtent un peu. */
function score(words, r) {
  return 10 * r.positions.length - 2 * r.gaps - r.slots;
}

/**
 * Expressions qui contiennent le mot touché (indice i).
 * `lemmasAt(s)` : Set des lemmes possibles du mot s (le mot lui-même inclus).
 * `patternsFor(lemma)` : clés du dictionnaire qui commencent par « lemma ».
 * Renvoie [{key, start, end, positions, text}] du plus probable au moins probable.
 */
export function findExpressions(tokens, i, lemmasAt, patternsFor, { back = 6, max = 4 } = {}) {
  const found = new Map();
  for (let s = Math.max(0, i - back); s <= i; s++) {
    const lemmas = lemmasAt(s);
    if (!lemmas) continue;
    for (const lemma of lemmas) {
      for (const key of patternsFor(lemma)) {
        const words = patternWords(key);
        if (!words) continue;
        const r = matchAt(words, tokens, s, lemmas);
        // Le mot touché doit faire partie de l'expression (pas du complément intercalé)
        if (!r || !r.positions.includes(i)) continue;
        const sc = score(words, r);
        const prev = found.get(key);
        if (!prev || sc > prev.score) found.set(key, { key, start: s, end: r.end, positions: r.positions, score: sc });
      }
    }
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score || b.key.length - a.key.length)
    .slice(0, max);
}
