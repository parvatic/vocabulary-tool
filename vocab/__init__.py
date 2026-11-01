"""vocabulary-tool : photo d'une page anglaise → mot choisi → table de vocabulaire FR."""

from .ocr import Word, annotate, find, ocr_words, page_text, sentence_of, word_at
from .table import VocabTable


def __getattr__(name):
    # Import paresseux : le dictionnaire n'existe qu'après `make dict`.
    if name in ("Dictionary", "Entry", "Sense", "clean_token"):
        from . import dictionary
        return getattr(dictionary, name)
    raise AttributeError(name)
