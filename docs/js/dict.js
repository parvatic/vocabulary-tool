// Dictionnaire anglais → français, découpé en petits fichiers docs/dict/<xx>.json
// (générés par `python -m vocab.export_web`), chargés à la demande puis mis en cache.
import { cleanToken, shardKey } from "./ocr-core.js";

const shards = new Map();

async function shard(word) {
  const key = shardKey(word);
  if (!shards.has(key)) {
    shards.set(key, fetch(`dict/${key}.json`).then((r) => (r.ok ? r.json() : { e: {}, f: {} })));
  }
  return shards.get(key);
}

/**
 * Entrées pour un mot du texte, lemme résolu : « Ran, » → run (verb).
 * Renvoie [{word, pos, gloss[], fr:{sens:[mots]}, syn[], via}]
 */
export async function lookup(token) {
  const word = cleanToken(token);
  if (!word) return [];
  const variants = word === word.toLowerCase() ? [word] : [word, word.toLowerCase()];
  // {lemma, via, pos} : via une forme fléchie, la nature est imposée (« ran » → verbe run, pas le nom)
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
  // Repli simple quand le Wiktionnaire n'a pas la forme fléchie
  for (const v of variants) {
    for (const [re, rep] of [[/ies$/, "y"], [/ied$/, "y"], [/ves$/, "f"], [/es$/, ""], [/s$/, ""], [/ed$/, ""], [/ed$/, "e"], [/ing$/, ""], [/ing$/, "e"], [/er$/, ""], [/est$/, ""]]) {
      if (lemmas.length) break;
      if (!re.test(v)) continue;
      const cand = v.replace(re, rep);
      if (cand.length > 1 && (await shard(cand)).e[cand]) add(cand, `lemme probable « ${cand} »`);
    }
  }
  const out = [];
  for (const { lemma, via, pos } of lemmas) {
    for (const e of (await shard(lemma)).e[lemma] || []) {
      if (!pos || e.pos === pos) out.push({ word: lemma, via, ...e });
    }
  }
  return out;
}
