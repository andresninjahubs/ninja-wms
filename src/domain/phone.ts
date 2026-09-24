/**
 * Validación de un teléfono de contacto.
 * ---------------------------------------------------------------------------
 * A propósito es PERMISIVA. La tentación es escribir una expresión regular que exija
 * el formato chileno `+56 9 XXXX XXXX`, y eso rompe el registro el día que entra el
 * primer cliente mexicano —que es justamente el que se está buscando—. Un validador
 * que rechaza a un cliente real es peor que uno que deja pasar un número mal escrito:
 * lo primero se pierde y no se entera nadie; lo segundo se corrige con una llamada.
 *
 * Lo único que se exige es que haya suficientes dígitos para ser un número y no tantos
 * como para ser un error de tipeo. El `+` inicial se acepta y los separadores humanos
 * (espacios, guiones, paréntesis, puntos) se ignoran al contar.
 *
 * Nada se normaliza: el número se guarda tal como lo escribió la persona. Un teléfono
 * "arreglado" a un formato que su dueño no reconoce estorba más de lo que ayuda.
 *
 * Módulo puro: sin repositorios, sin reloj, sin I/O.
 */

/** Dígitos del número, ignorando el `+` y cualquier separador. */
export function digitosDeTelefono(raw: string): string {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * ¿Esto puede ser un teléfono?
 *
 * Entre 8 y 15 dígitos: 8 es un fijo local sin código de país (el mínimo que alguien
 * podría escribir de buena fe) y 15 es el máximo que define el estándar E.164, así que
 * por arriba no se está rechazando ningún número que exista.
 */
export function esTelefonoPlausible(raw: string): boolean {
  const s = String(raw || '').trim();
  if (!s) return false;
  // Letras en un teléfono son un campo mal llenado, no un formato exótico.
  if (/[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(s)) return false;
  const d = digitosDeTelefono(s);
  return d.length >= 8 && d.length <= 15;
}
