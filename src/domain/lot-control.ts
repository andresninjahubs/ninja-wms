import { ValidationError } from './errors';

/**
 * Lote y vencimiento en la recepción: se capturan SI Y SOLO SI el producto los controla.
 *
 * - Producto con control de lote      → el lote es obligatorio al recepcionar.
 * - Producto SIN control de lote      → no admite lote (mandarlo es un error, no se ignora
 *   en silencio: así una integración que manda basura se entera y el stock no se parte en
 *   "lotes" que nadie gestiona, lo que después bloquea reservas por lote y FEFO).
 * Lo mismo para vencimiento con `expiryControlled`.
 *
 * Este módulo solo valida la parte "solo si" (y el formato de la fecha); la obligatoriedad
 * vive donde se postea el stock (cotejo / escaneo), porque al CREAR la orden de recepción
 * el lote todavía puede no conocerse.
 */
export interface LotControlFlags {
  sku: string;
  lotControlled?: boolean | null;
  expiryControlled?: boolean | null;
}

export function limpio(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Fecha ISO válida y real (rechaza 2027-02-31, que JS correría a marzo). */
export function fechaValida(v: string): boolean {
  if (isNaN(Date.parse(v))) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return true;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function validarLoteVencimientoPermitidos(
  sku: LotControlFlags | null | undefined,
  lot: string | null | undefined,
  expiry: string | null | undefined,
  donde: string,
): void {
  const code = sku?.sku ?? '?';
  if (limpio(lot) && !sku?.lotControlled) {
    throw new ValidationError(
      `${donde} (${code}): el producto no tiene control de lote, así que no admite lote. Actívalo en el maestro de productos si necesitas trazarlo por lote.`,
    );
  }
  const exp = limpio(expiry);
  if (exp && !sku?.expiryControlled) {
    throw new ValidationError(
      `${donde} (${code}): el producto no tiene control de vencimiento, así que no admite fecha de vencimiento. Actívalo en el maestro de productos si es perecible.`,
    );
  }
  if (exp && !fechaValida(exp)) {
    throw new ValidationError(`${donde} (${code}): fecha de vencimiento inválida: ${exp}. Usa el formato AAAA-MM-DD.`);
  }
}

/** Además de lo anterior, exige lo que el producto controla (al postear stock). */
export function validarLoteVencimientoRecepcion(
  sku: LotControlFlags | null | undefined,
  lot: string | null | undefined,
  expiry: string | null | undefined,
  donde: string,
): void {
  validarLoteVencimientoPermitidos(sku, lot, expiry, donde);
  const code = sku?.sku ?? '?';
  if (sku?.lotControlled && !limpio(lot)) {
    throw new ValidationError(`${donde} (${code}): el producto es controlado por lote, debes indicar el lote al recepcionar.`);
  }
  if (sku?.expiryControlled && !limpio(expiry)) {
    throw new ValidationError(`${donde} (${code}): el producto es controlado por vencimiento, debes indicar el vencimiento al recepcionar.`);
  }
}

/**
 * Todos los problemas de lote/vencimiento de una línea (no solo el primero), para
 * reportarlos juntos en una carga masiva. Vacío = la línea está bien.
 */
export function problemasLoteVencimiento(
  sku: LotControlFlags | null | undefined,
  lot: string | null | undefined,
  expiry: string | null | undefined,
  donde: string,
): string[] {
  const out: string[] = [];
  const intenta = (l: string | null | undefined, e: string | null | undefined) => {
    try { validarLoteVencimientoPermitidos(sku, l, e, donde); } catch (err) { out.push((err as Error).message); }
  };
  intenta(lot, null);
  intenta(null, expiry);
  return out;
}
