#!/usr/bin/env node
/*
 * sync-catalog.js — sincroniza catalogo.json a los bloques CATALOGO en los HTMLs.
 *
 * USO:
 *   node scripts/sync-catalog.js
 *   o
 *   npm run sync-catalog
 *
 * QUÉ HACE:
 *   1. Lee /catalogo.json (source of truth del evento + equipos)
 *   2. Encuentra el bloque `const CATALOGO = {...};` en cada HTML
 *   3. Lo reemplaza con el contenido formateado de catalogo.json
 *
 * Archivos modificados:
 *   - apps-script-deploy/index.html (la app)
 *   - cambios/index.html (página pública)
 *
 * No deployea nada — solo actualiza los archivos locales. Después corré
 * `clasp push -f` + `clasp redeploy` + `git push` manualmente.
 *
 * SAFE: si el patrón no encuentra el bloque CATALOGO en algún archivo, sale
 * con error sin modificar nada (no deja archivos a medio escribir).
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'catalogo.json');

const TARGETS = [
  {
    file: path.join(REPO_ROOT, 'apps-script-deploy', 'index.html'),
    indent: '  '
  },
  {
    file: path.join(REPO_ROOT, 'cambios', 'index.html'),
    indent: '  '
  }
];

function loadCatalogo() {
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error('catalogo.json no encontrado en ' + CATALOG_PATH);
  }
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  // Quitar el _comment si existe — es solo doc para el archivo JSON,
  // no debe terminar en los HTMLs.
  delete parsed._comment;
  return parsed;
}

// Quote string as JS single-quoted literal (matches the existing style del HTML).
// Escapa single-quotes y backslashes para que sea válido JS.
function sq(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// Genera el bloque JS del CATALOGO con el mismo formato visual que el HTML
// (single quotes, padding alineado por columnas). Output reproducible.
function renderCatalogoBlock(cat, indent) {
  const ind = indent;
  const ind2 = indent + '  ';
  const ind3 = indent + '    ';
  const ind4 = indent + '      ';

  // Padding: el comma va PEGADO al value (formato original), y agregamos
  // espacios DESPUÉS del comma para alinear el siguiente campo. Esto es:
  //   "{ id: '00',     label: 'X' }"
  //   "{ id: 'FWC10',  label: 'Y' }"
  // En vez de "{ id: '00'    , label: ... }" que sería más raro.

  // Stickers: alinear `label:` después del `,`
  const allStickers = cat.secciones.intro.concat(cat.secciones.history);
  // El "prefix" de cada sticker es "{ id: 'XXXX'," — su longitud varía con el id.
  // Buscamos el prefix más largo para usarlo como target.
  const maxStickerPrefixLen = allStickers.reduce((m, s) =>
    Math.max(m, `{ id: ${sq(s.id)},`.length), 0);
  function renderSticker(s) {
    const prefix = `{ id: ${sq(s.id)},`;
    const padding = ' '.repeat(maxStickerPrefixLen - prefix.length + 1);
    return `${ind4}${prefix}${padding}label: ${sq(s.label)} }`;
  }

  // Equipos: alinear `grupo:` después del `name: '...'.,`
  const maxEquipoNameLen = cat.equipos.reduce((m, e) =>
    Math.max(m, `name: ${sq(e.name)},`.length), 0);
  function renderEquipo(e) {
    const nameField = `name: ${sq(e.name)},`;
    const padding = ' '.repeat(maxEquipoNameLen - nameField.length + 1);
    return `${ind3}{ code: ${sq(e.code)}, ${nameField}${padding}grupo: ${sq(e.grupo)} }`;
  }

  const intro = cat.secciones.intro.map(renderSticker).join(',\n');
  const history = cat.secciones.history.map(renderSticker).join(',\n');
  const equipos = cat.equipos.map(renderEquipo).join(',\n');

  return [
    `${ind}const CATALOGO = {`,
    `${ind2}evento: ${sq(cat.evento)},`,
    `${ind2}year: ${cat.year},`,
    `${ind2}stickersPorEquipo: ${cat.stickersPorEquipo},`,
    `${ind2}secciones: {`,
    `${ind3}intro: [`,
    intro,
    `${ind3}],`,
    `${ind3}history: [`,
    history,
    `${ind3}]`,
    `${ind2}},`,
    `${ind2}equipos: [`,
    equipos,
    `${ind2}]`,
    `${ind}};`
  ].join('\n');
}

function syncFile(targetPath, indent, newBlock) {
  if (!fs.existsSync(targetPath)) {
    throw new Error('Archivo no encontrado: ' + targetPath);
  }
  const html = fs.readFileSync(targetPath, 'utf8');

  // Buscamos el bloque `const CATALOGO = { ... };` con regex multi-línea.
  // El cierre es `};` al inicio de línea con la misma indentación que el `const`.
  // Permitimos variación en el indent.
  const pattern = /(^[ \t]*)const CATALOGO = \{[\s\S]*?\n\1\};/m;
  if (!pattern.test(html)) {
    throw new Error('No se encontró bloque `const CATALOGO = {...};` en ' + targetPath);
  }

  // Detectar el indent real del archivo (puede ser distinto al esperado)
  const match = html.match(pattern);
  const actualIndent = match[1];
  const blockToWrite = renderCatalogoBlock(JSON.parse(JSON.stringify(currentCat)), actualIndent);

  const updated = html.replace(pattern, blockToWrite);
  if (updated === html) {
    throw new Error('Reemplazo no modificó el contenido — patrón coincidió pero no cambió: ' + targetPath);
  }
  fs.writeFileSync(targetPath, updated, 'utf8');
  return { file: targetPath, changed: true };
}

// === Main ===
let currentCat;
try {
  currentCat = loadCatalogo();
  console.log('[sync-catalog] Catálogo cargado:');
  console.log('  evento: ' + currentCat.evento);
  console.log('  year: ' + currentCat.year);
  console.log('  stickersPorEquipo: ' + currentCat.stickersPorEquipo);
  console.log('  equipos: ' + currentCat.equipos.length);
  console.log('  intro: ' + currentCat.secciones.intro.length);
  console.log('  history: ' + currentCat.secciones.history.length);
} catch (e) {
  console.error('[sync-catalog] Error cargando catalogo.json:', e.message);
  process.exit(1);
}

const results = [];
for (const t of TARGETS) {
  try {
    const r = syncFile(t.file, t.indent);
    results.push(r);
    console.log('[sync-catalog] ✓ Actualizado: ' + path.relative(REPO_ROOT, t.file));
  } catch (e) {
    console.error('[sync-catalog] ✗ Error en ' + t.file + ': ' + e.message);
    process.exit(1);
  }
}

console.log('\n[sync-catalog] Listo. ' + results.length + ' archivos actualizados.');
console.log('Próximos pasos:');
console.log('  1. git diff   ← revisar los cambios');
console.log('  2. cd apps-script-deploy && clasp push -f');
console.log('  3. clasp redeploy -V N -d "vN ..." AKfycbxb6U2M25Ah4ZyWu_C8PCQQGzpFzFs6a2VOsmDhTgehVi8V1tUm66LxYKntDFCx9H-6eg');
console.log('  4. git add -A && git commit -m "..." && git push');
