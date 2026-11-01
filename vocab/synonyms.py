"""Synonymes anglais et lemmatisation via WordNet (NLTK), gratuits et hors ligne.

Si NLTK ou les données WordNet ne sont pas installés, les fonctions renvoient des
listes vides : le reste de l'outil continue de marcher avec le Wiktionnaire seul.
"""

from functools import lru_cache

try:
    from nltk.corpus import wordnet as wn
    wn.ensure_loaded()
    AVAILABLE = True
except Exception:  # NLTK absent ou données non téléchargées
    wn = None
    AVAILABLE = False

# Nature Wiktionnaire → nature WordNet
_POS = {"noun": "n", "name": "n", "verb": "v", "adj": "a", "adv": "r"}


@lru_cache(maxsize=4096)
def morphy_all(word: str) -> tuple[str, ...]:
    """Lemmes possibles selon WordNet, toutes natures confondues."""
    if not AVAILABLE:
        return ()
    out = []
    for p in ("v", "n", "a", "r"):
        lemma = wn.morphy(word, p)
        if lemma and lemma not in out:
            out.append(lemma)
    return tuple(out)


@lru_cache(maxsize=4096)
def synonyms(lemma: str, pos: str | None = None, max_senses: int = 4) -> list[str]:
    """Synonymes des `max_senses` sens les plus fréquents du lemme (pour cette nature)."""
    if not AVAILABLE:
        return []
    wn_pos = _POS.get(pos or "")
    synsets = wn.synsets(lemma, pos=wn_pos) if wn_pos or pos is None else []
    out = []
    for s in synsets[:max_senses]:
        for l in s.lemmas():
            name = l.name().replace("_", " ")
            if name.lower() != lemma.lower() and name not in out:
                out.append(name)
    return out
