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

COPY . /code

# Port utilisé par Jupyter
EXPOSE 8888

# Lancement de Jupyter (sans token : le port n'est publié que sur 127.0.0.1, cf. Makefile)
CMD ["jupyter", "notebook", "--ip=0.0.0.0", "--port=8888", "--no-browser", "--allow-root", \
     "--IdentityProvider.token=", "--ServerApp.password="]
