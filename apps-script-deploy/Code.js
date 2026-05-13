/**
 * Backend del álbum Panini Mundial 2026 — Google Apps Script Web App.
 *
 * Modelo (v2): cada lámina tiene DOS contadores:
 *   - p (pegada): 0 o 1, está en el álbum físico
 *   - s (sueltas): cuántas copias en posesión sin pegar (extras)
 *
 * Total en posesión = p + s. Estados derivados:
 *   - Faltante:  p=0, s=0
 *   - Suelta:    p=0, s>=1   (la tienes pero no la pegaste todavía)
 *   - Pegada:    p=1, s=0    (en el álbum, sin extras)
 *   - Repetida:  p=1, s>=1   (en el álbum + extras para intercambio)
 *
 * Storage split por equipo para mantener cada propiedad bajo el límite
 * de 9KB de Apps Script PropertiesService:
 *   s_intro    → {00, FWC1..FWC8}
 *   s_history  → {FWC9..FWC19}
 *   s_<CODE>   → {<CODE>-1..<CODE>-20} para cada equipo
 *
 * Las operaciones se serializan con LockService — cualquier cambio
 * concurrente queda atómico. Si dos personas hacen +1 al mismo tiempo,
 * ambos suman.
 */

const STATE_KEY_LEGACY = '__state';
const STATE_PREFIX = 's_';
const ORDEN_KEY = '__orden';
const VERSION_KEY = '__version';
const LEGACY_CLIENT_PREFIX = 'client_';
// Finanzas (Fase 3): bloque separado del estado del álbum, con su propio
// counter de versión para que cambios financieros no triggeren re-pulls
// del estado del álbum (que es mucho más pesado).
const FIN_KEY = '__finanzas';
const FIN_VERSION_KEY = '__fin_version';

/** Sirve el HTML al hacer GET de la URL del Web App. */
function doGet(e) {
  // Debug endpoint: ?action=stats devuelve los conteos reales como JSON
  if (e && e.parameter && e.parameter.action === 'stats') {
    return ContentService
      .createTextOutput(JSON.stringify(_computeStats(), null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // Dump público para la vista compartible /album/. Devuelve state + orden
  // en JSON. Sin autenticación: la URL del deployment ya es secreta y la
  // página de share no permite modificar nada (read-only).
  if (e && e.parameter && e.parameter.action === 'publica') {
    const props = PropertiesService.getScriptProperties();
    _migrateLegacyClientsIfNeeded(props);
    _migrateLegacySingleStateIfNeeded(props);
    const all = {};
    const allKeys = props.getKeys();
    for (const key of allKeys) {
      if (key.indexOf(STATE_PREFIX) !== 0) continue;
      const raw = props.getProperty(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        for (const id in parsed) all[id] = parsed[id];
      } catch (_) {}
    }
    let orden = null;
    const ordenRaw = props.getProperty(ORDEN_KEY);
    if (ordenRaw) { try { orden = JSON.parse(ordenRaw); } catch (_) {} }
    const version = parseInt(props.getProperty(VERSION_KEY) || '0', 10);
    // Incluir precios + especiales para que la vista pública pueda mostrar
    // valor de repetidas, costo de faltantes y la tabla de referencia por
    // categoría. Read-only — el endpoint sigue sin permitir mutaciones.
    let precios = {};
    let especiales = {};
    const finRaw = props.getProperty(FIN_KEY);
    if (finRaw) {
      try {
        const fin = JSON.parse(finRaw);
        if (fin && typeof fin === 'object') {
          if (fin.precios && typeof fin.precios === 'object') precios = fin.precios;
          if (fin.especiales && typeof fin.especiales === 'object') especiales = fin.especiales;
        }
      } catch (_) {}
    }
    // Soporte JSONP para evitar problemas de CORS al consumir desde
    // GitHub Pages. Si viene ?callback=fn, devolvemos JS; si no, JSON puro.
    const payload = JSON.stringify({ ok: true, version: version, state: all, orden: orden, precios: precios, especiales: especiales });
    if (e.parameter.callback) {
      const cb = String(e.parameter.callback).replace(/[^a-zA-Z0-9_$]/g, '');
      return ContentService
        .createTextOutput(cb + '(' + payload + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService
      .createTextOutput(payload)
      .setMimeType(ContentService.MimeType.JSON);
  }

  // GET de oferta por token: la app generó una oferta corta con
  // createOferta(ids) y compartió un link tipo ?o=TOKEN. La página pública
  // hace fetch a este endpoint para resolver el token a la lista de IDs.
  // Es JSONP para evitar CORS (cambios/ corre en juank4835.github.io).
  if (e && e.parameter && e.parameter.action === 'oferta' && e.parameter.token) {
    const props = PropertiesService.getScriptProperties();
    const token = String(e.parameter.token).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
    if (!token) {
      const payload = JSON.stringify({ ok: false, error: 'invalid_token' });
      if (e.parameter.callback) {
        const cb = String(e.parameter.callback).replace(/[^a-zA-Z0-9_$]/g, '');
        return ContentService.createTextOutput(cb + '(' + payload + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
      }
      return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
    }
    const raw = props.getProperty('OFERTA_' + token);
    let payload;
    if (raw) {
      try {
        const data = JSON.parse(raw);
        payload = JSON.stringify({
          ok: true,
          ids: data.ids || [],
          phone: data.phone || '',
          greeting: data.greeting || '',
          descuentos: Array.isArray(data.descuentos) ? data.descuentos : [],
          ts: data.ts || 0
        });
      } catch (_) {
        payload = JSON.stringify({ ok: false, error: 'corrupted' });
      }
    } else {
      payload = JSON.stringify({ ok: false, error: 'not_found' });
    }
    if (e.parameter.callback) {
      const cb = String(e.parameter.callback).replace(/[^a-zA-Z0-9_$]/g, '');
      return ContentService.createTextOutput(cb + '(' + payload + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
  }

  // Dump completo del estado per-item (admin). Útil para diagnóstico y
  // recuperación precisa después de un comando equivocado.
  if (e && e.parameter && e.parameter.action === 'admin-dump') {
    const props = PropertiesService.getScriptProperties();
    _migrateLegacyClientsIfNeeded(props);
    _migrateLegacySingleStateIfNeeded(props);
    const all = {};
    const allKeys = props.getKeys();
    for (const key of allKeys) {
      if (key.indexOf(STATE_PREFIX) !== 0) continue;
      const raw = props.getProperty(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        for (const id in parsed) all[id] = parsed[id];
      } catch (_) {}
    }
    return _jsonResponse({ ok: true, count: Object.keys(all).length, state: all });
  }

  // Set explícito de p,s para una lista. Formato:
  //   ?action=admin-bulk-set&items=ID:P:S,ID:P:S,...
  // Útil para restaurar estados después de correcciones.
  if (e && e.parameter && e.parameter.action === 'admin-bulk-set') {
    try {
      const raw = e.parameter.items || '';
      const tokens = raw.split(',').map(s => s.trim()).filter(Boolean);
      const ops = [];
      for (const t of tokens) {
        const m = t.match(/^([A-Z0-9-]+):(\d+):(\d+)$/i);
        if (!m) continue;
        ops.push({ id: m[1], action: 'set', p: parseInt(m[2], 10), s: parseInt(m[3], 10) });
      }
      if (ops.length === 0) return _jsonResponse({ error: 'No valid ops parsed' });
      const r = applyManyOps(ops);
      return _jsonResponse({
        ok: true,
        opsApplied: ops.length,
        version: r.version,
        valuesChanged: Object.keys(r.values || {}).length
      });
    } catch (err) {
      return _jsonResponse({ error: err.message || String(err) });
    }
  }

  // Endpoint admin para correcciones masivas vía GET (porque POST a Apps
  // Script desde curl externo es problemático con redirects). Formato:
  //   ?action=admin-bulk-inc&deltas=ID:N,ID:N,...
  // Donde N puede ser negativo (resta) o positivo. Aplica vía applyManyOps
  // con semántica `inc`. Deja un log con el batch aplicado.
  if (e && e.parameter && e.parameter.action === 'admin-bulk-inc') {
    try {
      const raw = e.parameter.deltas || '';
      const tokens = raw.split(',').map(s => s.trim()).filter(Boolean);
      const ops = [];
      for (const t of tokens) {
        const m = t.match(/^([A-Z0-9-]+):(-?\d+)$/i);
        if (!m) continue;
        const delta = parseInt(m[2], 10);
        if (delta === 0) continue;
        ops.push({ id: m[1], action: 'inc', delta: delta });
      }
      if (ops.length === 0) {
        return _jsonResponse({ error: 'No valid ops parsed', received: tokens.length });
      }
      const r = applyManyOps(ops);
      return _jsonResponse({
        ok: true,
        opsApplied: ops.length,
        version: r.version,
        valuesChanged: Object.keys(r.values || {}).length,
        sample: Object.fromEntries(Object.entries(r.values || {}).slice(0, 5))
      });
    } catch (err) {
      return _jsonResponse({ error: err.message || String(err) });
    }
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Álbum Panini Mundial 2026')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

/** Endpoint admin para correcciones masivas (deshacer registros erróneos).
 *  Recibe POST con body JSON: {action: 'admin-bulk-inc', deltas: [{id, delta}, ...]}
 *  Cada delta puede ser positivo o negativo. Aplica vía applyManyOps con
 *  semántica `inc` (resta s primero, luego p). Devuelve el resultado.
 *  Sin autenticación: la URL de deployment ya es secreta (privada al dueño).
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return _jsonResponse({ error: 'Empty body' }, 400);
    }
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'admin-bulk-inc') {
      const deltas = Array.isArray(body.deltas) ? body.deltas : [];
      const ops = deltas
        .filter(d => d && typeof d.id === 'string' && d.id)
        .map(d => ({ id: d.id, action: 'inc', delta: parseInt(d.delta, 10) || 0 }))
        .filter(op => op.delta !== 0);
      if (ops.length === 0) {
        return _jsonResponse({ error: 'No valid ops' }, 400);
      }
      const r = applyManyOps(ops);
      return _jsonResponse({
        ok: true,
        opsApplied: ops.length,
        version: r.version,
        valuesChanged: Object.keys(r.values || {}).length,
        sample: Object.fromEntries(Object.entries(r.values || {}).slice(0, 5))
      });
    }
    return _jsonResponse({ error: 'Unknown action: ' + body.action }, 400);
  } catch (err) {
    return _jsonResponse({ error: err.message || String(err) }, 500);
  }
}

function _jsonResponse(obj, statusCode) {
  // Apps Script no permite setear status code custom; devolvemos JSON con la
  // info y dejamos que el cliente revise el campo `error`/`ok`.
  return ContentService
    .createTextOutput(JSON.stringify(obj, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Calcula stats reales contra el estado almacenado. Devuelve la partición
 *  exacta del álbum + breakdown de repetidas. */
function _computeStats() {
  const props = PropertiesService.getScriptProperties();
  _migrateLegacyClientsIfNeeded(props);
  _migrateLegacySingleStateIfNeeded(props);

  // Recolectar TODO el estado de los buckets per-team
  const all = {}; // id → {p, s}
  const allKeys = props.getKeys();
  for (const key of allKeys) {
    if (key.indexOf(STATE_PREFIX) !== 0) continue;
    const raw = props.getProperty(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      for (const id in parsed) all[id] = parsed[id];
    } catch (_) {}
  }

  let pegadas = 0;
  let sueltasMonas = 0, sueltasCopias = 0;
  let faltantes = 0;
  let estrictRepMonas = 0, estrictRepCopias = 0;  // p=1 && s>=1
  let extrasMonas = 0, extrasCopias = 0;          // p+s >= 2 (broad / colaborativa)
  const perTeam = {};

  for (const id in all) {
    const v = all[id] || {p: 0, s: 0};
    const p = parseInt(v.p, 10) || 0;
    const s = parseInt(v.s, 10) || 0;
    const total = p + s;
    if (p === 1) pegadas++;
    if (p === 0 && s >= 1) { sueltasMonas++; sueltasCopias += s; }
    if (p === 0 && s === 0) faltantes++;
    if (p === 1 && s >= 1) { estrictRepMonas++; estrictRepCopias += s; }
    if (total >= 2) {
      extrasMonas++;
      extrasCopias += (total - 1);
      const dash = id.indexOf('-');
      const team = dash > 0 ? id.slice(0, dash) : (id.indexOf('FWC') === 0 ? 'INTRO/HIST' : 'OTHER');
      if (!perTeam[team]) perTeam[team] = { extrasMonas: 0, extrasCopias: 0 };
      perTeam[team].extrasMonas++;
      perTeam[team].extrasCopias += (total - 1);
    }
  }

  return {
    totalIdsConocidos: Object.keys(all).length,
    pegadas: pegadas,
    sueltasMonas: sueltasMonas,
    sueltasCopias: sueltasCopias,
    faltantesEnEstado: faltantes,
    repetidasEstrictas: { monas: estrictRepMonas, copias: estrictRepCopias },
    repetidasColaborativas: { monas: extrasMonas, copias: extrasCopias },
    perTeam: perTeam,
    notas: [
      'estrictas = solo pegadas con extras (p=1, s>=1)',
      'colaborativas = cualquier mona con copia extra (p+s>=2). Es lo que el usuario llama "repetidas"',
      'El "X rep" en cada team header en la app = extrasCopias por equipo'
    ]
  };
}

// ===== Routing de stickerId → bucket de propiedad =====

function _stateKeyForId(id) {
  if (id === '00') return STATE_PREFIX + 'intro';
  if (typeof id === 'string' && id.indexOf('FWC') === 0) {
    const num = parseInt(id.slice(3), 10);
    if (num <= 8) return STATE_PREFIX + 'intro';
    return STATE_PREFIX + 'history';
  }
  if (typeof id === 'string') {
    const dash = id.indexOf('-');
    if (dash > 0) return STATE_PREFIX + id.slice(0, dash);
  }
  return null;
}

function _readBucket(props, bucketKey) {
  const s = props.getProperty(bucketKey);
  if (!s) return {};
  try { return JSON.parse(s); } catch (e) { return {}; }
}

function _writeBucket(props, bucketKey, data) {
  if (!data || Object.keys(data).length === 0) {
    props.deleteProperty(bucketKey);
  } else {
    props.setProperty(bucketKey, JSON.stringify(data));
  }
}

function _getStickerState(props, id) {
  const bucket = _stateKeyForId(id);
  if (!bucket) return { p: 0, s: 0 };
  const data = _readBucket(props, bucket);
  const e = data[id];
  if (!e) return { p: 0, s: 0 };
  return { p: parseInt(e.p, 10) || 0, s: parseInt(e.s, 10) || 0 };
}

function _setStickerState(props, id, p, s) {
  const bucket = _stateKeyForId(id);
  if (!bucket) return;
  p = Math.max(0, Math.min(1, parseInt(p, 10) || 0));
  s = Math.max(0, parseInt(s, 10) || 0);
  const data = _readBucket(props, bucket);
  if (p === 0 && s === 0) {
    delete data[id];
  } else {
    const entry = {};
    if (p) entry.p = p;
    if (s) entry.s = s;
    data[id] = entry;
  }
  _writeBucket(props, bucket, data);
}

function _readAllState(props) {
  const all = props.getProperties();
  const state = {};
  for (const key in all) {
    if (key.indexOf(STATE_PREFIX) === 0) {
      try {
        const data = JSON.parse(all[key]);
        for (const id in data) {
          state[id] = data[id];
        }
      } catch (e) {}
    }
  }
  return state;
}

function _bumpVersion(props) {
  const v = parseInt(props.getProperty(VERSION_KEY) || '0', 10) + 1;
  props.setProperty(VERSION_KEY, String(v));
  return v;
}

// ===== Migraciones =====

function _migrateLegacyClientsIfNeeded(props) {
  const all = props.getProperties();
  if (all[STATE_KEY_LEGACY]) return false;
  const legacyKeys = Object.keys(all).filter(k => k.indexOf(LEGACY_CLIENT_PREFIX) === 0);
  if (legacyKeys.length === 0) return false;

  const merged = {};
  legacyKeys.forEach(k => {
    try {
      const cs = JSON.parse(all[k]);
      if (cs && typeof cs === 'object') {
        for (const id in cs) {
          merged[id] = (merged[id] || 0) + (parseInt(cs[id], 10) || 0);
        }
      }
    } catch (e) {}
  });
  props.setProperty(STATE_KEY_LEGACY, JSON.stringify(merged));
  legacyKeys.forEach(k => props.deleteProperty(k));
  return true;
}

/**
 * Migración del formato viejo (__state como {id: count}) al nuevo
 * formato per-equipo con {p, s}.
 *
 * IMPORTANTE: por petición explícita del usuario, todas las láminas
 * existentes se migran a SUELTAS (p=0, s=count), porque hoy ninguna
 * está pegada físicamente — solo registradas en posesión.
 */
function _migrateLegacySingleStateIfNeeded(props) {
  const oldState = props.getProperty(STATE_KEY_LEGACY);
  if (!oldState) return false;

  let data;
  try { data = JSON.parse(oldState); } catch (e) { return false; }
  if (!data || typeof data !== 'object') {
    props.deleteProperty(STATE_KEY_LEGACY);
    return false;
  }

  // Agrupar por bucket
  const bucketsToWrite = {};
  for (const id in data) {
    const count = parseInt(data[id], 10);
    if (!count || count <= 0) continue;
    const bk = _stateKeyForId(id);
    if (!bk) continue;
    if (!bucketsToWrite[bk]) bucketsToWrite[bk] = _readBucket(props, bk);
    // TODO USUARIO PIDIO: todas como sueltas (p=0)
    bucketsToWrite[bk][id] = { s: count };
  }

  for (const bk in bucketsToWrite) {
    _writeBucket(props, bk, bucketsToWrite[bk]);
  }
  props.deleteProperty(STATE_KEY_LEGACY);
  _bumpVersion(props);
  return true;
}

function _migrateIfNeeded(props) {
  _migrateLegacyClientsIfNeeded(props);
  _migrateLegacySingleStateIfNeeded(props);
}

// ===== API pública (frontend la llama via google.script.run) =====

/**
 * Pull de todo el estado. Si `sinceVersion` ya es la más reciente,
 * devuelve {unchanged: true} sin transferir el estado entero.
 * El `state` devuelto está en formato nuevo: {id: {p?, s?}}.
 */
function pullState(sinceVersion) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    _migrateIfNeeded(props);
    const all = props.getProperties();
    const currentVersion = parseInt(all[VERSION_KEY] || '0', 10);
    const finVersion = parseInt(all[FIN_VERSION_KEY] || '0', 10);
    if (sinceVersion != null && parseInt(sinceVersion, 10) >= currentVersion) {
      return { unchanged: true, version: currentVersion, finVersion: finVersion };
    }
    const state = _readAllState(props);
    let orden = null;
    if (all[ORDEN_KEY]) {
      try { orden = JSON.parse(all[ORDEN_KEY]); } catch (e) {}
    }
    return { unchanged: false, version: currentVersion, finVersion: finVersion, state: state, orden: orden };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Suma/resta un delta a una lámina con semántica nueva:
 *   - +N: agrega N copias como SUELTAS
 *   - -N: resta N copias quitando primero de sueltas, luego de pegada
 * Mantiene la firma vieja para compatibilidad con frontend en transición.
 */
function incSticker(id, delta) {
  if (typeof id !== 'string' || !id) throw new Error('id requerido');
  delta = parseInt(delta, 10);
  if (isNaN(delta) || delta === 0) return { ok: false };

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    _migrateIfNeeded(props);
    const cur = _getStickerState(props, id);
    let newP = cur.p, newS = cur.s;
    if (delta > 0) {
      newS = cur.s + delta;
    } else {
      let toRemove = -delta;
      const fromS = Math.min(cur.s, toRemove);
      newS = cur.s - fromS;
      toRemove -= fromS;
      if (toRemove > 0) {
        newP = Math.max(0, cur.p - toRemove);
      }
    }
    _setStickerState(props, id, newP, newS);
    const v = _bumpVersion(props);
    return { ok: true, value: { p: newP, s: newS }, version: v };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Set absoluto del total. Conserva la pegada si existía y rellena
 * sueltas con el resto. Si value=0, limpia toda la lámina.
 */
function setSticker(id, value) {
  if (typeof id !== 'string' || !id) throw new Error('id requerido');
  value = parseInt(value, 10);
  if (isNaN(value) || value < 0) value = 0;

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    _migrateIfNeeded(props);
    const cur = _getStickerState(props, id);
    let newP, newS;
    if (value === 0) {
      newP = 0; newS = 0;
    } else {
      newP = cur.p; // mantener pegada si la había
      newS = Math.max(0, value - newP);
    }
    _setStickerState(props, id, newP, newS);
    const v = _bumpVersion(props);
    return { ok: true, value: { p: newP, s: newS }, version: v };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Mueve 1 suelta al álbum (s -= 1, p = 1). Solo posible si hay al menos
 * una suelta y la lámina aún no está pegada.
 */
function pegarSuelta(id) {
  if (typeof id !== 'string' || !id) throw new Error('id requerido');

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    _migrateIfNeeded(props);
    const cur = _getStickerState(props, id);
    if (cur.s < 1) return { ok: false, reason: 'no hay sueltas', value: cur };
    if (cur.p >= 1) return { ok: false, reason: 'ya está pegada', value: cur };
    const newP = 1, newS = cur.s - 1;
    _setStickerState(props, id, newP, newS);
    const v = _bumpVersion(props);
    return { ok: true, value: { p: newP, s: newS }, version: v };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Despega: mueve la pegada de vuelta a sueltas (p=0, s+=1). Caso raro,
 * útil si se marcó pegada por error.
 */
function despegar(id) {
  if (typeof id !== 'string' || !id) throw new Error('id requerido');

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    _migrateIfNeeded(props);
    const cur = _getStickerState(props, id);
    if (cur.p < 1) return { ok: false, reason: 'no está pegada', value: cur };
    const newP = 0, newS = cur.s + 1;
    _setStickerState(props, id, newP, newS);
    const v = _bumpVersion(props);
    return { ok: true, value: { p: newP, s: newS }, version: v };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Versión batch: aplica varias operaciones en una sola transacción.
 * `ops` es un array de {id, action, delta?, p?, s?}:
 *   - {id, action:'inc', delta:+1} → +N como suelta (o -N restando)
 *   - {id, action:'pegar'} → mover 1 suelta a pegada
 *   - {id, action:'despegar'} → opuesto
 *   - {id, action:'set', p:0|1, s:N} → set explícito
 *   - {id, action:'clear'} → p=0, s=0
 */
function applyManyOps(ops) {
  if (!Array.isArray(ops)) throw new Error('ops debe ser array');
  if (ops.length === 0) return { ok: true, values: {}, version: null };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    _migrateIfNeeded(props);
    const values = {};
    let touched = false;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || typeof op.id !== 'string' || !op.id) continue;
      const cur = _getStickerState(props, op.id);
      let newP = cur.p, newS = cur.s;
      const action = op.action || 'inc';

      if (action === 'inc') {
        const d = parseInt(op.delta, 10) || 0;
        if (d === 0) continue;
        if (d > 0) {
          newS = cur.s + d;
        } else {
          let toRemove = -d;
          const fromS = Math.min(cur.s, toRemove);
          newS = cur.s - fromS;
          toRemove -= fromS;
          if (toRemove > 0) newP = Math.max(0, cur.p - toRemove);
        }
      } else if (action === 'pegar') {
        if (cur.s >= 1 && cur.p < 1) {
          newP = 1; newS = cur.s - 1;
        } else continue;
      } else if (action === 'despegar') {
        if (cur.p >= 1) {
          newP = 0; newS = cur.s + 1;
        } else continue;
      } else if (action === 'set') {
        newP = Math.max(0, Math.min(1, parseInt(op.p, 10) || 0));
        newS = Math.max(0, parseInt(op.s, 10) || 0);
      } else if (action === 'clear') {
        newP = 0; newS = 0;
      } else {
        continue;
      }

      _setStickerState(props, op.id, newP, newS);
      values[op.id] = { p: newP, s: newS };
      touched = true;
    }

    let v = parseInt(props.getProperty(VERSION_KEY) || '0', 10);
    if (touched) v = _bumpVersion(props);
    return { ok: true, values: values, version: v };
  } finally {
    lock.releaseLock();
  }
}

/** Compatibilidad con la API vieja: incManySticker([{id, delta}, ...]). */
function incManySticker(updates) {
  if (!Array.isArray(updates)) throw new Error('updates debe ser array');
  const ops = updates.map(u => ({ id: u.id, action: 'inc', delta: u.delta }));
  return applyManyOps(ops);
}

/** Pega múltiples sueltas al álbum en una transacción. */
function pegarMuchas(ids) {
  if (!Array.isArray(ids)) throw new Error('ids debe ser array');
  const ops = ids.map(id => ({ id: id, action: 'pegar' }));
  return applyManyOps(ops);
}

function pushOrden(orden) {
  if (!Array.isArray(orden)) throw new Error('orden debe ser array');
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty(ORDEN_KEY, JSON.stringify(orden));
    const v = _bumpVersion(props);
    return { ok: true, version: v };
  } finally {
    lock.releaseLock();
  }
}

/** Resetea TODO el estado del álbum. Acción global. */
function resetAll() {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const all = props.getProperties();
    Object.keys(all).filter(k =>
      k.indexOf(STATE_PREFIX) === 0 ||
      k.indexOf(LEGACY_CLIENT_PREFIX) === 0 ||
      k === STATE_KEY_LEGACY
    ).forEach(k => props.deleteProperty(k));
    const v = _bumpVersion(props);
    return { ok: true, version: v };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Importa estado. Acepta tanto el formato nuevo {id: {p, s}} como el
 * viejo {id: count} (que se interpreta como todas sueltas).
 */
function importState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('state debe ser objeto');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    // borrar todo lo existente
    const all = props.getProperties();
    Object.keys(all).filter(k =>
      k.indexOf(STATE_PREFIX) === 0 ||
      k.indexOf(LEGACY_CLIENT_PREFIX) === 0 ||
      k === STATE_KEY_LEGACY
    ).forEach(k => props.deleteProperty(k));

    // armar buckets
    const buckets = {};
    for (const id in state) {
      const v = state[id];
      let p = 0, s = 0;
      if (typeof v === 'number') {
        s = Math.max(0, parseInt(v, 10) || 0); // viejo formato → todo a sueltas
      } else if (v && typeof v === 'object') {
        p = Math.max(0, Math.min(1, parseInt(v.p, 10) || 0));
        s = Math.max(0, parseInt(v.s, 10) || 0);
      }
      if (p === 0 && s === 0) continue;
      const bk = _stateKeyForId(id);
      if (!bk) continue;
      if (!buckets[bk]) buckets[bk] = {};
      const entry = {};
      if (p) entry.p = p;
      if (s) entry.s = s;
      buckets[bk][id] = entry;
    }
    for (const bk in buckets) _writeBucket(props, bk, buckets[bk]);
    const ver = _bumpVersion(props);
    return { ok: true, version: ver };
  } finally {
    lock.releaseLock();
  }
}

// ===== Finanzas (Fase 3) =====

function _readFinanzas(props) {
  const raw = props.getProperty(FIN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function _writeFinanzas(props, data) {
  props.setProperty(FIN_KEY, JSON.stringify(data));
}
function _bumpFinVersion(props) {
  const v = parseInt(props.getProperty(FIN_VERSION_KEY) || '0', 10) + 1;
  props.setProperty(FIN_VERSION_KEY, String(v));
  return v;
}
function _emptyFinanzas() {
  return { v: 1, precios: {}, especiales: {}, descuentos: [], movimientos: [] };
}

/**
 * Devuelve el bloque de finanzas. Si `sinceFinVersion` ya es la última,
 * devuelve {unchanged: true, finVersion} para evitar payload completo.
 */
function pullFinanzas(sinceFinVersion) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const currentVersion = parseInt(props.getProperty(FIN_VERSION_KEY) || '0', 10);
    if (sinceFinVersion != null && parseInt(sinceFinVersion, 10) >= currentVersion) {
      return { unchanged: true, finVersion: currentVersion };
    }
    const value = _readFinanzas(props);
    return { unchanged: false, finVersion: currentVersion, value: value };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reemplaza el mapa completo de precios especiales por id.
 * Llamado cuando el usuario edita la lista en el sheet "★ Especiales".
 * Last-write-wins: el cliente envía el mapa completo y el server lo guarda
 * tal cual. Bumpea finVersion para que las otras instancias lo pulleen.
 */
function setFinEspeciales(especiales) {
  if (!especiales || typeof especiales !== 'object') throw new Error('especiales debe ser objeto');
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const cur = _readFinanzas(props) || _emptyFinanzas();
    const cleaned = {};
    for (const k in especiales) {
      const n = parseInt(especiales[k], 10);
      if (typeof k === 'string' && k && !isNaN(n) && n >= 0) cleaned[k] = n;
    }
    cur.especiales = cleaned;
    _writeFinanzas(props, cur);
    const v = _bumpFinVersion(props);
    return { ok: true, finVersion: v, value: cur };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reemplaza el array de descuentos por volumen. El vendedor edita los
 * tiers en el modal de Finanzas y se persisten acá para sobrevivir a
 * la eviction de localStorage de iOS Safari (en celulares que matan
 * la pestaña la app perdía la config local).
 *
 * Last-write-wins: el cliente envía el array completo y el server lo
 * guarda tal cual (tras validación). Bumpea finVersion para que las
 * otras instancias lo pulleen vía pullFinanzas.
 */
function setFinDescuentos(descuentos) {
  if (!Array.isArray(descuentos)) throw new Error('descuentos debe ser array');
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const cur = _readFinanzas(props) || _emptyFinanzas();
    // Validar y limpiar: minQty entero >= 1, descuento 1-99 (puede ser float),
    // max 10 tiers. Dedup por minQty (último gana). Sort ascendente.
    const cleaned = descuentos
      .map(function(d) {
        if (!d || typeof d !== 'object') return null;
        const minQty = parseInt(d.minQty, 10);
        const pct = parseFloat(d.descuento);
        if (!isFinite(minQty) || minQty < 1) return null;
        if (!isFinite(pct) || pct <= 0 || pct >= 100) return null;
        return { minQty: minQty, descuento: pct };
      })
      .filter(Boolean)
      .slice(0, 10);
    const map = {};
    cleaned.forEach(function(d) { map[d.minQty] = d; });
    const dedup = Object.keys(map).map(function(k) { return map[k]; });
    dedup.sort(function(a, b) { return a.minQty - b.minQty; });
    cur.descuentos = dedup;
    _writeFinanzas(props, cur);
    const v = _bumpFinVersion(props);
    return { ok: true, finVersion: v, value: cur };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Mergea precios sobre los existentes. Last-write-wins por categoría.
 * No reemplaza categorías que el cliente no envió (solo las que están en
 * el objeto entrante).
 */
function setFinPrecios(precios) {
  if (!precios || typeof precios !== 'object') throw new Error('precios debe ser objeto');
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const cur = _readFinanzas(props) || _emptyFinanzas();
    if (!cur.precios || typeof cur.precios !== 'object') cur.precios = {};
    const cleaned = {};
    for (const k in precios) {
      const n = parseInt(precios[k], 10);
      if (!isNaN(n) && n >= 0) cleaned[k] = n;
    }
    cur.precios = Object.assign({}, cur.precios, cleaned);
    _writeFinanzas(props, cur);
    const v = _bumpFinVersion(props);
    return { ok: true, finVersion: v, value: cur };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Agrega un movimiento al array. Idempotente por id: si el id ya existe,
 * no duplica (útil para retries del cliente).
 */
function addFinMovimiento(mov) {
  if (!mov || typeof mov !== 'object') throw new Error('mov debe ser objeto');
  if (typeof mov.id !== 'string' || !mov.id) throw new Error('mov.id requerido');
  if (mov.tipo !== 'compra' && mov.tipo !== 'venta' && mov.tipo !== 'intercambio' && mov.tipo !== 'ajuste') throw new Error('mov.tipo invalido');
  const qty = parseInt(mov.qty, 10);
  const precio = parseInt(mov.precio, 10);
  if (isNaN(qty) || qty < 0) throw new Error('mov.qty debe ser >= 0');
  if (isNaN(precio) || precio < 0) throw new Error('mov.precio debe ser >= 0');
  if (mov.tipo === 'compra' || mov.tipo === 'venta') {
    if (qty <= 0) throw new Error('mov.qty debe ser > 0');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const cur = _readFinanzas(props) || _emptyFinanzas();
    if (!Array.isArray(cur.movimientos)) cur.movimientos = [];
    if (cur.movimientos.some(m => m.id === mov.id)) {
      const v = parseInt(props.getProperty(FIN_VERSION_KEY) || '0', 10);
      return { ok: true, finVersion: v, value: cur, duplicate: true };
    }
    const persisted = {
      id: mov.id,
      tipo: mov.tipo,
      subtipo: typeof mov.subtipo === 'string' ? mov.subtipo : '',
      qty: qty,
      precio: precio,
      fecha: typeof mov.fecha === 'string' ? mov.fecha : '',
      nota: typeof mov.nota === 'string' ? mov.nota : '',
    };
    if (Array.isArray(mov.laminaIds)) persisted.laminaIds = mov.laminaIds.filter(x => typeof x === 'string');
    if (Array.isArray(mov.inventoryOps)) {
      persisted.inventoryOps = mov.inventoryOps
        .filter(op => op && typeof op.id === 'string' && typeof op.delta === 'number')
        .map(op => ({ id: op.id, delta: op.delta }));
    }
    if (typeof mov.description === 'string' && mov.description) persisted.description = mov.description;
    cur.movimientos.push(persisted);
    _writeFinanzas(props, cur);
    const v = _bumpFinVersion(props);
    return { ok: true, finVersion: v, value: cur };
  } finally {
    lock.releaseLock();
  }
}

/** Borra un movimiento por id. Idempotente: si no existe, no falla. */
function deleteFinMovimiento(movId) {
  if (typeof movId !== 'string' || !movId) throw new Error('movId requerido');
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const cur = _readFinanzas(props) || _emptyFinanzas();
    if (!Array.isArray(cur.movimientos)) cur.movimientos = [];
    const before = cur.movimientos.length;
    cur.movimientos = cur.movimientos.filter(m => m.id !== movId);
    if (cur.movimientos.length === before) {
      const v = parseInt(props.getProperty(FIN_VERSION_KEY) || '0', 10);
      return { ok: true, finVersion: v, value: cur, notFound: true };
    }
    _writeFinanzas(props, cur);
    const v = _bumpFinVersion(props);
    return { ok: true, finVersion: v, value: cur };
  } finally {
    lock.releaseLock();
  }
}

/** Reemplaza todo el bloque de finanzas (sync inicial / restaurar backup). */
function importFinanzas(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('obj debe ser objeto');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    const cleaned = {
      v: 1,
      precios: obj.precios && typeof obj.precios === 'object' ? obj.precios : {},
      especiales: obj.especiales && typeof obj.especiales === 'object' ? obj.especiales : {},
      movimientos: Array.isArray(obj.movimientos) ? obj.movimientos.filter(m =>
        m && typeof m.id === 'string' && (m.tipo === 'compra' || m.tipo === 'venta' || m.tipo === 'intercambio' || m.tipo === 'ajuste')
      ) : [],
    };
    _writeFinanzas(props, cleaned);
    const v = _bumpFinVersion(props);
    return { ok: true, finVersion: v, value: cleaned };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Crea una oferta personalizada con un token corto. La app llama esta
 * función para compartir una lista de láminas con un vecino sin pegarle
 * 1000+ chars de URL — devuelve un token de 6 chars (ej. "Xy7k9p") que
 * se usa en la URL pública como ?o=TOKEN. La página pública resuelve el
 * token vía el endpoint doGet con ?action=oferta&token=...
 *
 * Cleanup automático: al crear, purga ofertas mayores a 30 días para
 * mantener el storage de PropertiesService dentro de su quota (~500KB).
 */
function createOferta(payload) {
  // Backward compat: si recibimos un array, asumimos {ids: array} sin phone
  // ni greeting. Versiones anteriores de la app pasaban solo el array.
  if (Array.isArray(payload)) {
    payload = { ids: payload };
  }
  if (!payload || !Array.isArray(payload.ids) || payload.ids.length === 0) {
    throw new Error('ids requeridos');
  }
  const cleaned = payload.ids
    .filter(function(id) { return typeof id === 'string' && id.length > 0 && id.length < 20; })
    .slice(0, 500);
  if (cleaned.length === 0) throw new Error('ids vacíos');

  // Phone del vendedor (opcional). Solo dígitos, 8-15 chars. Si está vacío
  // o inválido, la página pública mostrará solo "Copiar mensaje" en vez
  // del botón "Enviar por WhatsApp". El número se guarda con la oferta
  // (no global) para que cada oferta pueda tener un phone distinto si el
  // vendedor cambia su número o usa números temporales.
  let phone = '';
  if (typeof payload.phone === 'string') {
    phone = payload.phone.replace(/\D/g, '').slice(0, 15);
    if (phone.length < 8) phone = '';
  }
  // Saludo opcional (max 60 chars) — para personalizar la página del vecino.
  let greeting = '';
  if (typeof payload.greeting === 'string') {
    greeting = payload.greeting.slice(0, 60).trim();
  }
  // Descuentos por volumen — array de tiers ordenado por minQty ascendente:
  //   [{ minQty: 50, descuento: 10 }, { minQty: 100, descuento: 20 }]
  // El % aplica solo a comunes (jugadores), no a especiales. El tier se
  // dispara con la cantidad TOTAL seleccionada (comunes + especiales) para
  // motivar al vecino a subir el carrito completo. Max 10 tiers.
  let descuentos = [];
  if (Array.isArray(payload.descuentos)) {
    descuentos = payload.descuentos
      .map(function(d) {
        if (!d || typeof d !== 'object') return null;
        const minQty = parseInt(d.minQty, 10);
        const pct = parseFloat(d.descuento);
        if (!isFinite(minQty) || minQty < 1) return null;
        if (!isFinite(pct) || pct <= 0 || pct >= 100) return null;
        return { minQty: minQty, descuento: pct };
      })
      .filter(Boolean)
      .sort(function(a, b) { return a.minQty - b.minQty; })
      .slice(0, 10);
  }

  const props = PropertiesService.getScriptProperties();

  // Cleanup: purgar ofertas > 30 días para que el storage no se llene.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const allKeys = props.getKeys();
  let cleaned_count = 0;
  for (let i = 0; i < allKeys.length; i++) {
    const key = allKeys[i];
    if (key.indexOf('OFERTA_') !== 0) continue;
    try {
      const raw = props.getProperty(key);
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.ts && data.ts < cutoff) {
        props.deleteProperty(key);
        cleaned_count++;
      }
    } catch (_) {}
  }

  // Generar token único de 6 chars base36. Reintentar hasta 5 veces si
  // hay colisión (probabilidad: ~1 en 2 billones, prácticamente nunca).
  let token = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = Math.random().toString(36).slice(2, 8);
    if (candidate.length === 6 && !props.getProperty('OFERTA_' + candidate)) {
      token = candidate;
      break;
    }
  }
  if (!token) throw new Error('No se pudo generar token único');

  props.setProperty('OFERTA_' + token, JSON.stringify({
    ids: cleaned,
    phone: phone,
    greeting: greeting,
    descuentos: descuentos,
    ts: Date.now()
  }));

  return { token: token, count: cleaned.length, cleanup: cleaned_count };
}

// ===== Utilidades de mantenimiento =====

function debugDump() {
  const all = PropertiesService.getScriptProperties().getProperties();
  Logger.log(JSON.stringify(all, null, 2));
}

function debugReset() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log('Reset completo');
}

/** Forzar la migración manualmente (útil después de un cambio de modelo). */
function debugMigrate() {
  const props = PropertiesService.getScriptProperties();
  _migrateIfNeeded(props);
  Logger.log('Migración aplicada. Estado actual:');
  Logger.log(JSON.stringify(props.getProperties(), null, 2));
}

// ===== Parser de mensajes de intercambio con IA (Anthropic Claude Haiku) =====
//
// El parser heurístico (`parseFriendMessage` en index.html) cubre el formato
// estándar pero falla con la cola larga: emojis, banderas, listas pegadas de
// otras apps, formatos en otros idiomas, etc.
//
// Esta función envía el mensaje crudo a Claude Haiku que devuelve JSON con la
// estructura idéntica a la del parser heurístico. El frontend la prefiere y
// cae al parser local si falla (no hay API key, error de red, JSON inválido).
//
// Setup: agregar la API key en Script Properties con nombre 'ANTHROPIC_KEY'.
// Costo aprox por cruce: $0.001-0.002 con Haiku. Latencia: ~1-1.5s.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_KEY_PROP = 'ANTHROPIC_KEY';

function parseFriendMessageAI(repesText, faltasText) {
  // Compat: si recibimos UN solo arg (formato combinado viejo "TENGO...\nME FALTAN..."),
  // lo separamos por headers antes de procesar. Nuevos clientes llaman con dos args.
  if (typeof faltasText === 'undefined' && typeof repesText === 'string') {
    const split = _splitCombinedInput(repesText);
    repesText = split.repes;
    faltasText = split.faltas;
  }

  const hasRepes = repesText && typeof repesText === 'string' && repesText.trim();
  const hasFaltas = faltasText && typeof faltasText === 'string' && faltasText.trim();

  if (!hasRepes && !hasFaltas) {
    return {
      faltan: {}, repetidas: {}, errors: ['Mensaje vacío'],
      totalFaltan: 0, totalRepetidas: 0, aiUsed: false
    };
  }

  const apiKey = PropertiesService.getScriptProperties().getProperty(ANTHROPIC_KEY_PROP);
  if (!apiKey) {
    throw new Error('Configurá ANTHROPIC_KEY en Script Properties para usar el parser con IA. ' +
                    'Apps Script → Project Settings → Script Properties → Add Property.');
  }

  const result = {
    faltan: {}, repetidas: {}, errors: [],
    totalFaltan: 0, totalRepetidas: 0, aiUsed: true
  };

  // Procesamos cada sección por separado: dos llamadas a Claude más pequeñas
  // y enfocadas en vez de una grande con dos secciones. Más rápido y robusto
  // para listas masivas (300+ cromos por sección no caben en una sola respuesta).
  if (hasRepes) {
    Logger.log('parseFriendMessageAI: procesando repetidas (' + repesText.length + ' chars)');
    const repesItems = _parseSectionAI(repesText, 'repetidas', apiKey);
    Logger.log('parseFriendMessageAI: repetidas → ' + Object.keys(repesItems).length + ' items extraídos');
    for (const id in repesItems) {
      const qty = parseInt(repesItems[id], 10) || 1;
      result.repetidas[id] = qty;
      result.totalRepetidas += qty;
    }
  }
  if (hasFaltas) {
    Logger.log('parseFriendMessageAI: procesando faltantes (' + faltasText.length + ' chars)');
    const faltasItems = _parseSectionAI(faltasText, 'faltantes', apiKey);
    Logger.log('parseFriendMessageAI: faltantes → ' + Object.keys(faltasItems).length + ' items extraídos');
    for (const id in faltasItems) {
      result.faltan[id] = 1;
      result.totalFaltan++;
    }
  }

  return result;
}

/** Separa el formato combinado legacy ("TENGO PARA CAMBIAR:\n...\nME FALTAN:\n...")
 *  en dos cadenas independientes — para compat con clientes viejos. */
function _splitCombinedInput(text) {
  const lines = text.split(/\r?\n/);
  let mode = null;
  const repes = [], faltas = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    const low = t.toLowerCase();
    const isHead = !t.match(/^[A-Za-z]{2,8}\s*:/);
    if (isHead) {
      if (low.indexOf('falta') >= 0) { mode = 'falta'; continue; }
      if (low.indexOf('tengo') >= 0 || low.indexOf('cambiar') >= 0 ||
          low.indexOf('repetida') >= 0 || low.indexOf('intercamb') >= 0 ||
          low.indexOf('suelta') >= 0) { mode = 'rep'; continue; }
    }
    if (mode === 'rep') repes.push(t);
    else if (mode === 'falta') faltas.push(t);
    else repes.push(t); // sin header asumimos repetidas
  }
  return { repes: repes.join('\n'), faltas: faltas.join('\n') };
}

/** Llama a Claude para parsear UNA sección (repetidas O faltantes).
 *  Devuelve { id: qty } con los IDs canónicos. */
function _parseSectionAI(text, sectionType, apiKey) {
  const prompt = _buildAISectionPrompt(text, sectionType);

  let response;
  try {
    response = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    throw new Error('Error de red llamando Claude (' + sectionType + '): ' +
                    (err && err.message ? err.message : err));
  }

  const code = response.getResponseCode();
  const bodyText = response.getContentText();
  if (code !== 200) {
    throw new Error('Claude API HTTP ' + code + ' (' + sectionType + '): ' + bodyText.slice(0, 300));
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (err) {
    throw new Error('Respuesta no-JSON de Claude (' + sectionType + '): ' + bodyText.slice(0, 200));
  }
  const aiText = (body && body.content && body.content[0] && body.content[0].text) || '';
  Logger.log('Claude response length (' + sectionType + '): ' + aiText.length + ' chars');

  let jsonStr = aiText.trim();
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error('Claude devolvió JSON inválido (' + sectionType + '): ' + aiText.slice(0, 200));
  }

  // Espera shape: { "items": { "ID": qty, ... } }
  return (parsed && parsed.items && typeof parsed.items === 'object') ? parsed.items : {};
}

function _buildAISectionPrompt(text, sectionType) {
  // 48 códigos FIFA del Mundial 2026, en el mismo orden que `equiposDefault`
  // en el frontend. Si cambia el catálogo, actualizar aquí también.
  const teamCodes = 'MEX, RSA, KOR, CZE, CAN, BIH, QAT, SUI, BRA, MAR, HAI, SCO, ' +
                    'USA, PAR, AUS, TUR, GER, CUW, CIV, ECU, NED, JPN, SWE, TUN, ' +
                    'BEL, EGY, IRN, NZL, ESP, CPV, KSA, URU, FRA, SEN, IRQ, NOR, ' +
                    'ARG, ALG, AUT, JOR, POR, COD, UZB, COL, ENG, CRO, GHA, PAN';

  const sectionLabel = sectionType === 'repetidas'
    ? 'duplicates the person has TO GIVE / TRADE / OFFER'
    : 'stickers the person is MISSING and WANTS to receive';

  const qtyRule = sectionType === 'repetidas'
    ? 'Quantity is 1 per item by default. Higher when explicit ("×3", "x3", "(2)", "3x", "(×2)") ' +
      'or when same item repeats. A line prefix "xN:" or "×N:" applies N to ALL items on that line.'
    : 'Quantity is always 1 for missing stickers (you either need it or you don\'t — no multipliers).';

  return (
    'You parse Panini Mundial 2026 sticker album lists and extract sticker IDs.\n' +
    'This list represents ' + sectionLabel + '.\n\n' +
    'Output ONLY this JSON (no markdown, no commentary, no explanation):\n' +
    '{"items": {"BRA-7": 2, "COL-3": 1, "FWC5": 1}}\n\n' +
    'Sticker ID formats:\n' +
    '- "00"\n' +
    '- "FWC1" through "FWC19" (NO hyphen — FWC1-FWC8 are intro, FWC9-FWC19 are history)\n' +
    '- "<TEAM>-<N>" where N = 1..20 (hyphen is the standard team-number separator)\n\n' +
    'The 48 valid team codes (use ONLY these):\n' +
    teamCodes + '\n\n' +
    'Map country names in any language to the right code (Brazil/Brasil/Brésil → BRA, ' +
    'España/Spain → ESP, Países Bajos/Netherlands/Holanda → NED, Sudáfrica/South Africa → RSA, ' +
    'Corea del Sur/South Korea → KOR, Rep. Checa/Czech → CZE, Cabo Verde → CPV, ' +
    'Arabia Saudita → KSA, Costa de Marfil/Ivory Coast → CIV, Curazao/Curacao → CUW, ' +
    'Estados Unidos/USA → USA, Inglaterra/England → ENG, Escocia/Scotland → SCO, ' +
    'Argelia/Algeria → ALG, RD Congo → COD, Panamá/Panama → PAN, etc.). ' +
    'If you cannot match a country to one of the 48 codes above, skip the item.\n\n' +
    'SPECIAL FORMATS to handle (common in Panini app exports and trading groups):\n\n' +
    '1. COMPACT CODES (team code immediately followed by number, no separator):\n' +
    '   "MEX10" → "MEX-10". "BRA7" → "BRA-7". "KOR3" → "KOR-3".\n' +
    '   Always output with the hyphen.\n\n' +
    '2. RANGES (em-dash "—" or hyphen "-" between two codes of the same team or FWC):\n' +
    '   "FWC3-FWC4" or "FWC3—FWC4" expands to FWC3 AND FWC4 (both items).\n' +
    '   "KOR15-KOR16" expands to KOR-15 AND KOR-16.\n' +
    '   "AUS4-AUS8" expands inclusive: AUS-4, AUS-5, AUS-6, AUS-7, AUS-8 (5 items).\n' +
    '   IMPORTANT: only applies when both sides of the dash are valid codes. ' +
    '"BRA-3" alone is one sticker, not a range.\n\n' +
    '3. MULTIPLIER PREFIX (line starts with "xN:" or "×N:"):\n' +
    '   "x1: A, B, C" → A, B, C each quantity 1\n' +
    '   "x2: BRA-3, COL-7" → BRA-3 and COL-7 each quantity 2\n' +
    '   Applies to ALL items on that line until a new prefix or section break.\n\n' +
    '4. IGNORE preambles, titles, and metadata that are not items:\n' +
    '   - Document titles ("Panini WC 2026 Album", "Mi lista", "Cromos Duplicados", "Cromos Faltantes")\n' +
    '   - Counts in parentheses ("(182)", "(352)", "Total: 182 cromos")\n' +
    '   - Section header words ("TENGO PARA CAMBIAR", "ME FALTAN", "REPETIDAS", "FALTANTES")\n' +
    '   - Dates, timestamps, greetings ("Hola!", "Hey")\n' +
    '   - Standalone emojis used decoratively\n\n' +
    qtyRule + '\n\n' +
    'Skip any item you cannot confidently identify with one of the valid IDs above.\n' +
    'Extract EVERY item — do not summarize or truncate. Even if the list has hundreds of items, output them all.\n\n' +
    'List to parse:\n' +
    '---\n' +
    text + '\n' +
    '---'
  );
}

/** Test rápido del parser AI desde el editor de Apps Script. */
function debugAIParse() {
  const sample =
    'Hola hermano, te paso mi lista 🇧🇷⚽\n\n' +
    'Tengo para cambiar:\n' +
    'Brasil: 3, 7 (×2)\n' +
    'Colombia: 15\n\n' +
    'Me faltan:\n' +
    'Argentina 12, Mexico 4';
  const r = parseFriendMessageAI(sample);
  Logger.log(JSON.stringify(r, null, 2));
}

/** Test del formato oficial de Panini App: "x1:" prefix, rangos con guión/em-dash,
 *  códigos compactos sin separador, todo en una línea gigante. */
function debugAIParseHard() {
  const sample =
    'Panini WC 2026 Album — Cromos Duplicados (182)\n' +
    'x1: 00, FWC3—FWC4, FWC9—FWC10, FWC12, FWC16, FWC18, MEX10, MEX14, ' +
    'RSA5, RSA7, RSA16, RSA18, KOR3, KOR5, KOR7, KOR10, KOR13, KOR15-KOR16, ' +
    'CZE19, CAN3, CAN7-CAN8, BIH3-BIH4, BIH15-BIH16, BIH18, QAT13, QAT18, QAT20, ' +
    'SUI1, SUI4, SUI6, SUI8, SUI17, BRA8, BRA14, BRA18, MAR2, MAR6, MAR10, ' +
    'MAR14, MAR18, HAI13, HAI19, PAR2, AUS4-AUS8, AUS10-AUS12, AUS18, ' +
    'TUR4, TUR6-TUR7, GER8, GER12, GER16, GER20';
  const r = parseFriendMessageAI(sample);
  Logger.log('Total faltan: ' + r.totalFaltan + '  ·  Total repetidas: ' + r.totalRepetidas);
  Logger.log('IDs en repetidas: ' + Object.keys(r.repetidas).sort().join(', '));
  Logger.log(JSON.stringify(r, null, 2));
}
