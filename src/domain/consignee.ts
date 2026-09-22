/**
 * Destinatarios frecuentes de un CLIENTE (seller).
 * ---------------------------------------------------------------------------
 * Un 3PL despacha una y otra vez a los mismos lugares: las tiendas de su
 * cliente retail, las sucursales de su cliente industrial, los tres centros de
 * distribución de siempre. Hasta ahora cada orden repetía a mano razón social,
 * RUT y dirección — con todas las variantes de tipeo que eso trae ("Av." vs
 * "Avenida", el RUT con y sin puntos), y sin forma de saber que dos órdenes
 * fueron al mismo sitio.
 *
 * Un destinatario tiene DOS clases de dirección y no hay que confundirlas:
 *   - `direccionComercial` — la del domicilio tributario, la que va en la
 *     factura. Es una sola.
 *   - `direcciones[]` — a dónde llega físicamente la mercadería. Son varias:
 *     la casa matriz, la bodega, cada local. Es lo que elige quien crea la orden.
 *
 * El aislamiento es por seller, no por operación: los destinatarios de un
 * cliente no los ve otro cliente del mismo 3PL, aunque compartan bodega.
 *
 * Módulo puro: sin repositorios, sin fechas del sistema, sin I/O.
 */

/** Una dirección de destino concreta del destinatario. */
export interface ConsigneeAddress {
  id: string;
  /** Cómo la llaman internamente: "Bodega Quilicura", "Local Costanera". */
  alias: string;
  direccion: string;
  comuna: string | null;
  ciudad: string | null;
  region: string | null;
  /** Quién recibe en ese punto y cómo ubicarlo. */
  contacto: string | null;
  telefono: string | null;
  notas: string | null;
  /** La que se propone por defecto al crear una orden. Solo una puede serlo. */
  principal: boolean;
}

export interface Consignee {
  id: string;
  sellerId: string;
  /** Nombre legal, el que va en el documento tributario. Obligatorio. */
  razonSocial: string;
  /** RUT normalizado a "12345678-9". null cuando es un destinatario extranjero o sin RUT. */
  rut: string | null;
  /** Nombre de fantasía: como lo conoce la gente de bodega. */
  nombreFantasia: string | null;
  /** Domicilio tributario (el de la factura), distinto del destino físico. */
  direccionComercial: string | null;
  direcciones: ConsigneeAddress[];
  notas: string | null;
  active: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
}

export interface ConsigneeAddressInput {
  id?: string;
  alias?: string | null;
  direccion: string;
  comuna?: string | null;
  ciudad?: string | null;
  region?: string | null;
  contacto?: string | null;
  telefono?: string | null;
  notas?: string | null;
  principal?: boolean;
}

export interface ConsigneeInput {
  razonSocial: string;
  rut?: string | null;
  nombreFantasia?: string | null;
  direccionComercial?: string | null;
  direcciones?: ConsigneeAddressInput[];
  notas?: string | null;
  active?: boolean;
}

// ---- RUT chileno ----------------------------------------------------------

/**
 * Normaliza un RUT a "12345678-9" (sin puntos, guion, K mayúscula).
 *
 * Acepta lo que la gente escribe de verdad: con puntos, sin guion, con
 * espacios, con k minúscula. Devuelve null si no queda nada utilizable.
 */
export function normalizarRut(raw: string | null | undefined): string | null {
  const limpio = String(raw ?? '').trim().replace(/[.\s]/g, '').replace(/-/g, '').toUpperCase();
  if (!limpio) return null;
  if (limpio.length < 2) return null;
  const cuerpo = limpio.slice(0, -1);
  const dv = limpio.slice(-1);
  if (!/^\d+$/.test(cuerpo)) return null;
  if (!/^[0-9K]$/.test(dv)) return null;
  // Sin ceros a la izquierda: "01234567-K" y "1234567-K" son el mismo RUT.
  const cuerpoLimpio = String(Number(cuerpo));
  return `${cuerpoLimpio}-${dv}`;
}

/** Dígito verificador que le corresponde al cuerpo del RUT (módulo 11). */
export function digitoVerificador(cuerpo: string): string {
  let suma = 0;
  let mult = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

/** ¿El RUT existe y su dígito verificador cuadra? */
export function rutValido(raw: string | null | undefined): boolean {
  const n = normalizarRut(raw);
  if (!n) return false;
  const [cuerpo, dv] = n.split('-');
  if (!cuerpo || cuerpo.length < 1) return false;
  return digitoVerificador(cuerpo) === dv;
}

/** Formato de lectura, con puntos: "12.345.678-9". Para mostrar, nunca para guardar. */
export function formatearRut(raw: string | null | undefined): string {
  const n = normalizarRut(raw);
  if (!n) return '';
  const [cuerpo, dv] = n.split('-');
  return `${cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${dv}`;
}

// ---- Normalización del destinatario ---------------------------------------

/** Texto de búsqueda: sin acentos, minúsculas, espacios colapsados. */
export function claveBusqueda(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Valida y normaliza la entrada de un destinatario.
 *
 * `idFor` genera los ids de las direcciones nuevas (las que llegan sin id
 * conservan el suyo, así una edición no rompe las referencias de las órdenes
 * que ya apuntaban a esa dirección).
 */
export function normalizarConsignee(
  input: ConsigneeInput,
  idFor: () => string,
): { razonSocial: string; rut: string | null; nombreFantasia: string | null; direccionComercial: string | null; direcciones: ConsigneeAddress[]; notas: string | null; active: boolean } {
  const razonSocial = String(input.razonSocial ?? '').trim();
  if (!razonSocial) throw new Error('La razón social es obligatoria');
  if (razonSocial.length > 180) throw new Error('La razón social es demasiado larga (máx. 180)');

  let rut: string | null = null;
  const rutRaw = String(input.rut ?? '').trim();
  if (rutRaw) {
    rut = normalizarRut(rutRaw);
    if (!rut) throw new Error(`El RUT "${rutRaw}" no tiene un formato válido`);
    if (!rutValido(rut)) throw new Error(`El RUT ${formatearRut(rut)} no es válido: el dígito verificador no corresponde`);
  }

  const direcciones: ConsigneeAddress[] = [];
  const entradas = input.direcciones ?? [];
  for (const d of entradas) {
    const direccion = String(d.direccion ?? '').trim();
    if (!direccion) continue; // una fila vacía en el formulario no es un error, se ignora
    direcciones.push({
      id: d.id || idFor(),
      alias: String(d.alias ?? '').trim() || direccion.slice(0, 40),
      direccion,
      comuna: txt(d.comuna),
      ciudad: txt(d.ciudad),
      region: txt(d.region),
      contacto: txt(d.contacto),
      telefono: txt(d.telefono),
      notas: txt(d.notas),
      principal: false,
    });
  }
  // Exactamente una principal: la marcada, o la primera si nadie lo está.
  const marcada = entradas.findIndex((d) => d.principal && String(d.direccion ?? '').trim());
  if (direcciones.length) {
    const idx = marcada >= 0 ? Math.min(marcada, direcciones.length - 1) : 0;
    direcciones[idx].principal = true;
  }

  return {
    razonSocial,
    rut,
    nombreFantasia: txt(input.nombreFantasia),
    direccionComercial: txt(input.direccionComercial),
    direcciones,
    notas: txt(input.notas),
    active: input.active !== false,
  };
}

function txt(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

/** La dirección que se propone por defecto (la principal, o la primera). */
export function direccionPrincipal(c: Consignee): ConsigneeAddress | null {
  if (!c.direcciones.length) return null;
  return c.direcciones.find((d) => d.principal) ?? c.direcciones[0];
}

/**
 * Busca un destinatario por lo que venga escrito en una carga masiva.
 *
 * Orden de preferencia: RUT exacto (es el identificador de verdad), luego
 * razón social, luego nombre de fantasía. La comparación de nombres ignora
 * acentos y mayúsculas porque nadie escribe igual dos veces.
 */
export function buscarConsignee(lista: Consignee[], termino: string | null | undefined): Consignee | null {
  const t = String(termino ?? '').trim();
  if (!t) return null;
  const activos = lista.filter((c) => c.active);
  const rut = normalizarRut(t);
  if (rut) {
    const porRut = activos.find((c) => c.rut === rut);
    if (porRut) return porRut;
  }
  const k = claveBusqueda(t);
  if (!k) return null;
  return (
    activos.find((c) => claveBusqueda(c.razonSocial) === k) ??
    activos.find((c) => claveBusqueda(c.nombreFantasia) === k) ??
    null
  );
}

/**
 * Busca una dirección del destinatario por alias, o por el texto de la
 * dirección misma. Sin término, devuelve la principal.
 */
export function buscarDireccion(c: Consignee, termino: string | null | undefined): ConsigneeAddress | null {
  const t = String(termino ?? '').trim();
  if (!t) return direccionPrincipal(c);
  const k = claveBusqueda(t);
  return (
    c.direcciones.find((d) => claveBusqueda(d.alias) === k) ??
    c.direcciones.find((d) => claveBusqueda(d.direccion) === k) ??
    c.direcciones.find((d) => claveBusqueda(d.direccion).includes(k)) ??
    null
  );
}
