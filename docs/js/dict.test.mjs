// Tests du dictionnaire (fichiers simulés) : `node --test docs/js/*.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { shardKey } from "./ocr-core.js";

// Mini-dictionnaire au format de docs/dict/<xx>.json
const E = (pos, fr, gloss) => [{ pos, gloss: [gloss], fr, syn: [] }];
const ENTRIES = {
  look: E("verb", { "to try to see": ["regarder"] }, "To try to see."),
  "look into": E("verb", { "to investigate": ["se pencher sur", "examiner"] }, "To investigate."),
  turn: E("verb", { "to rotate": ["tourner"] }, "To rotate."),
  "turn down": E("verb", { "to refuse": ["refuser"] }, "To refuse."),
  put: E("verb", { "to place": ["mettre"] }, "To place."),
  "put up with": E("verb", {}, "To tolerate."),
  make: E("verb", { "to create": ["faire"] }, "To create."),
  "make up one's mind": E("verb", { "to decide": ["se décider"] }, "To decide."),
};
const FORMS = { looked: [["look", "verb", "past"]], turned: [["turn", "verb", "past"]], made: [["make", "verb", "past"]] };
const files = {};
for (const [w, v] of Object.entries(ENTRIES)) ((files[shardKey(w)] ??= { e: {}, f: {} }).e[w] = v);
for (const [w, v] of Object.entries(FORMS)) ((files[shardKey(w)] ??= { e: {}, f: {} }).f[w] = v);
globalThis.fetch = async (url) => {
  const key = url.match(/dict\/(.+)\.json$/)[1];
  return files[key] ? { ok: true, json: async () => structuredClone(files[key]) } : { ok: false };
};
const { lookup, expressionsAround } = await import("./dict.js");

test("expression tapée avec un verbe conjugué", async () => {
  const r = await lookup("looked into");
  assert.equal(r[0].word, "look into");
  assert.deepEqual(r[0].fr["to investigate"], ["se pencher sur", "examiner"]);
});

test("expression trouvée dans la phrase autour du mot touché", async () => {
  const [x] = await expressionsAround(["She", "looked", "into", "the", "matter."], 1);
  assert.equal(x.key, "look into");
  assert.equal(x.text, "looked into");
  assert.deepEqual(x.marks, ["looked", "into"]);
});

test("particule séparée et variable one's", async () => {
  const [a] = await expressionsAround(["He", "turned", "the", "offer", "down."], 4);
  assert.equal(a.key, "turn down");
  assert.equal(a.text, "turned the offer down");
  const [b] = await expressionsAround(["She", "made", "up", "her", "mind."], 1);
  assert.equal(b.key, "make up one's mind");
});

test("expression sans traduction française : gardée avec sa définition", async () => {
  const [x] = await expressionsAround(["I", "can't", "put", "up", "with", "it."], 2);
  assert.equal(x.key, "put up with");
  assert.deepEqual(x.entries[0].fr, {});
  assert.deepEqual(x.entries[0].gloss, ["To tolerate."]);
});

test("mot seul sans expression : rien de plus", async () => {
  assert.deepEqual(await expressionsAround(["Look", "at", "the", "dog."], 0), []);
});
