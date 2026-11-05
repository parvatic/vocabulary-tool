// Tests des expressions : `node --test docs/js/*.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToken, patternWords, findExpressions } from "./expr.js";

// Petit dictionnaire d'expressions et de formes fléchies pour les tests
const KEYS = [
  "look into", "look after", "look for", "look up", "look forward to", "turn down", "turn up",
  "run out", "put up", "put up with", "make up", "make up one's mind", "make someone laugh",
  "pick up", "put on", "in spite of", "kick the bucket", "give up", "throw oneself into",
];
const FORMS = {
  looked: ["look"], looking: ["look"], turned: ["turn"], ran: ["run"], made: ["make"],
  picked: ["pick"], kicked: ["kick"], gave: ["give"], threw: ["throw"], put: ["put"],
};

function find(sentence, tapped) {
  const raw = sentence.split(" ");
  const tokens = raw.map(normalizeToken);
  const i = raw.findIndex((w) => normalizeToken(w).t === tapped);
  assert.ok(i >= 0, `mot « ${tapped} » absent`);
  const lemmasAt = (s) => new Set([tokens[s].t, ...(FORMS[tokens[s].t] || [])]);
  const patternsFor = (lemma) => KEYS.filter((k) => k.startsWith(lemma + " "));
  return findExpressions(tokens, i, lemmasAt, patternsFor);
}
const first = (sentence, tapped) => find(sentence, tapped)[0]?.key;

test("verbe conjugué + particule, en touchant le verbe ou la particule", () => {
  assert.equal(first("She looked into the matter.", "looked"), "look into");
  assert.equal(first("She looked into the matter.", "into"), "look into");
  assert.equal(first("He is looking after his sister", "after"), "look after");
});

test("l'expression la plus longue l'emporte", () => {
  assert.equal(first("I can't put up with this noise.", "put"), "put up with");
  assert.equal(first("We look forward to seeing you.", "look"), "look forward to");
  assert.equal(first("She finally made up her mind.", "made"), "make up one's mind");
});

test("particule séparée du verbe par un complément", () => {
  assert.equal(first("He turned the offer down.", "turned"), "turn down");
  assert.equal(first("He turned the offer down.", "down"), "turn down");
  assert.equal(first("She picked him up at noon.", "picked"), "pick up");
  // le complément lui-même ne déclenche pas l'expression
  assert.equal(find("He turned the offer down.", "offer").length, 0);
});

test("particule séparée suivie d'un déterminant = préposition, pas d'expression", () => {
  assert.equal(find("He put the book on the table.", "put").some((x) => x.key === "put on"), false);
  assert.equal(first("She picked him up at noon.", "up"), "pick up", "suivie d'une préposition : reste une particule");
});

test("variables someone / oneself", () => {
  assert.equal(first("That story made her laugh.", "made"), "make someone laugh");
  assert.equal(first("He threw himself into the work.", "threw"), "throw oneself into");
});

test("locution qui commence avant le mot touché", () => {
  assert.equal(first("They went out in spite of the rain.", "spite"), "in spite of");
  assert.equal(first("The old man kicked the bucket.", "bucket"), "kick the bucket");
});

test("une expression ne franchit pas la ponctuation", () => {
  assert.equal(find("She looked, into the distance, at nothing.", "looked").length, 0);
  assert.equal(find("He turned. Down the road he went.", "turned").length, 0);
});

test("pas d'expression inventée", () => {
  assert.equal(find("Look at the dog.", "look").length, 0);
  assert.equal(first("They ran out of milk.", "ran"), "run out", "« run out of » absent : on garde « run out »");
});

test("normalisation et clés utilisables", () => {
  assert.deepEqual(normalizeToken("“Into,"), { t: "into", end: true });
  assert.deepEqual(normalizeToken("Her’s"), { t: "her's", end: false });
  assert.deepEqual(patternWords("make up one's mind"), ["make", "up", "one's", "mind"]);
  assert.equal(patternWords("look"), null);
  assert.equal(patternWords("e.g. something"), null);
});
