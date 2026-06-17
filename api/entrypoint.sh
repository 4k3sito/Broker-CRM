#!/bin/sh
set -e

echo "Iniciando importación de datos..."
python import_data.py

echo "Iniciando servidor..."
exec uvicorn main:app --host 0.0.0.0 --port 8000
