"""Limpia un snapshot del scraper y genera web/data/inmuebles.json para el mapa.

Para cada inmueble en venta calcula:
  - arriendo estimado: mediana del arriendo/m² de los arriendos comparables más
    cercanos (mismo tipo, área ±30 %, estrato ±1) multiplicada por su área;
  - precio/m² frente a las ventas comparables cercanas (qué tan "subvalorado" está);
  - arriendo/m² de unidades pequeñas cercanas (escenario "casa subdividida").

Uso:
    python pipeline/build.py                # usa el snapshot más reciente
    python pipeline/build.py --snapshot data/snapshots/2026-11-10
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

RAIZ = Path(__file__).resolve().parent.parent
BBOX = dict(lat=(4.45, 4.84), lon=(-74.23, -73.99))  # Bogotá urbana
TIPOS = {"Apartamento": 0, "Casa": 1, "Apartaestudio": 2}

# Límites de cordura (COP). Fuera de ellos casi siempre es un error de digitación.
VENTA_M2 = (1.0e6, 30e6)
ARRIENDO_M2 = (8e3, 150e3)
AREA = (15, 1500)

K_ARRIENDO, R_ARRIENDO, MIN_ARRIENDO = 12, 3000, 4
K_VENTA, R_VENTA, MIN_VENTA = 20, 1500, 6
AREA_RATIO = 1.43  # comparables entre 0,7x y 1,43x el área
AREA_UNIDAD = 60  # m² máximo de una "unidad pequeña"


def entero(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.astype(str).str.extract(r"(\d+)")[0], errors="coerce")


def limpiar(df: pd.DataFrame, negocio: str) -> tuple[pd.DataFrame, dict]:
    n0 = len(df)
    df = df.copy()
    df["t"] = df["tipo"].map(TIPOS)
    ac = pd.to_numeric(df["area_construida"], errors="coerce")
    a = pd.to_numeric(df["area"], errors="coerce")
    df["a"] = ac.where(ac > 0, a)
    for dst, src in [("c", "cuartos"), ("b", "banos"), ("g", "garajes"), ("e", "estrato")]:
        df[dst] = entero(df[src])
    df["ad"] = pd.to_numeric(df["admin"], errors="coerce")
    df.loc[~df["ad"].between(20e3, 5e6), "ad"] = np.nan
    df["m2"] = df["precio"] / df["a"]
    lim = VENTA_M2 if negocio == "venta" else ARRIENDO_M2
    pasos = {
        "sin_tipo": df["t"].notna(),
        "sin_coordenadas_en_bogota": df["lat"].between(*BBOX["lat"]) & df["lon"].between(*BBOX["lon"]),
        "area_invalida": df["a"].between(*AREA),
        "precio_m2_atipico": df["m2"].between(*lim),
    }
    descartes = {}
    ok = pd.Series(True, index=df.index)
    for nombre, cond in pasos.items():
        descartes[nombre] = int((ok & ~cond).sum())
        ok &= cond
    df = df[ok]
    # El mismo inmueble publicado por varias inmobiliarias.
    llave = [df["t"], df["lat"].round(5), df["lon"].round(5), df["a"].round(0), df["precio"], df["c"]]
    dup = pd.concat(llave, axis=1).duplicated()
    descartes["duplicados"] = int(dup.sum())
    df = df[~dup].reset_index(drop=True)
    df["t"] = df["t"].astype(int)
    df["ap"] = (df["ubicacion_aproximada"] == "S").astype(int)
    df["nu"] = (df["link"].str.startswith("/proyecto/") | df["proyecto"].notna()
                | df["estado"].fillna("").str.contains("uevo|plano|onstrucc")).astype(int)
    return df, {"leidos": n0, "validos": len(df), "descartes": descartes}


def metros(lat, lon, lat0=4.65):
    """Coordenadas planas en metros (suficiente a escala de ciudad)."""
    return np.c_[np.radians(lon) * 6371000 * np.cos(np.radians(lat0)), np.radians(lat) * 6371000].astype(np.float32)


def vecinos(q: pd.DataFrame, ref: pd.DataFrame, valor: np.ndarray, k: int, radio: float,
            tipos_ok, misma_tabla=False, area_max=None, bloque=800):
    """Para cada fila de q, los k comparables más cercanos de ref.

    Devuelve (indices [n,k] con -1 de relleno, distancias [n,k]).
    tipos_ok(t_q) -> máscara booleana sobre ref con los tipos admitidos.
    """
    xq, xr = metros(q["lat"], q["lon"]), metros(ref["lat"], ref["lon"])
    aq, ar = q["a"].to_numpy(np.float32), ref["a"].to_numpy(np.float32)
    eq, er = q["e"].to_numpy(np.float32), ref["e"].to_numpy(np.float32)
    tq, tr = q["t"].to_numpy(), ref["t"].to_numpy()
    n = len(q)
    idx = np.full((n, k), -1, dtype=np.int32)
    dist = np.full((n, k), np.inf, dtype=np.float32)
    if len(ref) == 0:
        return idx, dist
    kk = min(k, len(ref) - 1) if len(ref) > 1 else 1
    for i in range(0, n, bloque):
        s = slice(i, i + bloque)
        d = np.hypot(xq[s, None, 0] - xr[None, :, 0], xq[s, None, 1] - xr[None, :, 1])
        ok = d <= radio
        if area_max is None:
            r = ar[None, :] / aq[s, None]
            ok &= (r >= 1 / AREA_RATIO) & (r <= AREA_RATIO)
        else:
            ok &= (ar <= area_max)[None, :]
        de = np.abs(er[None, :] - eq[s, None])
        ok &= ~(de > 1)  # NaN (estrato desconocido) no descarta
        for t in np.unique(tq[s]):
            filas = np.where(tq[s] == t)[0]
            ok[filas] &= tipos_ok(t, tr)[None, :]
        ok &= np.isfinite(valor)[None, :]
        if misma_tabla:
            f = np.arange(d.shape[0])
            ok[f, f + i] = False
        d[~ok] = np.inf
        part = np.argpartition(d, kk - 1, axis=1)[:, :kk]
        dp = np.take_along_axis(d, part, axis=1)
        orden = np.argsort(dp, axis=1)
        part, dp = np.take_along_axis(part, orden, axis=1), np.take_along_axis(dp, orden, axis=1)
        part[~np.isfinite(dp)] = -1
        idx[s, :kk], dist[s, :kk] = part, dp
    return idx, dist


def resumen(idx, dist, valor, minimo):
    """Mediana, p25, p75, n y radio usado por fila (NaN si hay menos de `minimo`)."""
    v = np.where(idx >= 0, valor[np.clip(idx, 0, None)], np.nan)
    n = (idx >= 0).sum(axis=1)
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            med, p25, p75 = (np.nanpercentile(v, p, axis=1) for p in (50, 25, 75))
    r = np.where(np.isfinite(dist), dist, -np.inf).max(axis=1)
    malo = n < minimo
    for arr in (med, p25, p75):
        arr[malo] = np.nan
    return med, p25, p75, n, np.where(malo, np.nan, r)


def en_poligono(lon, lat, anillo):
    x, y = np.asarray(anillo)[:, 0], np.asarray(anillo)[:, 1]
    dentro = np.zeros(len(lon), dtype=bool)
    j = len(x) - 1
    for i in range(len(x)):
        cruza = ((y[i] > lat) != (y[j] > lat)) & (lon < (x[j] - x[i]) * (lat - y[i]) / (y[j] - y[i] + 1e-18) + x[i])
        dentro ^= cruza
        j = i
    return dentro


def localidad(df: pd.DataFrame, geo: dict) -> np.ndarray:
    lon, lat = df["lon"].to_numpy(), df["lat"].to_numpy()
    out = np.full(len(df), -1, dtype=int)
    for i, f in enumerate(geo["features"]):
        g = f["geometry"]
        polis = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        m = np.zeros(len(df), dtype=bool)
        for p in polis:
            dentro = en_poligono(lon, lat, p[0])
            for hueco in p[1:]:
                dentro &= ~en_poligono(lon, lat, hueco)
            m |= dentro
        out[m & (out < 0)] = i
    return out


def col(s, dec=None):
    """Serie -> lista JSON compacta (None en lugar de NaN)."""
    if dec is not None:
        s = pd.Series(s).round(dec)
        if dec == 0:
            return [None if pd.isna(v) else int(v) for v in s]
        return [None if pd.isna(v) else float(v) for v in s]
    return [None if pd.isna(v) else v for v in pd.Series(s)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--snapshot")
    ap.add_argument("--out", default=str(RAIZ / "web/data/inmuebles.json"))
    a = ap.parse_args()
    snap = Path(a.snapshot) if a.snapshot else sorted((RAIZ / "data/snapshots").iterdir())[-1]
    print("snapshot:", snap)

    V, info_v = limpiar(pd.read_csv(snap / "venta.csv.gz", low_memory=False), "venta")
    R, info_r = limpiar(pd.read_csv(snap / "arriendo.csv.gz", low_memory=False), "arriendo")
    V = V[V["t"] < 2].reset_index(drop=True)
    print("ventas", info_v, "\narriendos", info_r)

    geo = json.loads((RAIZ / "web/data/localidades.geojson").read_text())
    V["loc"], R["loc"] = localidad(V, geo), localidad(R, geo)

    # --- Arriendo estimado -------------------------------------------------
    rm2 = R["m2"].to_numpy(np.float32)
    # Apartamentos se comparan con apartamentos y apartaestudios; casas con casas.
    estricto = lambda t, tr: (tr != 1) if t == 0 else (tr == 1)
    cualquiera = lambda t, tr: np.ones(len(tr), dtype=bool)
    idx, dist = vecinos(V, R, rm2, K_ARRIENDO, R_ARRIENDO, estricto)
    med, p25, p75, n, radio = resumen(idx, dist, rm2, MIN_ARRIENDO)
    V["rx"] = 0  # 1 = se usaron comparables de otro tipo de inmueble
    falta = np.isnan(med)
    if falta.any():
        i2, d2 = vecinos(V[falta], R, rm2, K_ARRIENDO, R_ARRIENDO, cualquiera)
        m2_, a2, b2, n2, r2 = resumen(i2, d2, rm2, MIN_ARRIENDO)
        idx[falta], med[falta], p25[falta], p75[falta], n[falta], radio[falta] = i2, m2_, a2, b2, n2, r2
        V.loc[falta & ~np.isnan(med), "rx"] = 1
    area = V["a"].to_numpy()
    V["re"], V["rlo"], V["rhi"] = med * area, p25 * area, p75 * area
    V["rn"] = np.where(np.isnan(med), 0, n)
    V["rr"] = radio
    V["rc"] = [[int(j) for j in fila[:6] if j >= 0] if ok else [] for fila, ok in zip(idx, ~np.isnan(med))]

    # --- Escenario por unidades (casas): arriendo/m² de unidades pequeñas ---
    casas = (V["t"] == 1).to_numpy()
    iu, du = vecinos(V[casas], R, rm2, K_ARRIENDO, 2000, lambda t, tr: tr != 1, area_max=AREA_UNIDAD)
    mu, *_ = resumen(iu, du, rm2, MIN_ARRIENDO)
    V["ru"] = np.nan
    V.loc[casas, "ru"] = mu

    # --- Precio/m² frente a ventas comparables -----------------------------
    V["vm"], V["vn"] = np.nan, 0
    vm2 = V["m2"].to_numpy(np.float32)
    for t in (0, 1):
        m = (V["t"] == t).to_numpy()
        sub = V[m].reset_index(drop=True)
        iv, dv = vecinos(sub, sub, vm2[m], K_VENTA, R_VENTA, cualquiera, misma_tabla=True)
        mv, _, _, nv, _ = resumen(iv, dv, vm2[m], MIN_VENTA)
        V.loc[m, "vm"], V.loc[m, "vn"] = mv, np.where(np.isnan(mv), 0, nv)

    yb = V["re"] * 12 / V["precio"]
    print(f"con arriendo estimado: {V['re'].notna().mean():.1%} | rentabilidad bruta mediana "
          f"{yb.median():.2%} (p10 {yb.quantile(.1):.2%}, p90 {yb.quantile(.9):.2%}) | >=10%: {(yb >= .10).sum()}")

    def comunes(df):
        return {
            "id": col(df["id"]), "t": col(df["t"]), "p": col(df["precio"], 0), "a": col(df["a"], 1),
            "c": col(df["c"], 0), "b": col(df["b"], 0), "g": col(df["g"], 0), "e": col(df["e"], 0),
            "ad": col(df["ad"], 0), "lat": col(df["lat"], 5), "lon": col(df["lon"], 5),
            "loc": col(df["loc"]), "ba": col(df["barrio_comun"].fillna(df["barrio"]).str.title()),
            "ap": col(df["ap"]), "link": col(df["link"]),
        }

    salida = {
        "meta": {
            "fecha": snap.name, "fuente": "metrocuadrado.com",
            "localidades": [f["properties"]["name"] for f in geo["features"]],
            "ventas": info_v, "arriendos": info_r,
            "parametros": {"k_arriendo": K_ARRIENDO, "radio_arriendo_m": R_ARRIENDO, "min_arriendo": MIN_ARRIENDO,
                           "k_venta": K_VENTA, "radio_venta_m": R_VENTA, "area_ratio": AREA_RATIO,
                           "area_unidad_m2": AREA_UNIDAD},
        },
        "ventas": {
            **comunes(V), "nu": col(V["nu"]), "img": col(V["imagen"].str.replace("https://multimedia.metrocuadrado.com/", "", regex=False)), "wa": col(V["whatsapp"].astype(str).str.replace(r"\D", "", regex=True).replace("", None)),
            "re": col(V["re"], -3), "rlo": col(V["rlo"], -3), "rhi": col(V["rhi"], -3),
            "rn": col(V["rn"], 0), "rr": col(V["rr"], -1), "rx": col(V["rx"]), "rc": V["rc"].tolist(),
            "ru": col(V["ru"], -2), "vm": col(V["vm"], -3), "vn": col(V["vn"], 0),
        },
        "arriendos": comunes(R),
    }
    for k in ("re", "rlo", "rhi", "rr", "ru", "vm"):
        salida["ventas"][k] = [None if v is None else int(v) for v in salida["ventas"][k]]
    Path(a.out).write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")))
    print(f"{a.out}: {len(V)} ventas, {len(R)} arriendos, {Path(a.out).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
