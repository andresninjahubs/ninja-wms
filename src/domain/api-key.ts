/**
 * Llaves de API (credenciales largas para máquinas).
 * ---------------------------------------------------------------------------
 * El JWT del panel dura 12 horas: sirve para una persona con una pestaña
 * abierta, no para un agente que se conecta cada día sin que nadie escriba una
 * contraseña. Un cliente MCP —el Claude de escritorio de un jefe de bodega, el
 * agente del OMS del cliente— necesita una credencial que no venza sola y que
 * se pueda revocar de una sin cambiarle la clave a la persona.
 *
 * Por eso la llave es SEPARADA del usuario y se guarda HASHEADA: el secreto
 * completo se muestra una sola vez, al crearla. Si se pierde, se revoca y se
 * emite otra; nunca se puede volver a leer desde la base.
 *
 * La llave NO agrega permisos: hereda exactamente los del usuario que la emitió.
 * Una llave de un operario puede lo que puede ese operario, ni más ni menos.
 *
 * Módulo puro: el hash y el azar se inyectan (`crypto` vive en infraestructura).
 */

export interface ApiKey {
  id: string;
  userId: string;
  /** Nombre que le puso la persona: "Claude de escritorio", "Agente del OMS". */
  label: string;
  /** Prefijo visible del secreto, para reconocer la llave en la lista sin exponerla. */
  prefix: string;
  /** SHA-256 del secreto completo. El secreto en claro no se guarda nunca. */
  hash: string;
  scope: ApiKeyScope;
  /**
   * Operación a la que queda amarrada la llave.
   *
   * Para casi todos es la suya y se completa sola. Importa para el super admin
   * de plataforma, que no tiene operación propia: su llave DEBE declarar sobre
   * cuál opera. Una credencial de máquina que pueda saltar de tenant en tenant
   * según el parámetro de cada llamada es exactamente lo que no se quiere.
   */
  operationId: string;
  createdAt: string;
  createdBy: string | null;
  /** Vencimiento opcional. null = no vence (se revoca a mano). */
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * Qué puede hacer la llave, dentro de lo que ya puede su dueño.
 *   - `read`  — solo herramientas de consulta, aunque el dueño sepa escribir.
 *   - `write` — además ejecuta acciones, sujeto a la política del agente.
 * Es un techo, no un piso: nunca amplía los permisos del usuario.
 */
export type ApiKeyScope = 'read' | 'write';

/** Prefijo de todos los secretos, para reconocerlos de un vistazo en un log o un .env. */
export const API_KEY_PREFIX = 'njw_';

/**
 * Arma un secreto nuevo: `njw_` + 40 caracteres de azar criptográfico.
 * `randomHex` viene de fuera para que el dominio siga siendo puro y testeable.
 */
export function nuevoSecreto(randomHex: (bytes: number) => string): string {
  return API_KEY_PREFIX + randomHex(20);
}

/** Los primeros caracteres que sí se muestran: `njw_a1b2c3…`. */
export function prefijoVisible(secreto: string): string {
  return secreto.slice(0, API_KEY_PREFIX.length + 6);
}

/** ¿La llave sirve ahora mismo? Revocada o vencida, no. */
export function llaveVigente(k: ApiKey, nowIso: string): boolean {
  if (k.revokedAt) return false;
  if (!k.expiresAt) return true;
  const exp = Date.parse(k.expiresAt);
  return Number.isNaN(exp) ? true : Date.parse(nowIso) < exp;
}

/** Vista segura para el panel: todo menos el hash. */
export function apiKeyPublica(k: ApiKey, nowIso: string) {
  return {
    id: k.id,
    label: k.label,
    prefix: k.prefix,
    scope: k.scope,
    operationId: k.operationId,
    createdAt: k.createdAt,
    createdBy: k.createdBy,
    expiresAt: k.expiresAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    vigente: llaveVigente(k, nowIso),
  };
}
