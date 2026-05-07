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
    // Soporte JSONP para evitar problemas de CORS al consumir desde
    // GitHub Pages. Si viene ?callback=fn, devolvemos JS; si no, JSON puro.
    const payload = JSON.stringify({ ok: true, version: version, state: all, orden: orden });
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
  return { v: 1, precios: {}, movimientos: [] };
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
  if (mov.tipo !== 'compra' && mov.tipo !== 'venta') throw new Error('mov.tipo invalido');
  const qty = parseInt(mov.qty, 10);
  const precio = parseInt(mov.precio, 10);
  if (isNaN(qty) || qty <= 0) throw new Error('mov.qty debe ser > 0');
  if (isNaN(precio) || precio < 0) throw new Error('mov.precio debe ser >= 0');

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
    cur.movimientos.push({
      id: mov.id,
      tipo: mov.tipo,
      subtipo: typeof mov.subtipo === 'string' ? mov.subtipo : '',
      qty: qty,
      precio: precio,
      fecha: typeof mov.fecha === 'string' ? mov.fecha : '',
      nota: typeof mov.nota === 'string' ? mov.nota : '',
    });
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
      movimientos: Array.isArray(obj.movimientos) ? obj.movimientos.filter(m =>
        m && typeof m.id === 'string' && (m.tipo === 'compra' || m.tipo === 'venta')
      ) : [],
    };
    _writeFinanzas(props, cleaned);
    const v = _bumpFinVersion(props);
    return { ok: true, finVersion: v, value: cleaned };
  } finally {
    lock.releaseLock();
  }
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
