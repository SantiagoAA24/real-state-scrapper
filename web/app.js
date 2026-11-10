/* Radar inmobiliario · Bogotá — todo el cálculo ocurre en el navegador. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const URL_MC = 'https://www.metrocuadrado.com';
const TIPOS = ['Apartamento', 'Casa', 'Apartaestudio'];

// ---------- Formato ----------
const nf = (d = 0) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: d, minimumFractionDigits: d });
const fM = v => v == null || isNaN(v) ? '—' : v >= 1e9 ? `$${nf(2).format(v / 1e9)} MM` : `$${nf(v < 1e7 ? 2 : 0).format(v / 1e6)} M`;
const fPct = (v, d = 1) => v == null || isNaN(v) ? '—' : `${nf(d).format(v)} %`;
const fSig = v => v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${nf(0).format(v)} %`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mediana = a => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const cuantil = (ord, q) => ord.length ? ord[Math.min(ord.length - 1, Math.floor(q * ord.length))] : NaN;

// ---------- Estado persistente ----------
const guardar = (k, v) => { try { localStorage.setItem('radar.' + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } };
const leer = (k, d) => { try { return JSON.parse(localStorage.getItem('radar.' + k)) ?? d; } catch (e) { return d; } };

const S = Object.assign({
  modo: 'bruta', vac: 1, pred: 0.5, otros: 0, admin: true, desc: 0, unid: false, efic: 75, cdt: 9,
  metrica: 'y', escala: 'abs',
}, leer('supuestos', {}));
const FAV = leer('favoritos', {});   // id -> {estado, nota}
let ZONAS = leer('zonas', []);        // [{nombre, tipo, anillo|locs}]
const SIM = Object.assign({ ini: 30, tasa: 11.5, plazo: 15 }, leer('credito', {}));

// ---------- Datos ----------
let V, R, META, N, LOCS;
let Y, RENT, DZ, M2, CONF;            // derivados por inmueble en venta
let visibles = [], seleccion = [];    // índices
let region = null;                    // {tipo:'poli', anillo:[[lon,lat]...]} | {tipo:'loc', locs:[i...]}
let herramienta = 'mover', foco = null, orden = 'y';
let map, popup, finDibujo = 0;

const PALETA = {
  y: { cortes: [5, 6.5, 8, 10, 13], colores: ['#8e1b1b', '#d9480f', '#f08c00', '#f2c037', '#2f9e44', '#14622d'], fmt: v => nf(1).format(v) + '%' },
  dz: { cortes: [-20, -10, 0, 10, 20], colores: ['#14622d', '#2f9e44', '#f2c037', '#f08c00', '#d9480f', '#8e1b1b'], fmt: v => (v > 0 ? '+' : '') + nf(0).format(v) + '%' },
  m2: { cortes: [3, 5, 7, 9, 12], colores: ['#deebf7', '#9ecae1', '#6baed6', '#3182bd', '#08519c', '#08306b'], fmt: v => nf(1).format(v) + ' M' },
};
let cortes = PALETA.y.cortes;
const valor = i => S.metrica === 'y' ? Y[i] : S.metrica === 'dz' ? DZ[i] : M2[i];
const color = v => { if (isNaN(v)) return '#b8b6ae'; const c = PALETA[S.metrica].colores; let k = 0; while (k < cortes.length && v >= cortes[k]) k++; return c[k]; };
const colorY = y => { if (isNaN(y)) return '#b8b6ae'; const p = PALETA.y; let k = 0; while (k < p.cortes.length && y >= p.cortes[k]) k++; return p.colores[k]; };

function derivar() {
  const d = 1 - S.desc / 100;
  for (let i = 0; i < N; i++) {
    const precio = V.p[i] * d;
    let renta = V.re[i];
    if (S.unid && V.t[i] === 1 && V.ru[i] != null) renta = V.ru[i] * V.a[i] * S.efic / 100;
    RENT[i] = renta ?? NaN;
    if (renta == null) { Y[i] = NaN; } else if (S.modo === 'bruta') { Y[i] = renta * 12 / precio * 100; } else {
      const ingreso = renta * (12 - S.vac) * (1 - S.otros / 100);
      const gastos = (S.admin ? (V.ad[i] || 0) * 12 : 0) + S.pred / 100 * precio;
      Y[i] = (ingreso - gastos) / precio * 100;
    }
    M2[i] = precio / V.a[i] / 1e6;
    DZ[i] = V.vm[i] ? (precio / V.a[i] / V.vm[i] - 1) * 100 : NaN;
  }
}

function filtrar() {
  const tipos = new Set($$('#f-tipo input:checked').map(e => +e.value));
  const estr = new Set($$('#f-estrato input:checked').map(e => +e.value));
  const num = id => { const v = parseFloat($(id).value); return isNaN(v) ? null : v; };
  const pmin = num('#f-pmin'), pmax = num('#f-pmax'), amin = num('#f-amin'), amax = num('#f-amax');
  const cmin = +$('#f-cmin').value, ymin = +$('#f-ymin').value, dzmax = +$('#f-dz').value;
  const conf = $('#f-conf').checked, nuevo = $('#f-nuevo').checked, fav = $('#f-fav').checked;
  $('#o-ymin').textContent = ymin ? `≥ ${nf(1).format(ymin)} %` : 'sin mínimo';
  $('#o-dz').textContent = dzmax >= 40 ? 'sin límite' : `≤ ${fSig(dzmax)}`;
  visibles = [];
  for (let i = 0; i < N; i++) {
    if (!tipos.has(V.t[i]) || !estr.has(V.e[i] ?? 0)) continue;
    const pm = V.p[i] / 1e6;
    if ((pmin != null && pm < pmin) || (pmax != null && pm > pmax)) continue;
    if ((amin != null && V.a[i] < amin) || (amax != null && V.a[i] > amax)) continue;
    if (cmin && !(V.c[i] >= cmin)) continue;
    if (ymin && !(Y[i] >= ymin)) continue;
    if (dzmax < 40 && !(DZ[i] <= dzmax)) continue;
    if (conf && CONF[i] === 0) continue;
    if (nuevo && V.nu[i]) continue;
    if (fav && !FAV[V.id[i]]) continue;
    visibles.push(i);
  }
}

function enAnillo(x, y, an) {
  let d = false;
  for (let i = 0, j = an.length - 1; i < an.length; j = i++) {
    const [xi, yi] = an[i], [xj, yj] = an[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) d = !d;
  }
  return d;
}

function seleccionar() {
  if (!region) seleccion = visibles;
  else if (region.tipo === 'loc') { const s = new Set(region.locs); seleccion = visibles.filter(i => s.has(V.loc[i])); }
  else {
    const an = region.anillo; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of an) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    seleccion = visibles.filter(i => { const x = V.lon[i], y = V.lat[i]; return x >= x0 && x <= x1 && y >= y0 && y <= y1 && enAnillo(x, y, an); });
  }
}

// ---------- Mapa ----------
const fc = features => ({ type: 'FeatureCollection', features });
const punto = (lon, lat, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });

function iniciarMapa(geoLoc) {
  map = new maplibregl.Map({
    container: 'mapa', center: [-74.085, 4.66], zoom: 11.1, minZoom: 9.5, maxZoom: 18, attributionControl: { compact: true },
    style: {
      version: 8,
      sources: { base: { type: 'raster', tileSize: 256, tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Datos: metrocuadrado.com' } },
      layers: [{ id: 'fondo', type: 'background', paint: { 'background-color': '#f6f5f1' } },
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-saturation': -0.9, 'raster-opacity': 0.7, 'raster-contrast': -0.1 } }],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
  return new Promise(ok => map.on('load', () => {
    const vacio = fc([]);
    for (const id of ['hex', 'loc', 'arr', 'pts', 'region', 'comps', 'foco']) map.addSource(id, { type: 'geojson', data: id === 'loc' ? geoLoc : vacio });
    map.addLayer({ id: 'loc-fill', type: 'fill', source: 'loc', paint: { 'fill-color': ['coalesce', ['get', 'col'], 'rgba(0,0,0,0)'], 'fill-opacity': 0.45 }, layout: { visibility: 'none' } });
    map.addLayer({ id: 'hex', type: 'fill', source: 'hex', paint: { 'fill-color': ['get', 'col'], 'fill-opacity': 0.7 }, layout: { visibility: 'none' } });
    map.addLayer({ id: 'loc-line', type: 'line', source: 'loc', paint: { 'line-color': '#1d2433', 'line-width': ['case', ['boolean', ['get', 'sel'], false], 2.5, 0.7], 'line-opacity': ['case', ['boolean', ['get', 'sel'], false], 0.9, 0.35] } });
    map.addLayer({ id: 'arr', type: 'circle', source: 'arr', layout: { visibility: 'none' }, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 15, 4], 'circle-color': '#5f3dc4', 'circle-opacity': 0.55 } });
    map.addLayer({ id: 'pts', type: 'circle', source: 'pts', layout: { 'circle-sort-key': ['get', 'o'] }, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.2, 13, 4, 16, 8],
      'circle-color': ['get', 'col'],
      'circle-opacity': ['case', ['==', ['get', 's'], 0], 0.1, ['==', ['get', 'cf'], 0], 0.45, 0.88],
      'circle-stroke-width': ['case', ['==', ['get', 'f'], 1], 2, ['==', ['get', 's'], 0], 0, 0.5],
      'circle-stroke-color': ['case', ['==', ['get', 'f'], 1], '#1d2433', '#ffffff'],
      'circle-stroke-opacity': ['case', ['==', ['get', 's'], 0], 0.3, 0.9] } });
    map.addLayer({ id: 'region-fill', type: 'fill', source: 'region', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#1f4e79', 'fill-opacity': 0.06 } });
    map.addLayer({ id: 'region-line', type: 'line', source: 'region', paint: { 'line-color': '#1f4e79', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    map.addLayer({ id: 'comps', type: 'circle', source: 'comps', paint: { 'circle-radius': 6, 'circle-color': '#5f3dc4', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
    map.addLayer({ id: 'foco', type: 'circle', source: 'foco', paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#1d2433', 'circle-stroke-width': 3 } });

    map.on('mousemove', 'pts', e => {
      if (herramienta === 'lazo' || herramienta === 'radio') return;
      const i = e.features[0].properties.i;
      map.getCanvas().style.cursor = 'pointer';
      popup.setLngLat([V.lon[i], V.lat[i]]).setHTML(`<b>${fPct(Y[i])}</b> · ${fM(V.p[i])} · ${nf(0).format(V.a[i])} m²<br><span style="color:#667085">${esc(V.ba[i] || '')}</span>`).addTo(map);
    });
    map.on('mouseleave', 'pts', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
    map.on('mousemove', 'comps', e => { const j = e.features[0].properties.j; popup.setLngLat([R.lon[j], R.lat[j]]).setHTML(`Arriendo <b>${fM(R.p[j])}</b> · ${nf(0).format(R.a[j])} m²`).addTo(map); });
    map.on('mouseleave', 'comps', () => popup.remove());
    map.on('click', e => {
      if (herramienta === 'lazo' || herramienta === 'radio' || Date.now() - finDibujo < 400) return;
      const f = map.queryRenderedFeatures(e.point, { layers: ['pts'] })[0];
      if (f) return abrir(f.properties.i, false);
      if (herramienta === 'loc') {
        const k = LOCS.findIndex(g => g.anillos.some(a => enAnillo(e.lngLat.lng, e.lngLat.lat, a)));
        if (k < 0) return;
        const locs = region?.tipo === 'loc' ? [...region.locs] : [];
        const p = locs.indexOf(k); p >= 0 ? locs.splice(p, 1) : locs.push(k);
        region = locs.length ? { tipo: 'loc', locs } : null;
        refrescar();
      }
    });
    dibujo();
    ok();
  }));
}

/** Lazo a mano alzada y círculo por radio. */
function dibujo() {
  let trazo = null, centro = null;
  const cv = map.getCanvasContainer();
  const ll = e => { const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; const p = map.unproject([t.clientX - r.left, t.clientY - r.top]); return [p.lng, p.lat]; };
  const circulo = (c, b) => {
    const k = Math.cos(c[1] * Math.PI / 180), r = Math.hypot((b[0] - c[0]) * k, b[1] - c[1]);
    const an = []; for (let a = 0; a <= 64; a++) { const t = a / 64 * 2 * Math.PI; an.push([c[0] + r * Math.cos(t) / k, c[1] + r * Math.sin(t)]); }
    return { an, metros: r * 111320 };
  };
  const inicio = e => {
    if (herramienta !== 'lazo' && herramienta !== 'radio') return;
    if (e.button) return;
    e.preventDefault();
    if (herramienta === 'lazo') trazo = [ll(e)]; else centro = ll(e);
  };
  const mover = e => {
    if (trazo) {
      trazo.push(ll(e));
      map.getSource('region').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: trazo }, properties: {} });
    } else if (centro) {
      const c = circulo(centro, ll(e));
      map.getSource('region').setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [c.an] }, properties: {} });
      $('#pista').textContent = `Radio: ${nf(0).format(c.metros)} m`;
    }
  };
  const fin = e => {
    let an = null, etiqueta = 'Lazo';
    if (trazo && trazo.length > 3) an = [...trazo, trazo[0]];
    if (centro && e) { const c = circulo(centro, ll(e.changedTouches ? { touches: e.changedTouches } : e)); if (c.metros > 30) { an = c.an; etiqueta = `Radio de ${nf(0).format(c.metros)} m`; } }
    const activo = trazo || centro; trazo = centro = null;
    if (!activo) return;
    finDibujo = Date.now();
    if (an) { region = { tipo: 'poli', anillo: an, etiqueta }; usar('mover'); }
    refrescar();
  };
  cv.addEventListener('mousedown', inicio); cv.addEventListener('touchstart', inicio, { passive: false });
  window.addEventListener('mousemove', mover); cv.addEventListener('touchmove', e => { if (trazo || centro) { e.preventDefault(); mover(e); } }, { passive: false });
  window.addEventListener('mouseup', fin); cv.addEventListener('touchend', fin);
}

function usar(t) {
  herramienta = t;
  $$('#herramientas [data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const dib = t === 'lazo' || t === 'radio';
  $('main').classList.toggle('dibujando', dib);
  map.dragPan[dib ? 'disable' : 'enable'](); map.touchZoomRotate[dib ? 'disable' : 'enable']();
  $('#pista').textContent = { lazo: 'Mantén presionado y dibuja alrededor de la zona', radio: 'Clic en el centro y arrastra hasta el radio deseado', loc: 'Clic sobre las localidades que quieras sumar o quitar' }[t] || '';
}

function hexagonos(indices) {
  const s = 320, R0 = 6371000, k = Math.cos(4.65 * Math.PI / 180), rad = Math.PI / 180, q3 = Math.sqrt(3);
  const celdas = new Map();
  for (const i of indices) {
    const v = valor(i); if (isNaN(v)) continue;
    const x = V.lon[i] * rad * R0 * k, y = V.lat[i] * rad * R0;
    let q = (q3 / 3 * x - y / 3) / s, r = (2 / 3 * y) / s, z = -q - r;
    let rq = Math.round(q), rr = Math.round(r), rz = Math.round(z);
    const dq = Math.abs(rq - q), dr = Math.abs(rr - r), dzz = Math.abs(rz - z);
    if (dq > dr && dq > dzz) rq = -rr - rz; else if (dr > dzz) rr = -rq - rz;
    const key = rq + ',' + rr;
    (celdas.get(key) || celdas.set(key, []).get(key)).push(v);
  }
  const out = [];
  for (const [key, vals] of celdas) {
    if (vals.length < 3) continue;
    const [q, r] = key.split(',').map(Number), cx = s * q3 * (q + r / 2), cy = s * 1.5 * r, an = [];
    for (let a = 0; a < 7; a++) { const t = (60 * a + 30) * rad; an.push([(cx + s * Math.cos(t)) / (R0 * k * rad), (cy + s * Math.sin(t)) / (R0 * rad)]); }
    const m = mediana(vals);
    out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [an] }, properties: { col: color(m), v: m, n: vals.length } });
  }
  return fc(out);
}

function pintar() {
  // Cortes de color
  const P = PALETA[S.metrica];
  if (S.escala === 'rel') {
    const ord = Float64Array.from(seleccion.map(valor).filter(v => !isNaN(v))).sort();
    cortes = [0.1, 0.3, 0.5, 0.7, 0.9].map(q => cuantil(ord, q));
    if (!ord.length) cortes = P.cortes;
  } else cortes = P.cortes;
  $('#leyenda').innerHTML = `<div class="barra" style="background:linear-gradient(90deg,${P.colores.map((c, k) => `${c} ${k / 6 * 100}% ${(k + 1) / 6 * 100}%`).join(',')})"></div>
    <div class="ticks"><span></span>${cortes.map(c => `<span>${P.fmt(c)}</span>`).join('')}<span></span></div>`;

  const enSel = new Uint8Array(N); for (const i of seleccion) enSel[i] = 1;
  const hayRegion = !!region;
  const feats = visibles.map(i => { const v = valor(i); return punto(V.lon[i], V.lat[i], { i, col: color(v), s: hayRegion ? enSel[i] : 1, cf: CONF[i], f: FAV[V.id[i]] ? 1 : 0, o: (isNaN(v) ? -1e9 : S.metrica === 'y' ? v : -v) + (enSel[i] ? 1e6 : 0) }); });
  map.getSource('pts').setData(fc(feats));
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  vis('pts', $('#c-puntos').checked); vis('hex', $('#c-hex').checked); vis('loc-fill', $('#c-loc').checked); vis('arr', $('#c-arr').checked);
  if ($('#c-hex').checked) map.getSource('hex').setData(hexagonos(visibles));
  // Localidades
  const porLoc = LOCS.map(() => []);
  for (const i of visibles) { const l = V.loc[i]; if (l >= 0) { const v = valor(i); if (!isNaN(v)) porLoc[l].push(v); } }
  const selLoc = new Set(region?.tipo === 'loc' ? region.locs : []);
  map.getSource('loc').setData(fc(LOCS.map((g, k) => ({ ...g.f, properties: { name: g.nombre, sel: selLoc.has(k), col: porLoc[k].length >= 5 ? color(mediana(porLoc[k])) : null } }))));
  map.getSource('region').setData(region?.tipo === 'poli' ? { type: 'Feature', geometry: { type: 'Polygon', coordinates: [region.anillo] }, properties: {} } : fc([]));
}

// ---------- Panel ----------
function histograma(vals) {
  const lo = 2, hi = 16, nb = 28, w = (hi - lo) / nb, bins = new Array(nb).fill(0);
  for (const v of vals) if (!isNaN(v)) bins[Math.max(0, Math.min(nb - 1, Math.floor((v - lo) / w)))]++;
  const mx = Math.max(1, ...bins), W = 352, H = 96, bw = W / nb;
  const x = v => (v - lo) / (hi - lo) * W;
  return `<svg class="hist" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Distribución de rentabilidad">
    ${bins.map((b, k) => `<rect x="${k * bw + 0.5}" y="${78 - b / mx * 74}" width="${bw - 1}" height="${b / mx * 74}" fill="${colorY(lo + (k + 0.5) * w)}"><title>${nf(1).format(lo + k * w)}–${nf(1).format(lo + (k + 1) * w)} %: ${b}</title></rect>`).join('')}
    <line x1="${x(S.cdt)}" x2="${x(S.cdt)}" y1="0" y2="78" stroke="#1d2433" stroke-dasharray="3 2"/>
    <text x="${x(S.cdt) + 3}" y="9" font-size="9" fill="#1d2433">ref. ${nf(1).format(S.cdt)} %</text>
    ${[4, 6, 8, 10, 12, 14].map(t => `<text x="${x(t)}" y="92" font-size="9" fill="#667085" text-anchor="middle">${t}%</text>`).join('')}</svg>`;
}

function resumen() {
  const n = seleccion.length;
  const titulo = !region ? 'Toda Bogotá' : region.tipo === 'loc' ? region.locs.map(k => LOCS[k].nombre).join(', ') : (region.etiqueta || 'Zona dibujada');
  const ys = seleccion.map(i => Y[i]).filter(v => !isNaN(v));
  const sobre = ys.filter(v => v >= 10).length, sobreRef = ys.filter(v => v >= S.cdt).length;
  const med = f => mediana(seleccion.map(f).filter(v => v != null && !isNaN(v)));
  const key = { y: i => -Y[i], dz: i => DZ[i], p: i => V.p[i], m2: i => M2[i] }[orden];
  const top = seleccion.filter(i => !isNaN(key(i))).sort((a, b) => key(a) - key(b)).slice(0, 60);
  // Composición por tipo/localidad
  const grupos = new Map();
  for (const i of seleccion) { const g = region?.tipo === 'loc' && region.locs.length === 1 ? (V.ba[i] || 'Sin barrio') : (LOCS[V.loc[i]]?.nombre || 'Fuera del perímetro'); (grupos.get(g) || grupos.set(g, []).get(g)).push(Y[i]); }
  const filas = [...grupos].map(([g, a]) => [g, a.length, mediana(a.filter(v => !isNaN(v)))]).filter(r => r[1] >= 5 && !isNaN(r[2])).sort((a, b) => b[2] - a[2]).slice(0, 8);

  $('#resumen').innerHTML = `<section>
    <h3>${esc(titulo)}</h3>
    <div class="sub">${nf().format(n)} inmuebles en venta con los filtros actuales · rentabilidad ${S.modo}${S.desc ? `, con ${S.desc} % de descuento` : ''}</div>
    <div class="kpis">
      <div class="kpi"><span>Rentabilidad mediana</span><b style="color:${colorY(mediana(ys))}">${fPct(mediana(ys))}</b><small>${fSig((mediana(ys) - S.cdt) * 1).replace(' %', ' pp')} vs. referencia</small></div>
      <div class="kpi"><span>Con ≥ 10 % anual</span><b>${nf().format(sobre)}</b><small>${ys.length ? fPct(sobre / ys.length * 100, 0) : '—'} · ${nf().format(sobreRef)} superan la referencia</small></div>
      <div class="kpi"><span>Precio mediano</span><b>${fM(med(i => V.p[i] * (1 - S.desc / 100)))}</b><small>${fM(med(i => M2[i] * 1e6))} por m²</small></div>
      <div class="kpi"><span>Arriendo estimado</span><b>${fM(med(i => RENT[i]))}</b><small>$${nf(0).format(med(i => RENT[i] / V.a[i]) / 1e3)} mil por m²</small></div>
    </div>
    ${histograma(ys)}
    ${filas.length > 1 ? `<div class="barras">${filas.map(([g, c, m]) => `<div><span title="${esc(g)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g)}</span><i style="width:${Math.min(100, m / 14 * 100)}%;background:${colorY(m)}"></i><b>${fPct(m)}</b></div>`).join('')}</div>` : ''}
  </section>
  <section>
    <div class="acciones">
      <select id="orden"><option value="y">Mayor rentabilidad</option><option value="dz">Más barato frente a su zona</option><option value="m2">Menor precio por m²</option><option value="p">Menor precio</option></select>
      <button class="sec" id="csv" title="Descargar la selección">CSV</button>
    </div>
    ${top.length ? `<table><thead><tr><th>Rent.</th><th>Precio</th><th>m²</th><th>vs. zona</th><th>Ubicación</th></tr></thead><tbody>
    ${top.map(i => `<tr data-i="${i}"><td><span class="pill" style="background:${colorY(Y[i])}">${fPct(Y[i])}</span><span class="conf c${CONF[i]}" title="Confianza ${['baja', 'media', 'alta'][CONF[i]]}"></span></td>
      <td>${fM(V.p[i])}</td><td>${nf(0).format(V.a[i])}</td><td class="${DZ[i] < 0 ? 'neg' : 'pos'}">${fSig(DZ[i])}${DZ[i] < -45 ? ' <span title="Precio por m² muy por debajo de la zona: verifica área y estado">⚠</span>' : ''}</td>
      <td class="lugar">${FAV[V.id[i]] ? '★ ' : ''}${V.t[i] ? 'Casa' : 'Apto'} · ${esc(V.ba[i] || '')}</td></tr>`).join('')}
    </tbody></table>` : '<div class="vacio">Ningún inmueble cumple los filtros en esta zona.</div>'}
  </section>`;
  $('#orden').value = orden;
  $('#orden').onchange = e => { orden = e.target.value; resumen(); };
  $('#csv').onclick = exportar;
  $$('#resumen tbody tr').forEach(tr => tr.onclick = () => abrir(+tr.dataset.i, true));
}

function abrir(i, volar) {
  foco = i;
  const id = V.id[i], fav = FAV[id], precio = V.p[i] * (1 - S.desc / 100), renta = RENT[i];
  const bruta = renta * 12 / precio * 100;
  const ingreso = renta * (12 - S.vac) * (1 - S.otros / 100), gAdmin = S.admin ? (V.ad[i] || 0) * 12 : 0, gPred = S.pred / 100 * precio;
  const neta = (ingreso - gAdmin - gPred) / precio * 100;
  const comps = V.rc[i] || [];
  const unid = S.unid && V.t[i] === 1 && V.ru[i] != null;
  const avisos = [];
  if (V.re[i] == null) avisos.push('No hay suficientes arriendos comparables cerca para estimar la renta.');
  else if (CONF[i] === 0) avisos.push(`Estimación de baja confianza: ${V.rn[i]} comparables en un radio de ${nf(0).format(V.rr[i])} m.`);
  if (V.rx[i]) avisos.push('Se usaron arriendos de otro tipo de inmueble por falta de comparables del mismo tipo.');
  if (V.ap[i]) avisos.push('El anuncio marca la ubicación como aproximada.');
  if (V.nu[i]) avisos.push('Proyecto nuevo o sobre planos: el precio suele ser “desde”.');
  if (unid) avisos.push(`Escenario por unidades: ${S.efic} % del área arrendada al valor por m² de unidades pequeñas cercanas.`);
  if (DZ[i] < -45) avisos.push('El precio por m² está muy por debajo de las ventas cercanas: suele indicar un área mal reportada, un lote o un inmueble para remodelar. Verifícalo antes de confiar en la rentabilidad.');
  if (V.a[i] > 300 && !unid) avisos.push('Inmueble muy grande: el arriendo por m² de los comparables tiende a sobreestimar la renta.');

  $('#detalle').hidden = false; $('#resumen').hidden = true;
  $('#detalle').innerHTML = `
    <div class="cerrar"><button class="sec" id="volver">← Volver a la selección</button><button class="estrella ${fav ? 'on' : ''}" id="fav" title="Favorito">★</button></div>
    ${V.img[i] ? `<img class="foto" src="${esc(V.img[i])}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <section>
      <h3>${TIPOS[V.t[i]]} · ${esc(V.ba[i] || 'Bogotá')}</h3>
      <div class="sub">${LOCS[V.loc[i]]?.nombre || ''} · ${nf(0).format(V.a[i])} m² · ${V.c[i] ?? '—'} hab. · ${V.b[i] ?? '—'} baños · ${V.g[i] ?? 0} garajes · estrato ${V.e[i] ?? '—'}</div>
      <div class="kpis">
        <div class="kpi"><span>Rentabilidad bruta</span><b style="color:${colorY(bruta)}">${fPct(bruta)}</b><small>neta ${fPct(neta)}</small></div>
        <div class="kpi"><span>Precio${S.desc ? ` (−${S.desc} %)` : ''}</span><b>${fM(precio)}</b><small>${fM(precio / V.a[i])} por m² · <span class="${DZ[i] < 0 ? 'neg' : 'pos'}">${fSig(DZ[i])} vs. zona</span></small></div>
      </div>
      ${avisos.map(a => `<div class="aviso">${esc(a)}</div>`).join('')}
      <div class="links">
        <a href="${URL_MC}${esc(V.link[i])}" target="_blank" rel="noopener">Ver anuncio</a>
        ${V.wa[i] ? `<a href="https://wa.me/${esc(V.wa[i])}?text=${encodeURIComponent('Hola, me interesa el inmueble ' + id + ' publicado en Metrocuadrado.')}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        <a href="https://www.google.com/maps?q=${V.lat[i]},${V.lon[i]}" target="_blank" rel="noopener">Google Maps</a>
        <a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${V.lat[i]},${V.lon[i]}" target="_blank" rel="noopener">Street View</a>
      </div>
    </section>
    <section>
      <h2>Arriendo y flujo anual</h2>
      <dl class="dl">
        <dt>Arriendo mensual estimado${unid ? ' (por unidades)' : ''}</dt><dd>${fM(renta)}</dd>
        ${!unid && V.rlo[i] != null ? `<dt>Rango de los comparables (p25–p75)</dt><dd>${fM(V.rlo[i])} – ${fM(V.rhi[i])}</dd>` : ''}
        <dt>Comparables usados</dt><dd>${V.rn[i]} en ${V.rr[i] != null ? nf(0).format(V.rr[i]) + ' m' : '—'} <span class="conf c${CONF[i]}"></span></dd>
        <dt>Ingreso anual (${nf(1).format(12 - S.vac)} meses${S.otros ? `, −${S.otros} %` : ''})</dt><dd>${fM(ingreso)}</dd>
        <dt>Administración ${V.ad[i] ? `(${fM(V.ad[i])}/mes)` : '(no informada)'}</dt><dd>${S.admin ? '−' + fM(gAdmin) : 'la paga el inquilino'}</dd>
        <dt>Predial (${S.pred} %)</dt><dd>−${fM(gPred)}</dd>
        <dt class="tot">Flujo neto anual</dt><dd class="tot">${fM(ingreso - gAdmin - gPred)} · ${fPct(neta)}</dd>
        <dt>Mismo capital a ${nf(1).format(S.cdt)} % (referencia)</dt><dd>${fM(precio * S.cdt / 100)}</dd>
      </dl>
    </section>
    <section>
      <h2>Con crédito</h2>
      <div class="sim">
        <label>Cuota inicial % <input type="number" id="m-ini" min="10" max="100" step="5" value="${SIM.ini}"></label>
        <label>Tasa % E.A. <input type="number" id="m-tasa" min="0" max="30" step="0.1" value="${SIM.tasa}"></label>
        <label>Plazo (años) <input type="number" id="m-plazo" min="1" max="30" value="${SIM.plazo}"></label>
      </div>
      <dl class="dl" id="m-out"></dl>
    </section>
    ${comps.length ? `<section><h2>Arriendos comparables más cercanos</h2><table><thead><tr><th>Arriendo</th><th>m²</th><th>$/m²</th><th>Hab.</th><th></th></tr></thead><tbody>
      ${comps.map(j => `<tr data-j="${j}"><td>${fM(R.p[j])}</td><td>${nf(0).format(R.a[j])}</td><td>${nf(0).format(R.p[j] / R.a[j] / 1e3)} mil</td><td>${R.c[j] ?? '—'}</td><td><a href="${URL_MC}${esc(R.link[j])}" target="_blank" rel="noopener">ver</a></td></tr>`).join('')}
      </tbody></table><div class="sub" style="margin-top:6px">Aparecen en morado sobre el mapa.</div></section>` : ''}
    <section>
      <h2>Seguimiento</h2>
      <label class="campo">Estado <select id="estado">${['', 'Por revisar', 'Contactado', 'Visitado', 'En negociación', 'Descartado'].map(e => `<option ${fav?.estado === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
      <textarea id="nota" placeholder="Notas (se guardan en este navegador)">${esc(fav?.nota || '')}</textarea>
    </section>`;

  const credito = () => {
    SIM.ini = +$('#m-ini').value; SIM.tasa = +$('#m-tasa').value; SIM.plazo = +$('#m-plazo').value; guardar('credito', SIM);
    const capital = precio * SIM.ini / 100, deuda = precio - capital, im = Math.pow(1 + SIM.tasa / 100, 1 / 12) - 1, n = SIM.plazo * 12;
    const cuota = deuda <= 0 ? 0 : im ? deuda * im / (1 - Math.pow(1 + im, -n)) : deuda / n;
    const flujo = (ingreso - gAdmin - gPred) / 12 - cuota;
    $('#m-out').innerHTML = `<dt>Capital propio</dt><dd>${fM(capital)}</dd><dt>Cuota mensual</dt><dd>${fM(cuota)}</dd>
      <dt>Flujo mensual después de cuota</dt><dd class="${flujo < 0 ? 'pos' : 'neg'}">${flujo < 0 ? '−' : ''}${fM(Math.abs(flujo))}</dd>
      <dt class="tot">Retorno sobre capital propio</dt><dd class="tot">${fPct(flujo * 12 / capital * 100)}</dd>`;
  };
  $$('#detalle .sim input').forEach(e => e.oninput = credito); credito();
  $('#volver').onclick = cerrar;
  const guardarFav = crear => {
    const estado = $('#estado').value, nota = $('#nota').value.trim();
    if (crear || estado || nota) FAV[id] = { estado, nota, fecha: META.fecha, precio: V.p[i] };
    guardar('favoritos', FAV); $('#fav').classList.toggle('on', !!FAV[id]);
  };
  $('#fav').onclick = () => { if (FAV[id]) delete FAV[id]; guardarFav(!$('#fav').classList.contains('on')); pintar(); };
  $('#estado').onchange = () => { guardarFav(false); pintar(); };
  $('#nota').onchange = () => { guardarFav(false); pintar(); };
  $$('#detalle tr[data-j]').forEach(tr => tr.onmouseenter = () => { const j = +tr.dataset.j; popup.setLngLat([R.lon[j], R.lat[j]]).setHTML(`Arriendo <b>${fM(R.p[j])}</b>`).addTo(map); });
  map.getSource('foco').setData(fc([punto(V.lon[i], V.lat[i], {})]));
  map.getSource('comps').setData(fc(comps.map(j => punto(R.lon[j], R.lat[j], { j }))));
  if (volar) map.easeTo({ center: [V.lon[i], V.lat[i]], zoom: Math.max(map.getZoom(), 14.5) });
  $('#panel').scrollTop = 0;
}

function cerrar() {
  foco = null; $('#detalle').hidden = true; $('#resumen').hidden = false;
  map.getSource('foco').setData(fc([])); map.getSource('comps').setData(fc([])); popup.remove();
  resumen();
}

function exportar() {
  const cab = ['id', 'tipo', 'localidad', 'barrio', 'precio', 'area_m2', 'habitaciones', 'banos', 'garajes', 'estrato', 'administracion', 'arriendo_estimado', 'rentabilidad_' + S.modo, 'precio_vs_zona_pct', 'comparables', 'radio_m', 'confianza', 'lat', 'lon', 'link'];
  const q = v => v == null || (typeof v === 'number' && isNaN(v)) ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const filas = seleccion.map(i => [V.id[i], TIPOS[V.t[i]], LOCS[V.loc[i]]?.nombre, V.ba[i], V.p[i], V.a[i], V.c[i], V.b[i], V.g[i], V.e[i], V.ad[i], Math.round(RENT[i]) || null, Y[i].toFixed(2), DZ[i].toFixed(1), V.rn[i], V.rr[i], ['baja', 'media', 'alta'][CONF[i]], V.lat[i], V.lon[i], URL_MC + V.link[i]].map(q).join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + cab.join(',') + '\n' + filas.join('\n')], { type: 'text/csv' }));
  a.download = `seleccion-${META.fecha}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

function refrescar(recalcular = false) {
  if (recalcular) derivar();
  filtrar(); seleccionar(); pintar();
  if (foco != null && !$('#detalle').hidden) abrir(foco, false); else resumen();
}

// ---------- Controles ----------
function controles() {
  $('#f-estrato').innerHTML = [1, 2, 3, 4, 5, 6].map(e => `<label><input type="checkbox" value="${e}" checked> ${e}</label>`).join('') + '<input type="checkbox" value="0" checked hidden>';
  let t; const suave = f => () => { clearTimeout(t); t = setTimeout(f, 120); };
  $$('#filtros section:first-child input, #filtros section:first-child select').forEach(e => e.addEventListener('input', suave(() => refrescar())));

  const seg = (id, k) => { const pon = () => $$(`${id} button`).forEach(b => b.classList.toggle('on', b.dataset.v === S[k])); $$(`${id} button`).forEach(b => b.onclick = () => { S[k] = b.dataset.v; pon(); cambio(); }); pon(); };
  const cambio = () => { guardar('supuestos', S); $('#s-neta').hidden = S.modo !== 'neta'; $('#s-efic-w').hidden = !S.unid; refrescar(true); };
  seg('#s-modo', 'modo'); seg('#c-escala', 'escala');
  for (const [id, k] of [['#s-vac', 'vac'], ['#s-pred', 'pred'], ['#s-otros', 'otros'], ['#s-desc', 'desc'], ['#s-efic', 'efic'], ['#s-cdt', 'cdt']]) {
    $(id).value = S[k]; $(id).addEventListener('input', suave(() => { const v = parseFloat($(id).value); if (!isNaN(v)) { S[k] = v; cambio(); } }));
  }
  for (const [id, k] of [['#s-admin', 'admin'], ['#s-unid', 'unid']]) { $(id).checked = S[k]; $(id).onchange = () => { S[k] = $(id).checked; cambio(); }; }
  $('#c-metrica').value = S.metrica; $('#c-metrica').onchange = e => { S.metrica = e.target.value; cambio(); };
  $$('#c-puntos, #c-hex, #c-loc, #c-arr').forEach(e => e.onchange = pintar);
  $('#s-neta').hidden = S.modo !== 'neta'; $('#s-efic-w').hidden = !S.unid;

  $$('#herramientas [data-t]').forEach(b => b.onclick = () => usar(b.dataset.t));
  $('#h-limpiar').onclick = () => { region = null; usar('mover'); refrescar(); };
  const zonas = () => { $('#h-zonas').innerHTML = '<option value="">Zonas guardadas…</option>' + ZONAS.map((z, k) => `<option value="${k}">${esc(z.nombre)}</option>`).join('') + (ZONAS.length ? '<option value="borrar">Borrar todas…</option>' : ''); };
  $('#h-guardar').onclick = () => {
    if (!region) return alert('Primero selecciona una zona con el lazo, el radio o por localidad.');
    const nombre = prompt('Nombre para esta zona:'); if (!nombre) return;
    ZONAS.push({ ...region, nombre }); guardar('zonas', ZONAS); zonas();
  };
  $('#h-zonas').onchange = e => {
    const v = e.target.value; e.target.value = '';
    if (v === 'borrar') { if (confirm('¿Borrar todas las zonas guardadas?')) { ZONAS = []; guardar('zonas', ZONAS); zonas(); } return; }
    const z = ZONAS[+v]; if (!z) return;
    region = { ...z, etiqueta: z.nombre }; refrescar();
    const an = z.tipo === 'poli' ? z.anillo : z.locs.flatMap(k => LOCS[k].anillos.flat());
    const b = an.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(an[0], an[0])); map.fitBounds(b, { padding: 60 });
  };
  zonas();
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#detalle').hidden) cerrar(); else usar('mover'); } });
}

// ---------- Arranque ----------
(async function () {
  const [datos, geo] = await Promise.all([
    fetch('data/inmuebles.json').then(r => { if (!r.ok) throw new Error('Falta web/data/inmuebles.json: ejecuta "python pipeline/build.py".'); return r.json(); }),
    fetch('data/localidades.geojson').then(r => r.json()),
  ]).catch(e => { document.body.innerHTML = `<p style="padding:24px">${esc(e.message)}</p>`; throw e; });
  V = datos.ventas; R = datos.arriendos; META = datos.meta; N = V.id.length;
  LOCS = geo.features.map(f => ({ f, nombre: f.properties.name, anillos: (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]).map(p => p[0]) }));
  Y = new Float32Array(N); RENT = new Float32Array(N); DZ = new Float32Array(N); M2 = new Float32Array(N); CONF = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const n = V.rn[i], r = V.rr[i];
    CONF[i] = V.re[i] == null ? 0 : (n >= 8 && r <= 1000 && !V.rx[i] && !V.ap[i]) ? 2 : (n >= 5 && r <= 2000) ? 1 : 0;
    if (V.img[i] && !V.img[i].startsWith('http')) V.img[i] = 'https://multimedia.metrocuadrado.com/' + V.img[i];
  }
  $('#meta').textContent = `Datos del ${META.fecha} · ${nf().format(N)} ventas · ${nf().format(R.id.length)} arriendos`;
  controles();
  await iniciarMapa(geo);
  map.getSource('arr').setData(fc(R.lon.map((x, j) => punto(x, R.lat[j], { j }))));
  usar('mover');
  refrescar(true);
  window.radar = { map, get seleccion() { return seleccion; }, get visibles() { return visibles; }, abrir, set region(r) { region = r; refrescar(); } };
})();
