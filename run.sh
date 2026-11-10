#!/usr/bin/env bash
# Genera los datos del mapa (si faltan) y abre el sitio en http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")"
[ -f web/data/inmuebles.json ] || python3 pipeline/build.py
echo "Abre http://localhost:8000"
python3 -m http.server 8000 --directory web
