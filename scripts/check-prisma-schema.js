#!/usr/bin/env node
/**
 * Revisa el esquema de Prisma ANTES de empujar, sin necesidad de red.
 * ---------------------------------------------------------------------------
 * Por qué existe: `prisma generate` corre recién dentro del build del
 * contenedor, así que un error de sintaxis en schema.prisma no se ve hasta que
 * el despliegue ya falló. Pasó de verdad: unos comentarios de bloque
 * `/* … *\/` —válidos en TypeScript, NO en Prisma— tumbaron un despliegue
 * completo con "Validation Error Count: 9".
 *
 * Qué hace, en este orden:
 *   1. Si el validador wasm de Prisma está instalado, lo usa: es exactamente el
 *      mismo que corre `prisma generate`, así que lo que pase acá pasa allá.
 *   2. Si no está (lo normal: no es dependencia del proyecto), cae a una
 *      revisión de sintaxis que cubre los errores que de verdad cometemos.
 *
 * Se ejecuta con `node scripts/check-prisma-schema.js` y desde la suite de tests.
 */
const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', 'prisma', 'schema.prisma');

/** Revisión de sintaxis sin dependencias. Devuelve la lista de problemas. */
function revisar(schema) {
  const problemas = [];
  const lineas = schema.split('\n');

  // 1) Comentarios de bloque: Prisma solo acepta `//` y `///`.
  lineas.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('/*') || t === '*/' || (t.startsWith('* ') && !t.startsWith('*/'))) {
      problemas.push(`línea ${i + 1}: comentario de bloque. Prisma solo acepta "//" y "///" — «${t.slice(0, 60)}»`);
    }
  });

  // 2) Llaves balanceadas (ignorando las que van dentro de un string).
  let abiertas = 0;
  for (const l of lineas) {
    const sinTexto = l.replace(/"[^"]*"/g, '""').replace(/\/\/.*$/, '');
    for (const c of sinTexto) {
      if (c === '{') abiertas++;
      else if (c === '}') abiertas--;
      if (abiertas < 0) break;
    }
  }
  if (abiertas !== 0) problemas.push(`llaves sin cerrar: quedan ${abiertas} abiertas`);

  // 3) Toda línea de primer nivel debe empezar con una palabra clave de Prisma.
  const CLAVES = /^(model|enum|datasource|generator|type|view)\s/;
  let dentro = 0;
  lineas.forEach((l, i) => {
    const t = l.trim();
    const antes = dentro;
    for (const c of l.replace(/"[^"]*"/g, '""').replace(/\/\/.*$/, '')) {
      if (c === '{') dentro++;
      else if (c === '}') dentro--;
    }
    if (antes !== 0) return;                       // estamos dentro de un bloque
    if (!t || t.startsWith('//')) return;          // vacía o comentario válido
    if (CLAVES.test(t)) return;
    problemas.push(`línea ${i + 1}: no empieza con una palabra clave de Prisma — «${t.slice(0, 60)}»`);
  });

  return problemas;
}

/** El validador oficial, si está disponible en node_modules. */
function validarConWasm(schema) {
  let wasm;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    wasm = require('@prisma/prisma-schema-wasm');
  } catch {
    return null; // no instalado: el llamador usa la revisión de sintaxis
  }
  try {
    wasm.validate(JSON.stringify({ prismaSchema: schema, noColor: true }));
    return [];
  } catch (e) {
    return [String((e && e.message) || e)];
  }
}

function main() {
  const schema = fs.readFileSync(RUTA, 'utf8');
  const delWasm = validarConWasm(schema);
  const problemas = delWasm !== null ? delWasm : revisar(schema);
  const fuente = delWasm !== null ? 'validador oficial de Prisma' : 'revisión de sintaxis';

  if (problemas.length) {
    console.error(`✗ schema.prisma tiene problemas (${fuente}):\n`);
    problemas.forEach((p) => console.error('  ' + p));
    console.error('\nCorrígelos antes de empujar: si no, el despliegue falla en "npx prisma generate".');
    process.exit(1);
  }
  const modelos = (schema.match(/^model\s+\w+\s*\{/gm) || []).length;
  console.log(`✓ schema.prisma válido (${fuente}) · ${modelos} modelos`);
}

if (require.main === module) main();
module.exports = { revisar };
