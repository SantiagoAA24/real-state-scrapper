# Radar inmobiliario · Bogotá

Mapa interactivo para encontrar inmuebles en venta que parezcan buena inversión
de arriendo. Extrae los anuncios de metrocuadrado.com, estima el arriendo de
cada inmueble a partir de los arriendos publicados cerca y lo colorea según su
rentabilidad anual (verde desde 10 %).

## Uso

```bash
pip install -r requirements.txt
```

```bash
cp .env.example .env    # y pega la llave (ver abajo)
```

```bash
python scraper/metrocuadrado.py
```

```bash
./run.sh
```

El scraper tarda unos 2 minutos y deja `data/snapshots/<fecha>/venta.csv.gz` y
`arriendo.csv.gz`. `run.sh` genera `web/data/inmuebles.json` si falta y sirve el
sitio en http://localhost:8000. Tras una nueva extracción, regenera los datos con
`python pipeline/build.py`.

**Llave de la API.** El buscador de Metrocuadrado envía un encabezado
`X-Api-Key` en cada consulta a `rest-search/search`. Cópialo desde la pestaña
Red del navegador y guárdalo en `.env` como `METROCUADRADO_API_KEY=...`.

Los datos extraídos, `.env` y el JSON del mapa no se versionan: contienen
teléfonos y textos de anuncios de terceros.

## Qué hace el mapa

- **Seleccionar zonas**: lazo a mano alzada, radio alrededor de un punto o clic
  sobre una o varias localidades. Las zonas se pueden guardar.
- **Panel de la selección**: rentabilidad mediana, cuántos superan 10 % y la
  tasa de referencia (p. ej. un CDT), precio y arriendo por m², histograma y
  ranking descargable en CSV.
- **Ficha del inmueble**: arriendo estimado con su rango, los arriendos
  comparables usados (se ven en el mapa), flujo anual, simulador de crédito,
  enlaces al anuncio, WhatsApp, Google Maps y Street View, y seguimiento
  (favorito, estado, notas) guardado en el navegador.
- **Capas**: puntos, malla hexagonal y localidades, coloreadas por
  rentabilidad, precio/m² frente a la zona o precio/m².
- **Supuestos ajustables**: rentabilidad bruta o neta (vacancia, predial,
  administración, otros gastos), descuento negociado y escenario de casas
  arrendadas por unidades.

## Cómo se estima el arriendo

Para cada inmueble en venta se toman hasta 12 arriendos publicados a menos de
3 km, del mismo tipo, con área entre 0,7× y 1,43× y estrato ±1. El arriendo
estimado es la mediana de su arriendo por m² multiplicada por el área. Si hay
menos de 4 comparables del mismo tipo se usan de cualquier tipo, y si tampoco
alcanzan no se estima.

- Rentabilidad bruta = arriendo estimado × 12 / precio.
- Confianza **alta**: 8 o más comparables a menos de 1 km. **Media**: 5 o más a
  menos de 2 km. El resto es **baja** y se oculta por defecto.
- "Precio vs. zona" compara el precio por m² con la mediana de hasta 20 ventas
  similares a menos de 1,5 km.

Limitaciones: son precios de oferta, no de cierre; el arriendo por m² tiende a
sobreestimar la renta de inmuebles muy grandes; y un precio por m² muy por
debajo de la zona suele ser un área mal reportada o un inmueble para remodelar
(el mapa lo marca con ⚠).

## Estructura

| Ruta | Contenido |
| --- | --- |
| `scraper/metrocuadrado.py` | Extracción de ventas y arriendos (parte las consultas por estrato y habitaciones para superar el tope de 10.000 resultados) |
| `pipeline/build.py` | Limpieza, deduplicación, comparables y generación del JSON del mapa |
| `web/` | Sitio estático (MapLibre GL, sin paso de compilación) |
| `web/data/localidades.geojson` | Polígonos de las 19 localidades urbanas (Code for America, *click_that_hood*) |
