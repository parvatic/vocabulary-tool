# vocabulary-tool

Photographier une page d'un livre en anglais, toucher un mot, obtenir sa traduction française et ses synonymes anglais, et l'ajouter à une liste de vocabulaire exportable vers Anki.

Tout est **gratuit et hors ligne** : pas de LLM ni d'API payante. L'OCR tourne directement sur le téléphone (iPhone et Android) avec PaddleOCR, et le dictionnaire vient du Wiktionnaire.

**App en ligne :** https://parvatic.github.io/vocabulary-tool/

## Fonctionnement

```
Photo ─► Détection des lignes (DBNet) ─► Redressement + éclairage ─► Reconnaissance (SVTR + CTC) ─► mots cliquables
                                                                          │ tap
                                                                          ▼
                         Dictionnaire local (Wiktionnaire + WordNet) : lemme, sens, traductions FR, synonymes
                                                                          │
                                                                          ▼
                                                  Liste de vocabulaire ─► export CSV Anki
```

- **OCR** : modèles PaddleOCR PP-OCRv5 au format ONNX (détecteur *mobile*, reconnaisseur anglais), exécutés dans le navigateur par ONNX Runtime Web.
  - Chaque ligne détectée est **redressée le long de sa courbe** : on estime sa ligne centrale tranche par tranche, ce qui corrige à la fois l'inclinaison de la photo et la courbure de la page près de la reliure.
  - L'**éclairage** est corrigé colonne par colonne (ombre de la reliure), puis la ligne est lue **par morceaux d'environ 320 px**, coupés dans les espaces entre les mots : le reconnaisseur décroche sur une ligne entière.
  - Les boîtes de chaque mot sont retrouvées grâce aux pas de temps du décodage CTC.
  - Mesuré sur des photos de page simulées (inclinaison, courbure, ombre, flou, bruit, JPEG) : 99 à 100 % des mots lus, contre 0 % pour la première version dès que la page penche.
- **Lemmatisation** : *ran* → *run* (verbe), *neighbours* → *neighbour*, via les formes fléchies du Wiktionnaire.
- **Traductions** : groupées par sens, pour choisir celle qui correspond à la phrase.
- **Mots coupés** en fin de ligne (*neigh-* / *bours*) : recollés automatiquement.

## Démarrage

Prérequis : Docker.

```bash
make build        # image Docker (Tesseract, NLTK + WordNet, JupyterLab)
make dict         # une fois : télécharge le Wiktionnaire → data/en_fr.sqlite (~15-30 min)
make web          # dictionnaire compact docs/dict/ + modèles PaddleOCR docs/models/
make serve        # sert l'app sur http://localhost:8000 (et sur l'IP du Mac pour le Wi-Fi local)
```

`make run` lance JupyterLab ; `vocab_demo.ipynb` montre le même parcours en Python (avec Tesseract).

## Déploiement

L'app est un site statique dans `docs/`, servi par GitHub Pages (Settings → Pages → branche `main`, dossier `/docs`). Après un `make web`, il suffit de commiter et pousser.

Sur le téléphone : ouvrir l'URL, puis l'ajouter à l'écran d'accueil (iPhone : Partager → « Sur l'écran d'accueil » ; Android : ⋮ → « Installer l'application »). Ensuite l'app fonctionne hors ligne.

> L'app doit être servie en **https** (ou sur `localhost`) pour s'installer et fonctionner hors ligne. Depuis le téléphone, `localhost` désigne le téléphone lui-même : il faut l'URL déployée, ou l'IP du Mac affichée par `make serve`.

## Structure

```
docs/                    Web app (PWA) déployée
  index.html, styles.css
  js/app.js              Interface : photo, mots cliquables, fiche, liste, export
  js/ocr.js              Exécution des modèles avec ONNX Runtime Web
  js/ocr-core.js         Fonctions pures : lignes DBNet, redressement, éclairage, découpage, CTC, phrases, césures
  js/ocr-core.test.mjs   Tests : node --test docs/js/ocr-core.test.mjs
  js/dict.js             Recherche dans le dictionnaire découpé (docs/dict/<xx>.json)
  js/store.js            Liste de vocabulaire (localStorage) + export CSV Anki
  sw.js                  Service worker (hors ligne)
  dict/                  Dictionnaire compact, généré par `make web-dict`
  models/                Modèles ONNX, récupérés par `make web-models`
vocab/                   Chaîne Python
  build_dict.py          Wiktionnaire (kaikki.org) → data/en_fr.sqlite
  export_web.py          data/en_fr.sqlite → docs/dict/ (entrées avec traduction FR, synonymes WordNet)
  fetch_models.py        Modèles PaddleOCR ONNX (Hugging Face, versions figées et vérifiées) → docs/models/
  dictionary.py          Recherche + lemmatisation (Python)
  ocr.py                 OCR Tesseract avec boîtes par mot (notebook)
  synonyms.py            WordNet (NLTK)
  table.py               Table de vocabulaire SQLite + export Anki
vocab_demo.ipynb         Démo Python de bout en bout
notebook.ipynb           Premier essai OCR (Tesseract)
```

## Limites connues

- Les boîtes de détection sont alignées sur les axes : photographier la page à peu près droite.
- Le choix du sens est manuel (pas de désambiguïsation automatique sans LLM).
- La liste de vocabulaire est stockée dans le navigateur du téléphone : exporter régulièrement le CSV.
- Si le dossier du repo est synchronisé par iCloud, des copies de conflit `docs/dict/xx 2.json` peuvent apparaître après `make web-dict` : ne pas les commiter.

## Crédits et licences des données

- Dictionnaire : [Wiktionnaire anglais](https://en.wiktionary.org/), extrait par [wiktextract / kaikki.org](https://kaikki.org/) — CC BY-SA 4.0.
- Synonymes : [WordNet](https://wordnet.princeton.edu/) (Princeton University) — licence WordNet.
- OCR : [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv5 (Apache 2.0) ; conversions ONNX de [monkt/paddleocr-onnx](https://huggingface.co/monkt/paddleocr-onnx) (reconnaisseur anglais) et [nakamura196/ppocrv5-mobile-web-onnx](https://huggingface.co/nakamura196/ppocrv5-mobile-web-onnx) (détecteur), Apache 2.0.
- Exécution : [ONNX Runtime Web](https://onnxruntime.ai/) (MIT).
