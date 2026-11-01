FROM python:3.11-slim

# Tesseract (moteur OCR utilisé par pytesseract) + libs requises par OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-fra \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /code

COPY ./requirements.txt /code/requirements.txt

RUN pip install --no-cache-dir --upgrade -r /code/requirements.txt

# WordNet (synonymes anglais + lemmatisation de secours), gratuit et hors ligne
RUN python -m nltk.downloader -d /usr/local/share/nltk_data wordnet omw-1.4

COPY . /code

# Tolérance plus large sur la date de modification : évite les faux
# « File Changed » dus au montage du dossier local (-v) depuis macOS
COPY ./jupyter/overrides.json /usr/local/share/jupyter/lab/settings/overrides.json

# Port utilisé par Jupyter
EXPOSE 8888

# Lancement de Jupyter (sans token : le port n'est publié que sur 127.0.0.1, cf. Makefile)
CMD ["jupyter", "lab", "--ip=0.0.0.0", "--port=8888", "--no-browser", "--allow-root", \
     "--IdentityProvider.token=", "--ServerApp.password="]
