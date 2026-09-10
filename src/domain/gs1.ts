/**
 * Parser de códigos GS1 (GS1-128 / DataMatrix GS1) para recepción.
 *
 * Interpreta los "Application Identifiers" (AI) más usados en logística:
 *   (01) GTIN            -> identifica el producto (para resolver el SKU)
 *   (17) vencimiento     -> YYMMDD, se convierte a YYYY-MM-DD
 *   (10) lote            -> variable
 *   (21) número de serie -> variable
 *   (11) fecha producción, (30) cantidad -> se leen como extra si vienen
 *
 * Acepta dos formatos:
 *   - "Human readable" con paréntesis:  (01)07801234500017(17)261130(10)L-2026A(21)SN9
 *   - Crudo del escáner con FNC1 (carácter GS = \x1d) separando los campos variables.
 *
 * Devuelve null si el texto NO tiene estructura GS1 (para que el sistema lo trate
 * como un código plano/EAN, como hasta ahora — degradación elegante).
 */

export interface Gs1Parsed {
  gtin?: string;
  lot?: string;
  serial?: string;
  expiry?: string; // ISO YYYY-MM-DD
  productionDate?: string; // ISO YYYY-MM-DD
  qty?: number;
  ais: Record<string, string>; // todos los AI crudos encontrados
}

// AIs de LONGITUD FIJA relevantes (AI -> largo del dato).
const FIXED: Record<string, number> = {
  '00': 18, // SSCC
  '01': 14, // GTIN
  '02': 14,
  '11': 6, // producción YYMMDD
  '12': 6, // due date
  '13': 6, // packaging
  '15': 6, // best before
  '16': 6, // sell by
  '17': 6, // vencimiento YYMMDD
  '20': 2,
};

const GS = '\x1d'; // FNC1 / Group Separator

/** YYMMDD -> ISO YYYY-MM-DD. DD='00' se interpreta como el último día del mes. */
function ymdToIso(yymmdd: string): string | undefined {
  if (!/^\d{6}$/.test(yymmdd)) return undefined;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const mm = parseInt(yymmdd.slice(2, 4), 10);
  let dd = parseInt(yymmdd.slice(4, 6), 10);
  // Ventana GS1: 00-50 -> 20xx (fechas de vencimiento son futuras).
  const year = 2000 + yy;
  if (mm < 1 || mm > 12) return undefined;
  if (dd === 0) dd = new Date(year, mm, 0).getDate(); // último día del mes
  const p = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p(mm)}-${p(dd)}`;
}

function assign(out: Gs1Parsed, ai: string, value: string) {
  const v = (value || '').trim();
  out.ais[ai] = v;
  if (ai === '01' || ai === '02') out.gtin = v;
  else if (ai === '10') out.lot = v;
  else if (ai === '21') out.serial = v;
  else if (ai === '17') out.expiry = ymdToIso(v) ?? out.expiry;
  else if (ai === '11') out.productionDate = ymdToIso(v) ?? out.productionDate;
  else if (ai === '30' || ai === '37') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) out.qty = n;
  }
}

export function parseGs1(raw: string): Gs1Parsed | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const out: Gs1Parsed = { ais: {} };

  // Formato con paréntesis (HRI).
  if (s.indexOf('(') >= 0) {
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m: RegExpExecArray | null;
    let found = false;
    while ((m = re.exec(s)) !== null) {
      found = true;
      assign(out, m[1], m[2]);
    }
    return found && Object.keys(out.ais).length ? out : null;
  }

  // Formato crudo. Debe empezar con dígitos de un AI conocido para considerarlo GS1.
  if (!/^\d{2}/.test(s)) return null;
  // Quita un FNC1 inicial si viene.
  if (s.charCodeAt(0) === 29) s = s.slice(1);

  let i = 0;
  let found = false;
  let guard = 0;
  while (i < s.length && guard++ < 100) {
    const ai = s.substr(i, 2);
    if (!/^\d{2}$/.test(ai)) break;
    const fixedLen = FIXED[ai];
    if (fixedLen !== undefined) {
      const val = s.substr(i + 2, fixedLen);
      assign(out, ai, val);
      found = true;
      i += 2 + fixedLen;
      // Puede venir un GS tras un fijo (algunos scanners lo agregan).
      if (s.charCodeAt(i) === 29) i += 1;
    } else {
      // AI de longitud variable: hasta el próximo FNC1 o fin.
      let j = s.indexOf(GS, i + 2);
      if (j < 0) j = s.length;
      const val = s.substring(i + 2, j);
      assign(out, ai, val);
      found = true;
      i = j < s.length ? j + 1 : s.length;
    }
  }
  // Solo lo tratamos como GS1 si reconocimos al menos el GTIN o un lote/vencimiento/serie.
  const meaningful = out.gtin || out.lot || out.expiry || out.serial;
  return found && meaningful ? out : null;
}
