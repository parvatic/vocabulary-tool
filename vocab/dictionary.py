"""Recherche d'un mot anglais dans le dictionnaire local construit par build_dict."""

import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from .build_dict import DEFAULT_DB
from . import synonyms as wn_syn

# Ponctuation à retirer autour d'un mot issu de l'OCR (guillemets droits et typographiques, etc.)
_STRIP = "\"'“”‘’«»()[]{}.,;:!?…—–-*_"
_POSSESSIVE = re.compile(r"(?:'s|’s|s'|s’)$")


def clean_token(token: str) -> str:
    """'“Ran,' → 'Ran' ; "dog's" → 'dog'."""
    t = token.strip().strip(_STRIP)
    t = _POSSESSIVE.sub("", t) if len(t) > 4 else t
    return t.strip(_STRIP)


_TECH_TAGS = {"form-of", "alt-of", "inflection-template", "no-gloss"}


def form_label(lemma: str, pos: str, tags: str | None) -> str:
    """« past form-of » → « past form of « run » (verb) »."""
    kept = " ".join(t for t in (tags or "").split() if t not in _TECH_TAGS)
    return f"{kept + ' ' if kept else ''}form of « {lemma} » ({pos})"


@dataclass
class Sense:
    gloss: str                      # définition en anglais
    tags: list[str] = field(default_factory=list)
    synonyms: list[str] = field(default_factory=list)


@dataclass
class Entry:
    word: str                       # lemme, ex. "run"
    pos: str                        # nature : noun, verb, adj…
    senses: list[Sense]
    fr: dict[str, list[str]]        # traductions FR groupées par sens : {"to move quickly": ["courir"]}
    synonyms: list[str]             # synonymes (Wiktionnaire + WordNet), sans doublons
    via_form: str | None = None     # ex. "past of run" si on est passé par une forme fléchie

    @property
    def fr_flat(self) -> list[str]:
        seen, out = set(), []
        for words in self.fr.values():
            for w in words:
                if w not in seen:
                    seen.add(w)
                    out.append(w)
        return out


class Dictionary:
    def __init__(self, db_path: Path | str = DEFAULT_DB):
        db_path = Path(db_path)
        if not db_path.exists():
            raise FileNotFoundError(
                f"Dictionnaire introuvable : {db_path}\n"
                "Construis-le une fois avec `make dict` (ou `python -m vocab.build_dict`)."
            )
        self.con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)

    # -- résolution du lemme ------------------------------------------------
    def _lemmas(self, word: str) -> list[tuple[str, str | None, str | None]]:
        """Candidats (lemme, explication, nature imposée) pour un mot tel qu'il apparaît dans le texte.

        Via une forme fléchie, la nature est imposée : « ran » est une forme du verbe
        « run », on ne propose donc pas le nom « run ».
        """
        out: list[tuple[str, str | None, str | None]] = []
        variants = [word] + ([word.lower()] if word.lower() != word else [])
        for v in variants:
            if self._has_entry(v):
                out.append((v, None, None))
            for lemma, pos, tags in self.con.execute(
                    "SELECT lemma, pos, tags FROM forms WHERE form = ?", (v,)):
                out.append((lemma, form_label(lemma, pos, tags), pos))
        # Repli : la morphologie de WordNet (ex. « bruised » → « bruise »)
        if not out:
            for lemma in wn_syn.morphy_all(word.lower()):
                if self._has_entry(lemma):
                    out.append((lemma, f"lemme probable « {lemma} » (WordNet)", None))
        # dédoublonnage : une entrée directe l'emporte sur un renvoi au même lemme
        direct = {lemma for lemma, _, pos in out if pos is None}
        seen, uniq = set(), []
        for lemma, why, pos in out:
            if pos is not None and lemma in direct:
                continue
            if (lemma, pos) not in seen:
                seen.add((lemma, pos))
                uniq.append((lemma, why, pos))
        return uniq

    def _has_entry(self, word: str) -> bool:
        return self.con.execute("SELECT 1 FROM entries WHERE word = ? LIMIT 1", (word,)).fetchone() is not None

    # -- recherche ------------------------------------------------------------
    def lookup(self, token: str, with_wordnet: bool = True) -> list[Entry]:
        """Toutes les entrées pertinentes pour un mot du texte, lemme résolu."""
        word = clean_token(token)
        if not word:
            return []
        entries: list[Entry] = []
        for lemma, why, only_pos in self._lemmas(word):
            for pos, data in self.con.execute(
                    "SELECT pos, data FROM entries WHERE word = ?", (lemma,)):
                if only_pos and pos != only_pos:
                    continue
                d = json.loads(data)
                fr: dict[str, list[str]] = {}
                for t in d["fr"]:
                    lst = fr.setdefault(t["sense"], [])
                    if t["word"] not in lst:
                        lst.append(t["word"])
                syns = list(d["synonyms"])
                for s in d["senses"]:
                    syns += s["synonyms"]
                if with_wordnet:
                    syns += wn_syn.synonyms(lemma, pos)
                syns = [s for i, s in enumerate(syns) if s != lemma and s not in syns[:i]]
                entries.append(Entry(
                    word=lemma, pos=pos,
                    senses=[Sense(**s) for s in d["senses"]],
                    fr=fr, synonyms=syns, via_form=why,
                ))
        # Les entrées avec traductions françaises d'abord
        entries.sort(key=lambda e: not e.fr)
        return entries
