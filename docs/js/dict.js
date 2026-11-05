// Dictionnaire anglais → français, découpé en petits fichiers docs/dict/<xx>.json
// (générés par `python -m vocab.export_web`), chargés à la demande puis mis en cache.
import { cleanToken, shardKey } from "./ocr-core.js";
import { normalizeToken, findExpressions } from "./expr.js";

const shards = new Map();

async function shard(word) {
  const key = shardKey(word);
  if (!shards.has(key)) {
    shards.set(key, fetch(`dict/${key}.json`).then((r) => (r.ok ? r.json() : { e: {}, f: {} })));
  }
  return shards.get(key);
}

// Repli quand le Wiktionnaire n'a pas la forme fléchie
const SUFFIX_RULES = [[/ies$/, "y"], [/ied$/, "y"], [/ves$/, "f"], [/es$/, ""], [/s$/, ""], [/ed$/, ""], [/ed$/, "e"], [/ing$/, ""], [/ing$/, "e"], [/er$/, ""], [/est$/, ""]];

/**
 * Lemmes possibles d'un mot : [{lemma, via, pos}]. Via une forme fléchie, la nature est
 * imposée (« ran » → verbe run, pas le nom).
 */
async function resolveLemmas(word) {
  const variants = word === word.toLowerCase() ? [word] : [word, word.toLowerCase()];
  const lemmas = [];
  const add = (lemma, via, pos = null) => {
    if (pos && lemmas.some((l) => l.lemma === lemma && !l.pos)) return; // une entrée directe l'emporte
    if (!lemmas.some((l) => l.lemma === lemma && l.pos === pos)) lemmas.push({ lemma, via, pos });
  };
  for (const v of variants) {
    const s = await shard(v);
    if (s.e[v]) add(v, null);
    for (const [lemma, pos, tags] of s.f[v] || []) add(lemma, `${tags ? tags + " " : ""}form of « ${lemma} » (${pos})`, pos);
  }
  for (const v of variants) {
    for (const [re, rep] of SUFFIX_RULES) {
      if (lemmas.length) break;
      if (!re.test(v)) continue;
      const cand = v.replace(re, rep);
      if (cand.length > 1 && (await shard(cand)).e[cand]) add(cand, `lemme probable « ${cand} »`);
    }
  }
  return lemmas;
}

async function entriesOf(lemmas) {
  const out = [];
  for (const { lemma, via, pos } of lemmas) {
    for (const e of (await shard(lemma)).e[lemma] || []) {
      if (!pos || e.pos === pos) out.push({ word: lemma, via, ...e });
    }
  }
  return out;
}

/**
 * Entrées pour un mot (ou une expression tapée) : « Ran, » → run (verb) ;
 * « looked into » → look into. Renvoie [{word, pos, gloss[], fr:{sens:[mots]}, syn[], via}]
 */
export async function lookup(token) {
  const word = cleanToken(token);
  if (!word) return [];
  const out = await entriesOf(await resolveLemmas(word));
  // Expression tapée avec un verbe conjugué : on cherche « lemme + reste »
  if (!out.length && /\s/.test(word)) {
    const [head, ...rest] = word.toLowerCase().split(/\s+/);
    for (const { lemma } of await resolveLemmas(head)) {
      const key = [lemma, ...rest].join(" ");
      for (const e of (await shard(key)).e[key] || []) out.push({ word: key, via: `expression « ${key} »`, ...e });
    }
  }
  return out;
}

// Index des expressions par premier mot, construit une fois par fichier du dictionnaire
const byFirstWord = new WeakMap();

async function expressionsStartingWith(lemma) {
  const s = await shard(lemma);
  let index = byFirstWord.get(s);
  if (!index) {
    index = new Map();
    for (const k of Object.keys(s.e)) {
      const sp = k.indexOf(" ");
      if (sp <= 0) continue;
      const first = k.slice(0, sp).toLowerCase();
      if (!index.has(first)) index.set(first, []);
      index.get(first).push(k);
    }
    byFirstWord.set(s, index);
  }
  return index.get(lemma) || [];
}

/**
 * Expressions du dictionnaire présentes dans la phrase autour du mot touché.
 * `rawTokens` : mots de la page (avec leur ponctuation) ; `i` : indice du mot touché.
 * Renvoie [{key, text, marks, entries}] du plus probable au moins probable.
 */
export async function expressionsAround(rawTokens, i) {
  const tokens = rawTokens.map(normalizeToken);
  const lemmaSets = new Map(), patterns = new Map();
  for (let s = Math.max(0, i - 6); s <= i; s++) {
    const t = tokens[s].t;
    if (!/^[a-z]/.test(t)) continue;
    const set = new Set([t]);
    for (const { lemma } of await resolveLemmas(t)) set.add(lemma.toLowerCase());
    lemmaSets.set(s, set);
    for (const l of set) if (!patterns.has(l)) patterns.set(l, await expressionsStartingWith(l));
  }
  const found = findExpressions(tokens, i, (s) => lemmaSets.get(s), (l) => patterns.get(l) || []);
  const out = [];
  for (const f of found) {
    const entries = ((await shard(f.key)).e[f.key] || []).map((e) => ({ word: f.key, via: null, ...e }));
    if (!entries.length) continue;
    out.push({
      key: f.key,
      text: rawTokens.slice(f.start, f.end).map((w) => cleanToken(w)).join(" "),
      marks: f.positions.map((p) => rawTokens[p]),
      entries,
    });
  }
  return out;
}
