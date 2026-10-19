/**
 * BinService — contenedores lógicos (LPN / license plate / handling unit).
 *
 * NOMENCLATURA: en Ninja WMS un **Bin NO es una ubicación**. Es un contenedor
 * identificado (pallet, caja, tote, jaula) que agrupa productos y que se ubica DENTRO
 * de una ubicación. Una ubicación puede tener varios Bins y además stock suelto.
 *
 * Modelo:
 *  - La CABECERA del Bin (número, estado, ubicación, tipo, historial) vive en `bins`.
 *  - El CONTENIDO vive en el ledger: cada movimiento lleva `binId`. Las "líneas" de un
 *    Bin son sus buckets (cliente + SKU + lote + estado). Así el stock por ubicación, por
 *    SKU, el kardex y la facturación cuadran solos, y no hay una segunda verdad del stock.
 *  - La PROPIEDAD es por línea (cada bucket tiene su sellerId). El Bin no tiene dueño:
 *    es "multi-cliente" si sus líneas son de más de un cliente.
 *  - Toda operación que mueve contenido usa `InventoryService.moveBuckets`, que valida
 *    los saldos y escribe todas las patas en UN append (atómico).
 */
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { InventoryService, BucketMove } from './inventory.service';
import { BinRepository, Clock, IdGenerator, LocationRepository, LotRepository, SellerRepository, SkuRepository } from './ports';
import { Bin, BinEstado, BinEvent, BinSettings, Location, MovementType, StockBalance, StockMovement, StockState } from './types';

export const BIN_DEFAULTS: BinSettings = {
  prefix: 'BIN-',
  digits: 6,
  deleteOnEmpty: false,
  tipos: ['pallet', 'caja', 'tote', 'jaula', 'otro'],
  alertPorUbicarHoras: 4,
  alertArmadoHoras: 12,
  bajaOcupacionUnidades: 10,
  prorrateo: 'unidades',
  etiquetaMostrarContenido: true,
  etiquetaOcultarContenidoMulti: true,
  habilitado: true,
};

export const BIN_ESTADO_ES: Record<string, string> = {
  EN_ARMADO: 'En armado', POR_UBICAR: 'Por ubicar', UBICADO: 'Ubicado', EN_MOVIMIENTO: 'En movimiento',
  VACIO: 'Vacío', CONSOLIDADO: 'Consolidado', ELIMINADO: 'Eliminado',
};

/** Estados "muertos": sin contenido posible y sin operaciones. */
const INACTIVOS = new Set<string>([BinEstado.CONSOLIDADO, BinEstado.ELIMINADO]);

/** Una línea del Bin, tal como se muestra (derivada del ledger). */
export interface BinLinea {
  sellerId: string;
  sku: string;
  lot: string | null;
  vencimiento: string | null;
  cantidad: number; // disponible + reservado
  reservada: number;
  disponible: number;
}

export interface BinView {
  id: string;
  numero: string;
  estado: BinEstado;
  estadoTexto: string;
  tipo: string;
  locationId: string | null;
  ubicacion: string | null;
  zona: string | null;
  receiptId: string | null;
  consolidatedIntoId: string | null;
  consolidadoEn: string | null;
  pending: Bin['pending'];
  clientes: string[]; // sellerIds con línea en el Bin (visibles para quien consulta)
  multiCliente: boolean; // calculado sobre TODO el contenido (no solo lo visible)
  lineas: BinLinea[];
  unidades: number;
  reservadas: number;
  skus: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  closedAt: string | null;
  deletedAt: string | null;
}

export interface BinItem { sellerId: string; sku: string; lot?: string | null; qty: number }

export class BinService {
  constructor(
    private readonly bins: BinRepository,
    private readonly inventory: InventoryService,
    private readonly locations: LocationRepository,
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly lots: LotRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {
    inventory.setBinLookup(async (id) => {
      const b = await this.bins.get(id).catch(() => null);
      return b ? { id: b.id, estado: b.estado, locationId: b.locationId } : null;
    });
  }

  // ---- Ajustes ---------------------------------------------------------------------

  async settings(operationId: string): Promise<BinSettings> {
    const s = (await this.bins.getSettings(operationId).catch(() => null)) || {};
    return { ...BIN_DEFAULTS, ...s, tipos: (s.tipos && s.tipos.length ? s.tipos : BIN_DEFAULTS.tipos) };
  }

  async updateSettings(operationId: string, patch: Partial<BinSettings>): Promise<BinSettings> {
    const cur = await this.settings(operationId);
    const next: BinSettings = { ...cur };
    if (patch.prefix != null) {
      const p = String(patch.prefix).trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{0,9}$/.test(p)) throw new ValidationError('El prefijo admite letras, números, guion y guion bajo (máx. 10).');
      next.prefix = p;
    }
    if (patch.digits != null) next.digits = Math.max(3, Math.min(10, Math.round(Number(patch.digits)) || 6));
    if (patch.deleteOnEmpty != null) next.deleteOnEmpty = !!patch.deleteOnEmpty;
    if (patch.tipos != null) {
      const t = (Array.isArray(patch.tipos) ? patch.tipos : String(patch.tipos).split(','))
        .map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      if (!t.length) throw new ValidationError('Define al menos un tipo de Bin.');
      next.tipos = Array.from(new Set(t)).slice(0, 20);
    }
    const nn = (v: unknown, def: number) => (v == null ? def : Math.max(0, Number(v) || 0));
    next.alertPorUbicarHoras = nn(patch.alertPorUbicarHoras, cur.alertPorUbicarHoras);
    next.alertArmadoHoras = nn(patch.alertArmadoHoras, cur.alertArmadoHoras);
    next.bajaOcupacionUnidades = nn(patch.bajaOcupacionUnidades, cur.bajaOcupacionUnidades);
    if (patch.prorrateo != null) {
      if (!['unidades', 'volumen', 'peso', 'iguales'].includes(String(patch.prorrateo))) throw new ValidationError('Prorrateo: unidades, volumen, peso o iguales.');
      next.prorrateo = patch.prorrateo;
    }
    if (patch.etiquetaMostrarContenido != null) next.etiquetaMostrarContenido = !!patch.etiquetaMostrarContenido;
    if (patch.etiquetaOcultarContenidoMulti != null) next.etiquetaOcultarContenidoMulti = !!patch.etiquetaOcultarContenidoMulti;
    if (patch.habilitado != null) next.habilitado = !!patch.habilitado;
    await this.bins.saveSettings(operationId, next);
    return next;
  }

  formatNumero(n: number, s: BinSettings): string { return s.prefix + String(n).padStart(s.digits, '0'); }

  // ---- Crear ------------------------------------------------------------------------

  async create(operationId: string, input: { cantidad?: number; tipo?: string | null; locationId?: string | null; receiptId?: string | null }, actor: string): Promise<Bin[]> {
    const n = Math.round(Number(input.cantidad ?? 1));
    if (!(n >= 1 && n <= 500)) throw new ValidationError('Se pueden crear entre 1 y 500 Bins por vez.');
    const s = await this.settings(operationId);
    const tipo = String(input.tipo || s.tipos[0] || 'pallet').trim().toLowerCase();
    if (!s.tipos.includes(tipo)) throw new ValidationError(`Tipo de Bin no configurado: ${tipo}. Tipos: ${s.tipos.join(', ')}.`);
    let loc: Location | null = null;
    if (input.locationId) loc = await this.mustLocation(operationId, input.locationId);
    const nums = await this.bins.nextNumbers(operationId, n);
    const now = this.clock.now();
    const out: Bin[] = [];
    for (const num of nums) {
      const bin: Bin = {
        id: this.ids.next(), operationId, numero: this.formatNumero(num, s), estado: BinEstado.EN_ARMADO,
        locationId: loc ? loc.id : null, tipo, receiptId: input.receiptId ?? null, consolidatedIntoId: null,
        pending: null, estadoPrevio: null, events: [], createdBy: actor, createdAt: now, updatedAt: now, closedAt: null, deletedAt: null,
      };
      this.ev(bin, 'CREADO', actor, `${tipo}${loc ? ' en ' + loc.code : ''}${input.receiptId ? ' · recepción ' + input.receiptId : ''}`);
      await this.bins.save(bin);
      out.push(bin);
    }
    return out;
  }

  // ---- Leer -------------------------------------------------------------------------

  /** Resuelve un Bin por id o número dentro de la operación (nunca cruza de operación). */
  async get(operationId: string, ref: string): Promise<Bin> {
    const k = String(ref || '').trim();
    if (!k) throw new ValidationError('Falta el número del Bin.');
    let b = await this.bins.get(k).catch(() => null);
    if (!b || b.operationId !== operationId) b = await this.bins.findByNumero(operationId, k);
    if (!b) {
      // Escaneo sin prefijo ("123" → BIN-000123).
      if (/^\d{1,10}$/.test(k)) { const s = await this.settings(operationId); b = await this.bins.findByNumero(operationId, this.formatNumero(Number(k), s)); }
    }
    if (!b || b.operationId !== operationId) throw new NotFoundError(`Bin no encontrado: ${k}`);
    return b;
  }

  async findQuietById(id: string): Promise<Bin | null> { return this.bins.get(id).catch(() => null); }

  async findQuiet(operationId: string, ref: string): Promise<Bin | null> {
    try { return await this.get(operationId, ref); } catch { return null; }
  }

  async balances(binIds: string[]): Promise<StockBalance[]> {
    return (await this.inventory.binBalances(binIds)).filter((b) => b.qty !== 0);
  }

  /** Líneas de un Bin agrupadas por cliente + SKU + lote (disponible + reservado). */
  async lineas(bin: Bin, bal?: StockBalance[]): Promise<BinLinea[]> {
    const rows = (bal ?? await this.balances([bin.id])).filter((b) => b.binId === bin.id);
    const acc = new Map<string, BinLinea>();
    for (const b of rows) {
      if (b.state !== StockState.AVAILABLE && b.state !== StockState.RESERVED) continue;
      const k = `${b.sellerId}|${b.sku}|${b.lot ?? ''}`;
      let l = acc.get(k);
      if (!l) { l = { sellerId: b.sellerId, sku: b.sku, lot: b.lot ?? null, vencimiento: null, cantidad: 0, reservada: 0, disponible: 0 }; acc.set(k, l); }
      l.cantidad += b.qty;
      if (b.state === StockState.RESERVED) l.reservada += b.qty; else l.disponible += b.qty;
    }
    const out = [...acc.values()].filter((l) => l.cantidad !== 0);
    for (const l of out) if (l.lot) l.vencimiento = (await this.lots.get(l.sellerId, l.sku, l.lot).catch(() => null))?.expiryDate ?? null;
    return out.sort((a, b) => (a.sellerId + a.sku + (a.lot || '')).localeCompare(b.sellerId + b.sku + (b.lot || '')));
  }

  /**
   * Vista de un Bin. Con `sellerScope` (usuario del portal del cliente) se ven el Bin y
   * su ubicación, pero SOLO las líneas de ese cliente: nunca el contenido de otros.
   */
  async view(bin: Bin, opts?: { sellerScope?: string | null; bal?: StockBalance[]; locs?: Map<string, Location> }): Promise<BinView> {
    const todas = await this.lineas(bin, opts?.bal);
    const clientesTodos = Array.from(new Set(todas.map((l) => l.sellerId)));
    const lineas = opts?.sellerScope ? todas.filter((l) => l.sellerId === opts.sellerScope) : todas;
    const loc = bin.locationId ? (opts?.locs?.get(bin.locationId) ?? await this.locations.findById(bin.locationId).catch(() => null)) : null;
    const dest = bin.consolidatedIntoId ? await this.bins.get(bin.consolidatedIntoId).catch(() => null) : null;
    return {
      id: bin.id, numero: bin.numero, estado: bin.estado, estadoTexto: BIN_ESTADO_ES[bin.estado] || bin.estado, tipo: bin.tipo,
      locationId: bin.locationId, ubicacion: loc?.code ?? null, zona: loc?.zoneType ?? null,
      receiptId: bin.receiptId, consolidatedIntoId: bin.consolidatedIntoId, consolidadoEn: dest?.numero ?? null, pending: bin.pending,
      clientes: opts?.sellerScope ? clientesTodos.filter((x) => x === opts.sellerScope) : clientesTodos,
      multiCliente: clientesTodos.length > 1,
      lineas,
      unidades: lineas.reduce((t, l) => t + l.cantidad, 0),
      reservadas: lineas.reduce((t, l) => t + l.reservada, 0),
      skus: new Set(lineas.map((l) => l.sku)).size,
      createdAt: bin.createdAt, createdBy: bin.createdBy, updatedAt: bin.updatedAt, closedAt: bin.closedAt, deletedAt: bin.deletedAt,
    };
  }

  /**
   * Listado con filtros. Filtrar por cliente devuelve los Bins con AL MENOS una línea de
   * ese cliente; un usuario cliente (sellerScope) solo ve esos y solo sus líneas.
   */
  async list(operationId: string, f: { sellerId?: string | null; estado?: string | null; locationId?: string | null; sku?: string | null; q?: string | null; sellerScope?: string | null; incluirInactivos?: boolean } = {}): Promise<BinView[]> {
    const estados = f.estado ? String(f.estado).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : undefined;
    let list = await this.bins.list(operationId, { estados, includeDeleted: !!f.incluirInactivos || (estados || []).includes('ELIMINADO') });
    if (!f.incluirInactivos && !estados) list = list.filter((b) => b.estado !== BinEstado.CONSOLIDADO);
    if (f.locationId) list = list.filter((b) => b.locationId === f.locationId);
    if (f.q) { const q = String(f.q).trim().toUpperCase(); list = list.filter((b) => b.numero.toUpperCase().includes(q)); }
    const bal = await this.balances(list.map((b) => b.id));
    const locs = new Map((await this.locations.listByOperation(operationId)).map((l) => [l.id, l] as [string, Location]));
    const cliente = f.sellerScope || f.sellerId || null;
    const out: BinView[] = [];
    for (const b of list) {
      const mine = bal.filter((x) => x.binId === b.id);
      if (cliente && !mine.some((x) => x.sellerId === cliente)) {
        // Un usuario cliente ve SOLO los Bins donde tiene mercadería.
        if (f.sellerScope || f.sellerId) continue;
      }
      if (f.sku && !mine.some((x) => x.sku.toUpperCase() === String(f.sku).trim().toUpperCase() && (!cliente || x.sellerId === cliente))) continue;
      out.push(await this.view(b, { sellerScope: f.sellerScope ?? null, bal: mine, locs }));
    }
    return out;
  }

  /** Historial del Bin: eventos de la cabecera + movimientos del ledger (filtrados por cliente si corresponde). */
  async history(bin: Bin, sellerScope?: string | null): Promise<Array<{ at: string; tipo: string; actor: string; detalle: string | null; sellerId?: string; sku?: string; lot?: string | null; qty?: number; ubicacionId?: string }>> {
    const evs = bin.events.map((e) => ({ at: e.at, tipo: e.type, actor: e.actor, detalle: e.detail ?? null }));
    const movs = (await this.inventory.findBinMovements(bin.id))
      .filter((m) => m.qtyDelta !== 0 && (!sellerScope || m.sellerId === sellerScope))
      // Las reservas son un cambio de estado dentro del mismo Bin: no aportan a la línea de tiempo física.
      .filter((m) => m.type !== MovementType.RESERVE && m.type !== MovementType.RELEASE)
      .map((m) => ({ at: m.occurredAt, tipo: `MOV:${m.type}`, actor: m.actor, detalle: m.reference ?? null, sellerId: m.sellerId, sku: m.sku, lot: m.lot ?? null, qty: m.qtyDelta, ubicacionId: m.locationId }));
    return [...evs, ...movs].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  // ---- Recepción hacia Bin ------------------------------------------------------------

  /**
   * Antes de recibir dentro de un Bin: el Bin debe estar EN_ARMADO y queda en la
   * ubicación de recepción. Devuelve el Bin listo para recibir.
   */
  async prepareReceive(operationId: string, ref: string, receivingLocationId: string, receiptId: string | null, actor: string): Promise<Bin> {
    const bin = await this.get(operationId, ref);
    if (bin.estado !== BinEstado.EN_ARMADO) throw new ValidationError(`El Bin ${bin.numero} está ${BIN_ESTADO_ES[bin.estado]}: solo se recibe en un Bin EN ARMADO. Crea uno nuevo o reábrelo.`);
    if (bin.locationId && bin.locationId !== receivingLocationId) {
      const cur = await this.locations.findById(bin.locationId).catch(() => null);
      const content = await this.balances([bin.id]);
      if (content.length) throw new ValidationError(`El Bin ${bin.numero} está en ${cur?.code ?? 'otra ubicación'} y ya tiene contenido: no puede recibir en otra ubicación.`);
    }
    if (bin.locationId !== receivingLocationId || (receiptId && !bin.receiptId)) {
      bin.locationId = receivingLocationId;
      if (receiptId && !bin.receiptId) bin.receiptId = receiptId;
      bin.updatedAt = this.clock.now();
      await this.bins.save(bin);
    }
    return bin;
  }

  async noteReceived(bin: Bin, detail: string, actor: string): Promise<void> {
    const b = await this.bins.get(bin.id);
    if (!b) return;
    this.ev(b, 'RECEPCIÓN', actor, detail);
    await this.bins.save(b);
  }

  /** Cierra el Bin (EN_ARMADO → POR_UBICAR). Debe tener contenido. */
  async close(operationId: string, ref: string, actor: string): Promise<Bin> {
    const bin = await this.get(operationId, ref);
    if (bin.estado !== BinEstado.EN_ARMADO) throw new ValidationError(`El Bin ${bin.numero} está ${BIN_ESTADO_ES[bin.estado]}: solo se cierra uno EN ARMADO.`);
    const lineas = await this.lineas(bin);
    if (!lineas.length) throw new ValidationError(`El Bin ${bin.numero} está vacío: agrégale contenido antes de cerrarlo.`);
    bin.estado = BinEstado.POR_UBICAR;
    bin.closedAt = this.clock.now();
    this.ev(bin, 'CERRADO', actor, `${lineas.reduce((t, l) => t + l.cantidad, 0)} un · ${lineas.length} línea(s) — esperando putaway`);
    await this.bins.save(bin);
    return bin;
  }

  /** Reabre un Bin cerrado que aún no se ubica (POR_UBICAR → EN_ARMADO). */
  async reopen(operationId: string, ref: string, actor: string): Promise<Bin> {
    const bin = await this.get(operationId, ref);
    if (bin.estado !== BinEstado.POR_UBICAR) throw new ValidationError(`Solo se reabre un Bin POR UBICAR (este está ${BIN_ESTADO_ES[bin.estado]}).`);
    bin.estado = BinEstado.EN_ARMADO;
    bin.closedAt = null;
    this.ev(bin, 'REABIERTO', actor, null);
    await this.bins.save(bin);
    return bin;
  }

  // ---- Ubicar / mover el Bin completo ---------------------------------------------

  /**
   * Lleva el Bin COMPLETO a una ubicación con un solo movimiento: todas sus líneas
   * (de todos los clientes, disponibles y reservadas) viajan juntas en un traslado
   * atómico. Las reservas siguen al Bin (el caller actualiza las órdenes).
   * `viaTarea` = lo ejecuta la tarea de putaway/traslado que tiene al Bin EN_MOVIMIENTO.
   */
  async place(operationId: string, ref: string, toLocationId: string, actor: string, opts?: { viaTarea?: boolean; tipo?: 'PUTAWAY' | 'MOVE' }): Promise<{ bin: Bin; desde: string | null; hacia: string; reservadoPorCliente: Record<string, number> }> {
    const bin = await this.get(operationId, ref);
    this.assertOperable(bin);
    if (bin.estado === BinEstado.EN_MOVIMIENTO && !opts?.viaTarea) {
      throw new ValidationError(`El Bin ${bin.numero} tiene un traslado o consolidación en curso: termínalo o cancélalo antes de moverlo.`);
    }
    if (bin.estado === BinEstado.EN_ARMADO) throw new ValidationError(`El Bin ${bin.numero} sigue EN ARMADO: ciérralo antes de ubicarlo.`);
    const dest = await this.mustLocation(operationId, toLocationId);
    if (dest.id === bin.locationId) throw new ValidationError(`El Bin ${bin.numero} ya está en ${dest.code}.`);
    const bal = (await this.balances([bin.id])).filter((b) => b.qty > 0);
    const reservadoPorCliente: Record<string, number> = {};
    const moves: BucketMove[] = bal.map((b) => {
      if (b.state === StockState.RESERVED) reservadoPorCliente[b.sellerId] = (reservadoPorCliente[b.sellerId] || 0) + b.qty;
      return { sellerId: b.sellerId, sku: b.sku, lot: b.lot ?? null, state: b.state, qty: b.qty, fromLocationId: b.locationId, fromBinId: bin.id, toLocationId: dest.id, toBinId: bin.id };
    });
    const desde = bin.locationId;
    const kind = opts?.tipo || (bin.estado === BinEstado.POR_UBICAR ? 'PUTAWAY' : 'MOVE');
    if (moves.length) await this.inventory.moveBuckets(moves, { type: kind === 'PUTAWAY' ? MovementType.PUTAWAY : MovementType.TRANSFER, reference: `BIN ${bin.numero}`, actor });
    const fresh = (await this.bins.get(bin.id))!;
    const desdeCode = desde ? (await this.locations.findById(desde).catch(() => null))?.code ?? null : null;
    fresh.locationId = dest.id;
    fresh.estado = moves.length ? BinEstado.UBICADO : BinEstado.VACIO;
    fresh.estadoPrevio = null;
    if (fresh.pending?.kind === 'MOVE') fresh.pending = null;
    this.ev(fresh, kind === 'PUTAWAY' ? 'UBICADO' : 'MOVIDO', actor, `${desdeCode ? desdeCode + ' → ' : ''}${dest.code} · ${moves.reduce((t, m) => t + m.qty, 0)} un`);
    await this.bins.save(fresh);
    return { bin: fresh, desde, hacia: dest.id, reservadoPorCliente };
  }

  /** Pide un traslado como TAREA: el Bin queda EN_MOVIMIENTO (bloqueado) hasta ejecutarla. */
  async requestMove(operationId: string, ref: string, toLocationId: string | null, actor: string, note?: string | null): Promise<Bin> {
    const bin = await this.get(operationId, ref);
    this.assertOperable(bin);
    if (bin.estado === BinEstado.EN_MOVIMIENTO) throw new ValidationError(`El Bin ${bin.numero} ya tiene un movimiento en curso.`);
    if (bin.estado === BinEstado.EN_ARMADO) throw new ValidationError(`El Bin ${bin.numero} sigue EN ARMADO: ciérralo primero.`);
    let dest: Location | null = null;
    if (toLocationId) { dest = await this.mustLocation(operationId, toLocationId); if (dest.id === bin.locationId) throw new ValidationError(`El Bin ${bin.numero} ya está en ${dest.code}.`); }
    bin.estadoPrevio = bin.estado;
    bin.estado = BinEstado.EN_MOVIMIENTO;
    bin.pending = { kind: 'MOVE', toLocationId: dest ? dest.id : null, requestedBy: actor, requestedAt: this.clock.now(), note: note ?? null };
    this.ev(bin, 'TRASLADO PEDIDO', actor, dest ? `hacia ${dest.code}` : 'destino a elección del operario');
    await this.bins.save(bin);
    return bin;
  }

  /** Cancela un traslado o consolidación pendiente: el Bin (y los involucrados) vuelve a su estado. */
  async cancelPending(operationId: string, ref: string, actor: string): Promise<Bin> {
    let bin = await this.get(operationId, ref);
    if (!bin.pending) throw new ValidationError(`El Bin ${bin.numero} no tiene trabajo pendiente.`);
    // Cancelar desde un Bin ORIGEN cancela la consolidación completa (vive en el destino).
    if (bin.pending.kind === 'CONSOLIDATE' && bin.pending.intoBinId) bin = await this.get(operationId, bin.pending.intoBinId);
    if (!bin.pending) throw new ValidationError(`El Bin ${bin.numero} no tiene trabajo pendiente.`);
    const srcs = bin.pending.kind === 'CONSOLIDATE' ? bin.pending.sourceBinIds || [] : [];
    for (const id of srcs) {
      const s = await this.bins.get(id);
      if (s && s.estado === BinEstado.EN_MOVIMIENTO) { s.estado = s.estadoPrevio || BinEstado.UBICADO; s.estadoPrevio = null; s.pending = null; this.ev(s, 'CONSOLIDACIÓN CANCELADA', actor, `hacia ${bin.numero}`); await this.bins.save(s); }
    }
    this.restorePrev(bin);
    this.ev(bin, bin.pending.kind === 'MOVE' ? 'TRASLADO CANCELADO' : 'CONSOLIDACIÓN CANCELADA', actor, null);
    bin.pending = null;
    await this.bins.save(bin);
    return bin;
  }

  // ---- Contenido: suelto ↔ Bin, Bin ↔ Bin ---------------------------------------------

  /** Pasa stock SUELTO de una ubicación a un Bin (el stock debe estar donde está el Bin). */
  async addLoose(operationId: string, ref: string, fromLocationId: string, items: BinItem[], actor: string): Promise<Bin> {
    const bin = await this.get(operationId, ref);
    this.assertOperable(bin);
    if (bin.estado === BinEstado.EN_MOVIMIENTO) throw new ValidationError(`El Bin ${bin.numero} está en movimiento.`);
    const from = await this.mustLocation(operationId, fromLocationId);
    if (bin.locationId && bin.locationId !== from.id) {
      const cur = await this.locations.findById(bin.locationId).catch(() => null);
      throw new ValidationError(`El Bin ${bin.numero} está en ${cur?.code ?? '?'}: solo puede recibir stock de esa ubicación (mueve el Bin o el stock primero).`);
    }
    await this.assertSellersOfOperation(operationId, items.map((i) => i.sellerId));
    const moves: BucketMove[] = items.map((i) => ({ sellerId: i.sellerId, sku: i.sku, lot: i.lot ?? null, state: StockState.AVAILABLE, qty: Number(i.qty), fromLocationId: from.id, fromBinId: null, toLocationId: from.id, toBinId: bin.id }));
    await this.inventory.moveBuckets(moves, { type: MovementType.TRANSFER, reference: `A BIN ${bin.numero}`, actor });
    const fresh = (await this.bins.get(bin.id))!;
    if (!fresh.locationId) fresh.locationId = from.id;
    if (fresh.estado === BinEstado.VACIO) fresh.estado = BinEstado.UBICADO;
    this.ev(fresh, 'CONTENIDO AGREGADO', actor, `${items.map((i) => `${i.qty} ${i.sku}`).join(', ')} desde stock suelto de ${from.code}`);
    await this.bins.save(fresh);
    return fresh;
  }

  /** Saca contenido DISPONIBLE de un Bin y lo deja suelto en la ubicación del Bin (o en otra). */
  async removeToLoose(operationId: string, ref: string, items: BinItem[], actor: string, toLocationId?: string | null): Promise<Bin> {
    const bin = await this.get(operationId, ref);
    this.assertOperable(bin);
    if (bin.estado === BinEstado.EN_MOVIMIENTO) throw new ValidationError(`El Bin ${bin.numero} está en movimiento.`);
    if (!bin.locationId) throw new ValidationError(`El Bin ${bin.numero} no tiene ubicación: no hay dónde dejar el stock suelto.`);
    const dest = toLocationId ? await this.mustLocation(operationId, toLocationId) : await this.mustLocation(operationId, bin.locationId);
    const moves: BucketMove[] = items.map((i) => ({ sellerId: i.sellerId, sku: i.sku, lot: i.lot ?? null, state: StockState.AVAILABLE, qty: Number(i.qty), fromLocationId: bin.locationId!, fromBinId: bin.id, toLocationId: dest.id, toBinId: null }));
    await this.inventory.moveBuckets(moves, { type: MovementType.TRANSFER, reference: `DESDE BIN ${bin.numero}`, actor });
    const fresh = (await this.bins.get(bin.id))!;
    this.ev(fresh, 'CONTENIDO RETIRADO', actor, `${items.map((i) => `${i.qty} ${i.sku}`).join(', ')} → suelto en ${dest.code}`);
    await this.bins.save(fresh);
    await this.refreshEmpty(fresh.id, actor, 'quedó sin contenido al retirar');
    return (await this.bins.get(bin.id))!;
  }

  /**
   * Transfiere líneas (o cantidades parciales) DISPONIBLES de un Bin a otro. Sin items,
   * transfiere todo lo disponible. Si el destino no tiene ubicación, toma la del origen.
   * Ambos deben estar en la misma ubicación (si no, es una consolidación con tarea).
   */
  async transfer(operationId: string, fromRef: string, toRef: string, items: BinItem[] | null, actor: string): Promise<{ desde: Bin; hacia: Bin; unidades: number }> {
    const src = await this.get(operationId, fromRef);
    const dst = await this.get(operationId, toRef);
    if (src.id === dst.id) throw new ValidationError('El Bin de origen y el de destino son el mismo.');
    for (const b of [src, dst]) { this.assertOperable(b); if (b.estado === BinEstado.EN_MOVIMIENTO) throw new ValidationError(`El Bin ${b.numero} está en movimiento.`); }
    if (!src.locationId) throw new ValidationError(`El Bin ${src.numero} no tiene ubicación.`);
    if (dst.locationId && dst.locationId !== src.locationId) throw new ValidationError(`Los Bins ${src.numero} y ${dst.numero} están en ubicaciones distintas: júntalos primero (o usa una consolidación con tarea).`);
    const bal = (await this.balances([src.id])).filter((b) => b.state === StockState.AVAILABLE && b.qty > 0);
    let moves: BucketMove[];
    if (!items || !items.length) {
      moves = bal.map((b) => ({ sellerId: b.sellerId, sku: b.sku, lot: b.lot ?? null, state: StockState.AVAILABLE, qty: b.qty, fromLocationId: src.locationId!, fromBinId: src.id, toLocationId: src.locationId!, toBinId: dst.id }));
    } else {
      moves = items.map((i) => ({ sellerId: i.sellerId, sku: i.sku, lot: i.lot ?? null, state: StockState.AVAILABLE, qty: Number(i.qty), fromLocationId: src.locationId!, fromBinId: src.id, toLocationId: src.locationId!, toBinId: dst.id }));
    }
    if (!moves.length) throw new ValidationError(`El Bin ${src.numero} no tiene stock disponible para transferir (lo reservado no se transfiere).`);
    await this.inventory.moveBuckets(moves, { type: MovementType.TRANSFER, reference: `BIN ${src.numero} → ${dst.numero}`, actor });
    const unidades = moves.reduce((t, m) => t + m.qty, 0);
    const s2 = (await this.bins.get(src.id))!, d2 = (await this.bins.get(dst.id))!;
    if (!d2.locationId) d2.locationId = src.locationId;
    if (d2.estado === BinEstado.VACIO) d2.estado = s2.estado === BinEstado.POR_UBICAR ? BinEstado.POR_UBICAR : BinEstado.UBICADO;
    this.ev(s2, 'TRANSFERENCIA', actor, `${unidades} un → ${d2.numero}`);
    this.ev(d2, 'TRANSFERENCIA', actor, `${unidades} un ← ${s2.numero}`);
    await this.bins.save(s2); await this.bins.save(d2);
    await this.refreshEmpty(s2.id, actor, `quedó sin contenido al transferir a ${d2.numero}`);
    return { desde: (await this.bins.get(src.id))!, hacia: (await this.bins.get(dst.id))!, unidades };
  }

  // ---- Consolidar ----------------------------------------------------------------

  /**
   * Consolida N Bins en un destino (existente o nuevo). Las líneas se agrupan solas por
   * cliente + SKU + lote (son buckets del ledger): nunca se fusionan líneas de clientes
   * distintos. Lo reservado viaja también (el caller actualiza las órdenes).
   *  - Todos en la misma ubicación que el destino → se ejecuta al instante.
   *  - En ubicaciones distintas → queda una TAREA para juntarlos (todos EN_MOVIMIENTO).
   */
  async consolidate(operationId: string, sourceRefs: string[], destRef: string | null, actor: string, opts?: { tipo?: string | null; forzarTarea?: boolean }): Promise<{ destino: Bin; ejecutada: boolean; origenes: Bin[]; movidos: Array<{ fromBinId: string; sellerId: string; reservado: number }> }> {
    const refs = Array.from(new Set((sourceRefs || []).map((x) => String(x).trim()).filter(Boolean)));
    if (!refs.length) throw new ValidationError('Indica los Bins a consolidar.');
    const srcs: Bin[] = [];
    for (const r of refs) srcs.push(await this.get(operationId, r));
    let dst: Bin;
    if (destRef) dst = await this.get(operationId, destRef);
    else {
      const loc = srcs[0].locationId;
      dst = (await this.create(operationId, { cantidad: 1, tipo: opts?.tipo ?? srcs[0].tipo, locationId: loc }, actor))[0];
      dst.estado = BinEstado.UBICADO; dst.closedAt = this.clock.now();
      await this.bins.save(dst);
    }
    const origenes = srcs.filter((s) => s.id !== dst.id);
    if (!origenes.length) throw new ValidationError('El destino no puede ser el único Bin de origen.');
    for (const b of [...origenes, dst]) {
      this.assertOperable(b);
      if (b.estado === BinEstado.EN_MOVIMIENTO) throw new ValidationError(`El Bin ${b.numero} ya está en un movimiento o consolidación en curso.`);
      if (b.estado === BinEstado.EN_ARMADO && b.id !== dst.id) throw new ValidationError(`El Bin ${b.numero} sigue EN ARMADO: ciérralo antes de consolidarlo.`);
    }
    const destLoc = dst.locationId || origenes[0].locationId;
    const todosJuntos = origenes.every((o) => o.locationId && o.locationId === destLoc);
    if (!todosJuntos || opts?.forzarTarea) {
      // Tarea física: el operario junta los Bins. Todos quedan bloqueados.
      for (const o of origenes) {
        o.estadoPrevio = o.estado; o.estado = BinEstado.EN_MOVIMIENTO;
        o.pending = { kind: 'CONSOLIDATE', intoBinId: dst.id, requestedBy: actor, requestedAt: this.clock.now() };
        this.ev(o, 'CONSOLIDACIÓN PEDIDA', actor, `hacia ${dst.numero}`); await this.bins.save(o);
      }
      dst.estadoPrevio = dst.estado; dst.estado = BinEstado.EN_MOVIMIENTO;
      dst.pending = { kind: 'CONSOLIDATE', sourceBinIds: origenes.map((o) => o.id), toLocationId: destLoc ?? null, requestedBy: actor, requestedAt: this.clock.now() };
      if (!dst.locationId && destLoc) dst.locationId = destLoc;
      this.ev(dst, 'CONSOLIDACIÓN PEDIDA', actor, `absorberá ${origenes.map((o) => o.numero).join(', ')}`);
      await this.bins.save(dst);
      return { destino: dst, ejecutada: false, origenes, movidos: [] };
    }
    const r = await this.executeConsolidation(operationId, dst.id, origenes.map((o) => o.id), actor);
    return { ...r, ejecutada: true };
  }

  /** Ejecuta la consolidación (directa o al cerrar la tarea): todo el contenido pasa al destino. */
  async executeConsolidation(operationId: string, destId: string, sourceIds: string[], actor: string): Promise<{ destino: Bin; origenes: Bin[]; movidos: Array<{ fromBinId: string; sellerId: string; reservado: number }> }> {
    const dst = await this.get(operationId, destId);
    const srcs: Bin[] = [];
    for (const id of sourceIds) srcs.push(await this.get(operationId, id));
    const destLoc = dst.locationId || srcs[0]?.locationId;
    if (!destLoc) throw new ValidationError('No se sabe en qué ubicación queda el Bin destino.');
    const bal = (await this.balances(srcs.map((s) => s.id))).filter((b) => b.qty > 0);
    const moves: BucketMove[] = bal.map((b) => ({ sellerId: b.sellerId, sku: b.sku, lot: b.lot ?? null, state: b.state, qty: b.qty, fromLocationId: b.locationId, fromBinId: b.binId!, toLocationId: destLoc, toBinId: dst.id }));
    const movidos: Array<{ fromBinId: string; sellerId: string; reservado: number }> = [];
    for (const b of bal) if (b.state === StockState.RESERVED) movidos.push({ fromBinId: b.binId!, sellerId: b.sellerId, reservado: b.qty });
    if (moves.length) await this.inventory.moveBuckets(moves, { type: MovementType.TRANSFER, reference: `CONSOLIDA → ${dst.numero}`, actor });
    const unidades = moves.reduce((t, m) => t + m.qty, 0);
    const now = this.clock.now();
    const outs: Bin[] = [];
    for (const s of srcs) {
      const f = (await this.bins.get(s.id))!;
      f.estado = BinEstado.CONSOLIDADO; f.estadoPrevio = null; f.consolidatedIntoId = dst.id; f.pending = null; f.updatedAt = now;
      this.ev(f, 'CONSOLIDADO', actor, `contenido absorbido por ${dst.numero}`);
      await this.bins.save(f); outs.push(f);
    }
    const d = (await this.bins.get(dst.id))!;
    d.locationId = destLoc;
    d.estado = d.estadoPrevio && d.estadoPrevio !== BinEstado.EN_MOVIMIENTO ? (d.estadoPrevio === BinEstado.VACIO || d.estadoPrevio === BinEstado.EN_ARMADO ? BinEstado.UBICADO : d.estadoPrevio) : (d.estado === BinEstado.EN_MOVIMIENTO || d.estado === BinEstado.VACIO || d.estado === BinEstado.EN_ARMADO ? BinEstado.UBICADO : d.estado);
    d.estadoPrevio = null; d.pending = null;
    if (!d.closedAt) d.closedAt = now;
    this.ev(d, 'CONSOLIDACIÓN', actor, `absorbió ${srcs.map((s) => s.numero).join(', ')} · ${unidades} un`);
    await this.bins.save(d);
    return { destino: d, origenes: outs, movidos };
  }

  // ---- Eliminar / desarmar -------------------------------------------------------

  /** Elimina un Bin VACÍO (borrado lógico). Con contenido hay que desarmarlo primero. */
  async remove(operationId: string, ref: string, actor: string): Promise<Bin> {
    const bin = await this.get(operationId, ref);
    if (bin.estado === BinEstado.ELIMINADO) return bin;
    if (bin.estado === BinEstado.EN_MOVIMIENTO) throw new ValidationError(`El Bin ${bin.numero} está en movimiento: cancela ese trabajo antes de eliminarlo.`);
    const bal = await this.balances([bin.id]);
    if (bal.some((b) => b.qty > 0)) {
      const u = bal.reduce((t, b) => t + Math.max(0, b.qty), 0);
      throw new ValidationError(`El Bin ${bin.numero} tiene ${u} un: desármalo (pasa su contenido a stock suelto o a otro Bin) antes de eliminarlo.`);
    }
    bin.estado = BinEstado.ELIMINADO; bin.deletedAt = this.clock.now(); bin.pending = null; bin.estadoPrevio = null;
    this.ev(bin, 'ELIMINADO', actor, null);
    await this.bins.save(bin);
    return bin;
  }

  /**
   * Desarma un Bin: TODO su contenido pasa a stock suelto en su ubicación actual (o a
   * otro Bin) y luego se elimina. Nunca se pierde stock. Bloqueado si tiene reservas.
   */
  async unpack(operationId: string, ref: string, actor: string, opts?: { toBinRef?: string | null }): Promise<{ bin: Bin; unidades: number; destino: string }> {
    const bin = await this.get(operationId, ref);
    this.assertOperable(bin);
    if (bin.estado === BinEstado.EN_MOVIMIENTO) throw new ValidationError(`El Bin ${bin.numero} está en movimiento.`);
    const bal = (await this.balances([bin.id])).filter((b) => b.qty > 0);
    const res = bal.filter((b) => b.state === StockState.RESERVED).reduce((t, b) => t + b.qty, 0);
    if (res > 0) throw new ValidationError(`El Bin ${bin.numero} tiene ${res} un reservadas para órdenes en curso: no se puede desarmar ni eliminar hasta pickearlas o liberarlas.`);
    let destino = 'stock suelto';
    let unidades = 0;
    if (bal.length) {
      if (opts?.toBinRef) {
        const r = await this.transfer(operationId, bin.id, opts.toBinRef, null, actor);
        unidades = r.unidades; destino = r.hacia.numero;
      } else {
        if (!bin.locationId) throw new ValidationError(`El Bin ${bin.numero} no tiene ubicación: indica otro Bin de destino.`);
        const moves: BucketMove[] = bal.map((b) => ({ sellerId: b.sellerId, sku: b.sku, lot: b.lot ?? null, state: b.state, qty: b.qty, fromLocationId: b.locationId, fromBinId: bin.id, toLocationId: b.locationId, toBinId: null }));
        await this.inventory.moveBuckets(moves, { type: MovementType.TRANSFER, reference: `DESARMA ${bin.numero}`, actor });
        unidades = moves.reduce((t, m) => t + m.qty, 0);
        destino = 'stock suelto en ' + ((await this.locations.findById(bin.locationId).catch(() => null))?.code ?? '?');
      }
    }
    const f = (await this.bins.get(bin.id))!;
    f.estado = BinEstado.ELIMINADO; f.deletedAt = this.clock.now(); f.pending = null; f.estadoPrevio = null;
    this.ev(f, 'DESARMADO', actor, `${unidades} un → ${destino}`);
    this.ev(f, 'ELIMINADO', actor, null);
    await this.bins.save(f);
    return { bin: f, unidades, destino };
  }

  // ---- Conteo ---------------------------------------------------------------------

  /** Valida solo que el Bin está donde el sistema dice (conteo rápido). */
  async validatePresence(operationId: string, ref: string, locationId: string, actor: string): Promise<{ bin: Bin; ok: boolean; esperado: string | null; encontrado: string }> {
    const bin = await this.get(operationId, ref);
    const loc = await this.mustLocation(operationId, locationId);
    const ok = bin.locationId === loc.id;
    const esperado = bin.locationId ? (await this.locations.findById(bin.locationId).catch(() => null))?.code ?? null : null;
    this.ev(bin, 'CONTEO DE PRESENCIA', actor, ok ? `confirmado en ${loc.code}` : `NO está donde dice el sistema: esperado ${esperado ?? '—'}, encontrado en ${loc.code}`);
    await this.bins.save(bin);
    return { bin, ok, esperado, encontrado: loc.code };
  }

  async noteCount(binId: string, actor: string, detail: string): Promise<void> {
    const b = await this.bins.get(binId); if (!b) return;
    this.ev(b, 'CONTEO', actor, detail);
    await this.bins.save(b);
  }

  // ---- Estados automáticos ----------------------------------------------------------

  /**
   * Tras un picking, ajuste o transferencia: si el Bin quedó sin contenido pasa a VACÍO
   * (o directo a ELIMINADO si la operación lo configura).
   */
  async refreshEmpty(binId: string, actor: string, motivo = 'quedó sin contenido'): Promise<Bin | null> {
    const b = await this.bins.get(binId);
    if (!b || INACTIVOS.has(b.estado) || b.estado === BinEstado.VACIO || b.estado === BinEstado.EN_ARMADO || b.estado === BinEstado.EN_MOVIMIENTO) return b;
    const bal = await this.balances([binId]);
    if (bal.some((x) => x.qty > 0)) return b;
    const s = await this.settings(b.operationId);
    b.estado = s.deleteOnEmpty ? BinEstado.ELIMINADO : BinEstado.VACIO;
    if (s.deleteOnEmpty) b.deletedAt = this.clock.now();
    this.ev(b, s.deleteOnEmpty ? 'ELIMINADO' : 'VACÍO', actor, `${motivo}${s.deleteOnEmpty ? ' (configuración: eliminar al vaciarse)' : ''}`);
    await this.bins.save(b);
    return b;
  }

  /** El operario empezó el putaway: el Bin queda EN_MOVIMIENTO (bloqueado para otros movimientos). */
  async markPutawayStarted(binId: string, actor: string): Promise<void> {
    const b = await this.bins.get(binId);
    if (!b || b.estado !== BinEstado.POR_UBICAR) return;
    b.estadoPrevio = BinEstado.POR_UBICAR; b.estado = BinEstado.EN_MOVIMIENTO;
    this.ev(b, 'PUTAWAY EN CURSO', actor, null);
    await this.bins.save(b);
  }
  /** Se soltó la tarea de putaway sin terminarla: vuelve a POR_UBICAR. */
  async revertPutawayStarted(binId: string, actor: string): Promise<void> {
    const b = await this.bins.get(binId);
    if (!b || b.estado !== BinEstado.EN_MOVIMIENTO || b.pending) return;
    b.estado = b.estadoPrevio || BinEstado.POR_UBICAR; b.estadoPrevio = null;
    this.ev(b, 'PUTAWAY LIBERADO', actor, 'la tarea volvió a la cola');
    await this.bins.save(b);
  }

  async notePick(binId: string, actor: string, detail: string): Promise<void> {
    const b = await this.bins.get(binId); if (!b) return;
    this.ev(b, 'PICK', actor, detail);
    await this.bins.save(b);
    await this.refreshEmpty(binId, actor, 'se vació por picking');
  }

  // ---- Consultas para el agente / copiloto ------------------------------------------

  async porUbicar(operationId: string): Promise<BinView[]> { return this.list(operationId, { estado: 'POR_UBICAR' }); }
  async vacios(operationId: string): Promise<BinView[]> { return this.list(operationId, { estado: 'VACIO' }); }
  async bajaOcupacion(operationId: string, umbral?: number): Promise<Array<BinView & { mismaUbicacionCon: string[] }>> {
    const s = await this.settings(operationId);
    const lim = umbral ?? s.bajaOcupacionUnidades;
    const ubicados = (await this.list(operationId, { estado: 'UBICADO' })).filter((b) => b.unidades > 0 && b.unidades < lim);
    return ubicados.map((b) => ({ ...b, mismaUbicacionCon: ubicados.filter((x) => x.id !== b.id && x.locationId === b.locationId).map((x) => x.numero) }));
  }

  /**
   * Propuesta de consolidación: agrupa Bins de baja ocupación que comparten ubicación
   * (sin traslado) y, en segundo lugar, los del mismo cliente en ubicaciones distintas.
   */
  async proponerConsolidacion(operationId: string, umbral?: number): Promise<Array<{ destino: string; origenes: string[]; ubicacion: string | null; unidades: number; requiereTraslado: boolean; motivo: string }>> {
    const cands = await this.bajaOcupacion(operationId, umbral);
    const out: Array<{ destino: string; origenes: string[]; ubicacion: string | null; unidades: number; requiereTraslado: boolean; motivo: string }> = [];
    const usados = new Set<string>();
    const porLoc = new Map<string, typeof cands>();
    for (const c of cands) { const k = c.locationId || ''; const a = porLoc.get(k) || []; a.push(c); porLoc.set(k, a); }
    for (const [, grupo] of porLoc) {
      if (grupo.length < 2) continue;
      const ord = grupo.slice().sort((a, b) => b.unidades - a.unidades);
      out.push({ destino: ord[0].numero, origenes: ord.slice(1).map((x) => x.numero), ubicacion: ord[0].ubicacion, unidades: ord.reduce((t, x) => t + x.unidades, 0), requiereTraslado: false, motivo: `${ord.length} Bins con menos de ${umbral ?? (await this.settings(operationId)).bajaOcupacionUnidades} un en la misma ubicación` });
      ord.forEach((x) => usados.add(x.id));
    }
    const resto = cands.filter((c) => !usados.has(c.id));
    const porCliente = new Map<string, typeof cands>();
    for (const c of resto) if (c.clientes.length === 1) { const a = porCliente.get(c.clientes[0]) || []; a.push(c); porCliente.set(c.clientes[0], a); }
    for (const [cli, grupo] of porCliente) {
      if (grupo.length < 2) continue;
      const ord = grupo.slice().sort((a, b) => b.unidades - a.unidades);
      out.push({ destino: ord[0].numero, origenes: ord.slice(1).map((x) => x.numero), ubicacion: ord[0].ubicacion, unidades: ord.reduce((t, x) => t + x.unidades, 0), requiereTraslado: true, motivo: `Bins del mismo cliente (${cli}) con baja ocupación en ubicaciones distintas` });
    }
    return out;
  }

  /** Bins atascados para las alertas del agente. */
  async atascados(operationId: string): Promise<{ porUbicar: Array<{ numero: string; horas: number; ubicacion: string | null }>; armadoAbandonado: Array<{ numero: string; horas: number; ubicacion: string | null }> }> {
    const s = await this.settings(operationId);
    const now = Date.parse(this.clock.now());
    const all = await this.bins.list(operationId, { estados: ['POR_UBICAR', 'EN_ARMADO'] });
    const locs = new Map((await this.locations.listByOperation(operationId)).map((l) => [l.id, l.code] as [string, string]));
    const porUbicar: Array<{ numero: string; horas: number; ubicacion: string | null }> = [];
    const armadoAbandonado: Array<{ numero: string; horas: number; ubicacion: string | null }> = [];
    for (const b of all) {
      const ult = b.events.length ? b.events[b.events.length - 1].at : b.updatedAt;
      if (b.estado === BinEstado.POR_UBICAR) {
        const h = (now - Date.parse(b.closedAt || ult)) / 3600000;
        if (s.alertPorUbicarHoras > 0 && h >= s.alertPorUbicarHoras) porUbicar.push({ numero: b.numero, horas: Math.round(h * 10) / 10, ubicacion: b.locationId ? locs.get(b.locationId) ?? null : null });
      } else {
        const h = (now - Date.parse(ult)) / 3600000;
        if (s.alertArmadoHoras > 0 && h >= s.alertArmadoHoras) armadoAbandonado.push({ numero: b.numero, horas: Math.round(h * 10) / 10, ubicacion: b.locationId ? locs.get(b.locationId) ?? null : null });
      }
    }
    return { porUbicar, armadoAbandonado };
  }

  // ---- Etiqueta ---------------------------------------------------------------------

  async label(operationId: string, ref: string): Promise<{ numero: string; fecha: string; tipo: string; cliente: string; contenido: Array<{ sku: string; lot: string | null; cantidad: number }> | null }> {
    const bin = await this.get(operationId, ref);
    const s = await this.settings(operationId);
    const lineas = await this.lineas(bin);
    const clientes = Array.from(new Set(lineas.map((l) => l.sellerId)));
    let cliente = '—';
    if (clientes.length === 1) cliente = (await this.sellers.findById(clientes[0]).catch(() => null))?.name || clientes[0];
    else if (clientes.length > 1) cliente = 'Multi-cliente';
    const ocultar = !s.etiquetaMostrarContenido || (clientes.length > 1 && s.etiquetaOcultarContenidoMulti);
    return {
      numero: bin.numero, fecha: bin.createdAt, tipo: bin.tipo, cliente,
      contenido: ocultar ? null : lineas.map((l) => ({ sku: l.sku, lot: l.lot, cantidad: l.cantidad })),
    };
  }

  // ---- Facturación: almacenaje por Bin-día --------------------------------------------

  /**
   * Cargo de almacenaje por Bin-día de UN cliente en [from, to). Se cobra cada día en
   * que el Bin estuvo UBICADO (en algún momento del día, en hora de la bodega). En un
   * Bin compartido, el día se prorratea entre los clientes con línea en él según el
   * criterio de la operación; cada cliente paga SU parte × SU tarifa, así que lo cobrado
   * a cada uno nunca supera su tarifa por ese Bin.
   */
  async dayCharges(sellerId: string, operationId: string, fromISO: string, toISO: string, ratePerBinDay: number, offsetHoras = -3): Promise<{ binDias: number; monto: number; detalle: Array<Record<string, unknown>>; criterio: string }> {
    const s = await this.settings(operationId);
    const from = Date.parse(fromISO), to = Date.parse(toISO);
    const off = offsetHoras * 3600000;
    const all = await this.bins.list(operationId, { includeDeleted: true });
    const ids = all.map((b) => b.id);
    if (!ids.length || !(ratePerBinDay > 0)) return { binDias: 0, monto: 0, detalle: [], criterio: s.prorrateo };
    const detalle: Array<Record<string, unknown>> = [];
    let binDias = 0, monto = 0;
    const skuCache = new Map<string, { vol: number | null; peso: number | null }>();
    const medida = async (sid: string, sku: string) => {
      const k = sid + '|' + sku;
      if (!skuCache.has(k)) {
        const x = await this.skus.find(sid, sku).catch(() => null);
        const vol = x && x.largoCm && x.anchoCm && x.altoCm ? x.largoCm * x.anchoCm * x.altoCm : null;
        skuCache.set(k, { vol, peso: x && x.pesoKg ? x.pesoKg : null });
      }
      return skuCache.get(k)!;
    };
    for (const bin of all) {
      const movs = (await this.inventory.findBinMovements(bin.id)).sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
      if (!movs.some((m) => m.sellerId === sellerId)) continue;
      const intervals = this.ubicadoIntervals(bin);
      if (!intervals.length) continue;
      let dias = 0, parteTotal = 0, cobro = 0; let criterioUsado = s.prorrateo; let fallback = false;
      // Días de la bodega dentro del período.
      for (let d0 = Math.floor((from + off) / 86400000) * 86400000 - off; d0 < to; d0 += 86400000) {
        const d1 = d0 + 86400000;
        if (d1 <= from) continue;
        const a = Math.max(d0, from), z = Math.min(d1, to);
        if (!intervals.some(([i0, i1]) => i0 < z && i1 > a)) continue;
        // Contenido al cierre del día (si quedó vacío, al inicio).
        let saldo = this.saldoPorCliente(movs, z);
        if (!Object.values(saldo).some((q) => Object.values(q).some((v) => v > 0))) saldo = this.saldoPorCliente(movs, a);
        const clientes = Object.keys(saldo).filter((c) => Object.values(saldo[c]).some((v) => v > 0));
        if (!clientes.includes(sellerId)) continue;
        let pesos: Record<string, number> = {};
        if (s.prorrateo === 'iguales') for (const c of clientes) pesos[c] = 1;
        else if (s.prorrateo === 'unidades') for (const c of clientes) pesos[c] = Object.values(saldo[c]).reduce((t, v) => t + Math.max(0, v), 0);
        else {
          let completo = true;
          for (const c of clientes) {
            let w = 0;
            for (const [sku, q] of Object.entries(saldo[c])) {
              if (q <= 0) continue;
              const m = await medida(c, sku);
              const f = s.prorrateo === 'volumen' ? m.vol : m.peso;
              if (f == null) { completo = false; break; }
              w += q * f;
            }
            if (!completo) break;
            pesos[c] = w;
          }
          if (!completo) { fallback = true; criterioUsado = 'unidades'; pesos = {}; for (const c of clientes) pesos[c] = Object.values(saldo[c]).reduce((t, v) => t + Math.max(0, v), 0); }
        }
        const tot = Object.values(pesos).reduce((t, v) => t + v, 0);
        const parte = tot > 0 ? (pesos[sellerId] || 0) / tot : 1 / clientes.length;
        dias += 1; parteTotal += parte; cobro += parte * ratePerBinDay;
      }
      if (!dias) continue;
      binDias += parteTotal; monto += cobro;
      detalle.push({ bin: bin.numero, dias, participacion: Math.round((parteTotal / dias) * 1000) / 10, binDiasCobrados: Math.round(parteTotal * 100) / 100, monto: Math.round(cobro), criterio: criterioUsado, nota: fallback ? 'sin medidas en algún SKU: se prorrateó por unidades' : null });
    }
    return { binDias, monto: Math.round(monto), detalle, criterio: s.prorrateo };
  }

  /** Intervalos [inicio, fin) en que el Bin estuvo UBICADO (desde su historial). */
  private ubicadoIntervals(bin: Bin): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let since: number | null = null;
    const ON = new Set(['UBICADO', 'MOVIDO', 'CONSOLIDACIÓN', 'TRASLADO CANCELADO', 'CONSOLIDACIÓN CANCELADA']);
    const OFF = new Set(['VACÍO', 'ELIMINADO', 'CONSOLIDADO', 'DESARMADO', 'REABIERTO']);
    for (const e of bin.events) {
      const t = Date.parse(e.at);
      if (ON.has(e.type) && since == null) since = t;
      else if (OFF.has(e.type) && since != null) { out.push([since, t]); since = null; }
    }
    if (since != null) out.push([since, Number.MAX_SAFE_INTEGER]);
    // Un Bin creado directamente UBICADO (destino nuevo de una consolidación) no tiene evento "UBICADO".
    if (!out.length && bin.estado === BinEstado.UBICADO) out.push([Date.parse(bin.closedAt || bin.createdAt), Number.MAX_SAFE_INTEGER]);
    return out;
  }

  private saldoPorCliente(movs: StockMovement[], hasta: number): Record<string, Record<string, number>> {
    const acc: Record<string, Record<string, number>> = {};
    for (const m of movs) {
      if (Date.parse(m.occurredAt) >= hasta) break;
      if (m.state !== StockState.AVAILABLE && m.state !== StockState.RESERVED) continue;
      (acc[m.sellerId] = acc[m.sellerId] || {})[m.sku] = ((acc[m.sellerId] || {})[m.sku] || 0) + m.qtyDelta;
    }
    return acc;
  }

  // ---- Utilidades -------------------------------------------------------------------

  private ev(bin: Bin, type: string, actor: string, detail: string | null): void {
    const now = this.clock.now();
    const e: BinEvent = { type, at: now, actor: actor || 'system', detail };
    bin.events = (bin.events || []).concat(e);
    bin.updatedAt = now;
  }

  private restorePrev(bin: Bin): void {
    if (bin.estado === BinEstado.EN_MOVIMIENTO) bin.estado = bin.estadoPrevio || BinEstado.UBICADO;
    bin.estadoPrevio = null;
  }

  private assertOperable(bin: Bin): void {
    if (bin.estado === BinEstado.ELIMINADO) throw new ValidationError(`El Bin ${bin.numero} está eliminado.`);
    if (bin.estado === BinEstado.CONSOLIDADO) throw new ValidationError(`El Bin ${bin.numero} fue consolidado en otro Bin: ya no admite operaciones.`);
  }

  private async mustLocation(operationId: string, idOrCode: string): Promise<Location> {
    let l = await this.locations.findById(idOrCode).catch(() => null);
    if (!l || l.operationId !== operationId) l = await this.locations.findByCode(operationId, idOrCode).catch(() => null);
    if (!l || l.operationId !== operationId) throw new NotFoundError(`Ubicación no encontrada: ${idOrCode}`);
    if (l.active === false) throw new ValidationError(`La ubicación ${l.code} está inactiva.`);
    return l;
  }

  private async assertSellersOfOperation(operationId: string, sellerIds: string[]): Promise<void> {
    for (const id of Array.from(new Set(sellerIds))) {
      const s = await this.sellers.findById(id);
      if (!s) throw new NotFoundError(`Cliente no encontrado: ${id}`);
      if (s.operationId !== operationId) throw new ForbiddenError(`El cliente ${id} no pertenece a esta operación.`);
    }
  }
}
