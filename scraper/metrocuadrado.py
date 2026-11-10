"""Extrae inmuebles en venta y arriendo de Bogotá desde la API de búsqueda de metrocuadrado.com.

La API solo deja paginar hasta 10.000 resultados por consulta, así que cada
combinación (negocio, tipo) se parte por estrato y, si aún no cabe, por número
de habitaciones.

Uso:
    python scraper/metrocuadrado.py                 # todo, a data/snapshots/<hoy>/
    python scraper/metrocuadrado.py --negocio arriendo --tipo apartamento
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

URL = "https://www.metrocuadrado.com/rest-search/search"


def _api_key() -> str:
    """Llave que el sitio envía en el encabezado X-Api-Key (ver README).

    Se lee de la variable METROCUADRADO_API_KEY o de un archivo .env sin versionar.
    """
    key = os.environ.get("METROCUADRADO_API_KEY")
    env = Path(__file__).resolve().parent.parent / ".env"
    if not key and env.exists():
        for linea in env.read_text().splitlines():
            if linea.startswith("METROCUADRADO_API_KEY="):
                key = linea.split("=", 1)[1].strip().strip("\"'")
    if not key:
        sys.exit("Falta METROCUADRADO_API_KEY (variable de entorno o archivo .env). Ver README.")
    return key


API_KEY = _api_key()
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.3 Safari/605.1.15",
    "Referer": "https://www.metrocuadrado.com/apartamentos/venta/bogota/",
    "X-Requested-With": "XMLHttpRequest",
    "X-Api-Key": API_KEY,
}
PAGE = 50
MAX_FROM = 10_000  # tope de paginación de la API
ESTRATOS = ["1", "2", "3", "4", "5", "6"]
CUARTOS = ["1", "2", "3", "4", "5"]
COMBOS = [
    ("venta", "apartamento"),
    ("venta", "casa"),
    ("arriendo", "apartamento"),
    ("arriendo", "casa"),
    ("arriendo", "apartaestudio"),
]
CAMPOS = [
    "id", "negocio", "tipo", "precio", "admin", "area", "area_construida", "cuartos", "banos",
    "garajes", "estrato", "zona", "barrio", "barrio_comun", "lat", "lon", "ubicacion_aproximada",
    "estado", "proyecto", "oferente", "link", "imagen", "whatsapp", "comentario",
]

_local = threading.local()


def _session() -> requests.Session:
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
        _local.s.headers.update(HEADERS)
    return _local.s


def fetch(params: dict, retries: int = 5) -> dict:
    """Una página de resultados. Reintenta con espera creciente."""
    q = {"city": "bogotá", "size": PAGE, **params}
    for i in range(retries):
        try:
            r = _session().get(URL, params=q, timeout=40)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("application/json"):
                return r.json()
            err = f"HTTP {r.status_code}"
        except (requests.RequestException, ValueError) as e:
            err = repr(e)
        time.sleep(2 ** i)
    raise RuntimeError(f"Falló {q}: {err}")


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def normalizar(r: dict, negocio: str) -> dict | None:
    precio = _num(r.get("mvalorventa") if negocio == "venta" else r.get("mvalorarriendo"))
    if not precio or not r.get("midinmueble"):
        return None
    loc = r.get("localizacion") or {}
    data = r.get("data") or {}
    return {
        "id": r["midinmueble"],
        "negocio": negocio,
        "tipo": (r.get("mtipoinmueble") or {}).get("nombre"),
        "precio": precio,
        "admin": _num(data.get("mvaloradministracion")),
        "area": _num(r.get("marea")),
        "area_construida": _num(r.get("mareac")),
        "cuartos": r.get("mnrocuartos"),
        "banos": r.get("mnrobanos"),
        "garajes": r.get("mnrogarajes"),
        "estrato": r.get("estrato"),
        "zona": (r.get("mzona") or {}).get("nombre"),
        "barrio": (r.get("mbarrio") or "").strip() or None,
        "barrio_comun": " ".join((r.get("mnombrecomunbarrio") or "").split()) or None,
        "lat": loc.get("lat"),
        "lon": loc.get("lon"),
        "ubicacion_aproximada": r.get("ubicacionaproximada"),
        "estado": r.get("mestadoinmueble"),
        "proyecto": r.get("mnombreproyecto"),
        "oferente": r.get("OwnerType") or r.get("moferente"),
        "link": r.get("link"),
        "imagen": r.get("imageLink"),
        "whatsapp": r.get("whatsapp"),
        "comentario": " ".join((r.get("comment") or "").split())[:600] or None,
    }


def particiones(negocio: str, tipo: str) -> list[tuple[dict, int]]:
    """Consultas (filtros, total) que juntas cubren el combo sin pasar el tope."""
    base = {"realEstateBusinessList": negocio, "realEstateTypeList": tipo}
    out = []
    for e in ESTRATOS:
        f = {**base, "stratumList": e}
        total = fetch({**f, "from": 0})["totalHits"]
        if total <= MAX_FROM:
            out.append((f, total))
            continue
        for c in CUARTOS:
            fc = {**f, "roomList": c}
            t = fetch({**fc, "from": 0})["totalHits"]
            if t > MAX_FROM:
                print(f"  aviso: {fc} tiene {t} resultados; solo se alcanzan {MAX_FROM}", file=sys.stderr)
            out.append((fc, t))
    return out


def extraer(negocio: str, tipo: str, workers: int = 4) -> dict[str, dict]:
    inmuebles: dict[str, dict] = {}
    partes = particiones(negocio, tipo)
    tareas = [
        {**f, "from": desde}
        for f, total in partes
        for desde in range(0, min(total, MAX_FROM), PAGE)
    ]
    print(f"{negocio}/{tipo}: {sum(t for _, t in partes)} anunciados, {len(tareas)} páginas")
    with ThreadPoolExecutor(workers) as ex:
        for n, pagina in enumerate(ex.map(fetch, tareas), 1):
            for r in pagina.get("results", []):
                # Cada página trae además "destacados" repetidos; el dict los deduplica.
                if (r.get("mtiponegocio") or "").lower() != negocio:
                    continue
                reg = normalizar(r, negocio)
                if reg:
                    inmuebles[reg["id"]] = reg
            if n % 100 == 0:
                print(f"  {n}/{len(tareas)} páginas, {len(inmuebles)} inmuebles")
    print(f"  -> {len(inmuebles)} inmuebles únicos")
    return inmuebles


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--negocio", choices=["venta", "arriendo"])
    ap.add_argument("--tipo", choices=["apartamento", "casa", "apartaestudio"])
    ap.add_argument("--out", default="data/snapshots")
    ap.add_argument("--fecha", default=dt.date.today().isoformat())
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()

    destino = Path(a.out) / a.fecha
    destino.mkdir(parents=True, exist_ok=True)
    por_negocio: dict[str, dict] = {}
    for negocio, tipo in COMBOS:
        if (a.negocio and negocio != a.negocio) or (a.tipo and tipo != a.tipo):
            continue
        por_negocio.setdefault(negocio, {}).update(extraer(negocio, tipo, a.workers))
    for negocio, regs in por_negocio.items():
        ruta = destino / f"{negocio}.csv.gz"
        with gzip.open(ruta, "wt", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=CAMPOS)
            w.writeheader()
            w.writerows(regs.values())
        print(f"{ruta}: {len(regs)} filas")


if __name__ == "__main__":
    main()
