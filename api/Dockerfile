FROM python:3.12-slim
WORKDIR /app

# WeasyPrint renderiza el PDF del análisis de mercado, y no es Python puro: dibuja
# con Pango y Cairo, así que necesita esas librerías del sistema. Es la razón de
# que esta imagen ya no sea sólo `pip install`.
#
# Las fuentes van DENTRO de la imagen a propósito. El sitio las carga de Google
# Fonts en el navegador (ver Caddyfile), pero un PDF que depende de una descarga
# en el momento de renderizar sale con tipografía distinta el día que la red falle
# —y sale sin avisar, que es lo peor—. Aquí son parte del artefacto.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libjpeg62-turbo \
      libopenjp2-7 fontconfig \
    && rm -rf /var/lib/apt/lists/*

COPY fuentes/ /usr/share/fonts/truetype/officelab/
RUN fc-cache -f

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py documento.py documento.css ./

# `nobody` no tiene HOME y fontconfig intenta escribir su caché por usuario en
# cada render: sin esto, cada PDF sale precedido de "No writable cache
# directories" y fontconfig re-escanea las fuentes en vez de leer el caché que
# ya construyó `fc-cache` aquí arriba.
ENV XDG_CACHE_HOME=/tmp
USER nobody
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
