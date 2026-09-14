/**
 * InventoryService — el núcleo del WMS.
 *
 * Reglas invariantes que este servicio garantiza:
 *  1. El stock nunca se edita como número: todo cambio es un movimiento inmutable.
 *  2. El saldo de un bucket es SIEMPRE la suma de los deltas de sus movimientos.
 *  3. Ningún movimiento puede dejar un bucket en negativo.
 *  4. Toda operación está acotada a un `sellerId`: nada cruza la frontera del seller.
 */
import {
  InsufficientStockError,
  NotFoundError,
  TenantViolationError,
  ValidationError,
} from './errors';
import {
  Clock,
  IdGenerator,
  LocationRepository,
  LotRepository,
  MovementRepository,
  SellerRepository,
  SkuRepository,
  StockQuery,
} from './ports';
import {
  Allocation,
  MovementType,
  PickingStrategy,
  Seller,
  StockBalance,
  StockMovement,
  StockState,
  Uom,
  ZoneType,
} from './types';

export interface ReceiveCommand {
  sku: string;
  qty: number;
  locationId: string; // normalmente una ubicación de la zona de recepción
  lot?: string | null;
  expiry?: string | null; // vencimiento del lote (ISO) — habilita FEFO
  uom?: Uom;
  reference?: string | null; // p.ej. número de recepción / ASN
  actor?: string;
}

export interface PutawayCommand {
  sku: string;
  qty: number;
  fromLocationId: string;
  toLocationId: string;
  lot?: string | null;
  uom?: Uom;
  reference?: string | null;
  actor?: string;
}

export interface AdjustCommand {
  sku: string;
  locationId: string;
  qtyDelta: number; // + suma / - resta al bucket
  lot?: string | null;
  state?: StockState;
  uom?: Uom;
  reference?: string | null;
  actor?: string;
}

export class InventoryService {
  constructor(
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly locations: LocationRepository,
    private readonly movements: MovementRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly lots: LotRepository,
  ) {}

  /**
   * Recepción de mercadería: crea una entrada (+qty) en el ledger.
   * Es la única puerta por la que stock nuevo entra al sistema.
   */
  async receive(sellerId: string, cmd: ReceiveCommand): Promise<StockMovement> {
    this.assertPositive(cmd.qty);
    const seller = await this.assertSellerActive(sellerId);
    await this.assertSku(sellerId, cmd.sku);
    await this.assertLocation(cmd.locationId, seller.operationId);

    const movement: StockMovement = {
      id: this.ids.next(),
      sellerId,
      sku: cmd.sku,
      locationId: cmd.locationId,
      lot: cmd.lot ?? null,
      state: StockState.AVAILABLE,
      type: MovementType.RECEIPT,
      qtyDelta: cmd.qty,
      uom: cmd.uom ?? Uom.EACH,
      reference: cmd.reference ?? null,
      groupId: null,
      actor: cmd.actor ?? 'system',
      occurredAt: this.clock.now(),
    };

    // Registrar/actualizar metadata del lote (para FIFO por recepción y FEFO por vencimiento).
    if (movement.lot) {
      const existing = await this.lots.get(sellerId, cmd.sku, movement.lot);
      await this.lots.upsert({
        sellerId,
        sku: cmd.sku,
        lot: movement.lot,
        receivedAt: existing?.receivedAt ?? movement.occurredAt,
        expiryDate: cmd.expiry ?? existing?.expiryDate ?? null,
      });
    }

    await this.movements.append([movement]);
    return movement;
  }

  /**
   * Guardado dirigido: mueve stock de una ubicación a otra (p.ej. recepción -> almacenaje).
   * Se expresa como dos movimientos atómicos que comparten `groupId`.
   * Falla si el origen no tiene stock disponible suficiente.
   */
  async putaway(sellerId: string, cmd: PutawayCommand): Promise<StockMovement[]> {
    this.assertPositive(cmd.qty);
    if (cmd.fromLocationId === cmd.toLocationId) {
      throw new ValidationError('El origen y el destino no pueden ser la misma ubicación');
    }
    const seller = await this.assertSellerActive(sellerId);
    await this.assertSku(sellerId, cmd.sku);
    await this.assertLocation(cmd.fromLocationId, seller.operationId);
    await this.assertLocation(cmd.toLocationId, seller.operationId);

    const lot = cmd.lot ?? null;
    const available = await this.availableQty(sellerId, cmd.sku, cmd.fromLocationId, lot);
    if (available < cmd.qty) {
      throw new InsufficientStockError(
        `Stock insuficiente en ${cmd.fromLocationId} para ${cmd.sku}: disponible ${available}, requerido ${cmd.qty}`,
      );
    }

    const groupId = this.ids.next();
    const occurredAt = this.clock.now();
    const uom = cmd.uom ?? Uom.EACH;
    const actor = cmd.actor ?? 'system';

    const out: StockMovement = {
      id: this.ids.next(),
      sellerId,
      sku: cmd.sku,
      locationId: cmd.fromLocationId,
      lot,
      state: StockState.AVAILABLE,
      type: MovementType.PUTAWAY,
      qtyDelta: -cmd.qty,
      uom,
      reference: cmd.reference ?? null,
      groupId,
      actor,
      occurredAt,
    };
    const into: StockMovement = {
      ...out,
      id: this.ids.next(),
      locationId: cmd.toLocationId,
      qtyDelta: cmd.qty,
    };

    await this.movements.append([out, into]);
    return [out, into];
  }

  /**
   * Reserva stock disponible de un SKU para una orden.
   * Transiciona AVAILABLE -> RESERVED en el ledger (dos movimientos por bucket).
   * Así `disponible = físico − reservado` y se evita la sobreventa entre canales.
   * Devuelve las reservas concretas (ubicación + lote + qty) que guiarán el picking.
   */
  async reserve(
    sellerId: string,
    cmd: { sku: string; qty: number; lot?: string | null; reference?: string | null; actor?: string },
  ): Promise<Allocation[]> {
    this.assertPositive(cmd.qty);
    const seller = await this.assertSellerActive(sellerId);
    await this.assertSku(sellerId, cmd.sku);

    // Si la línea exige un lote/serie específico, se reserva SOLO de ese lote.
    const requiredLot = cmd.lot ?? null;
    if (seller.pickingStrategy === PickingStrategy.LOT_DIRECTED && requiredLot === null) {
      throw new ValidationError(
        `El seller ${sellerId} opera con lote/serie dirigido: la orden debe indicar el lote a tomar`,
      );
    }

    const balances = await this.movements.balances({ sellerId, sku: cmd.sku });
    const rawCandidates = balances
      .filter((b) => b.state === StockState.AVAILABLE && b.qty > 0)
      .filter((b) => requiredLot === null || (b.lot ?? null) === requiredLot);
    // Solo se reserva/pickea desde zonas de ALMACENAJE o PICKING. El stock en el dock
    // de RECEPCIÓN (o en cuarentena/despacho) NO es reservable: debe guardarse (putaway)
    // en almacenaje antes de poder comprometerse a una orden.
    const zones = await Promise.all(
      rawCandidates.map(async (b) => ({ b, loc: await this.locations.findById(b.locationId) })),
    );
    const candidates = zones
      .filter((x) => x.loc && (x.loc.zoneType === ZoneType.STORAGE || x.loc.zoneType === ZoneType.PICKING))
      .map((x) => x.b);
    // El ORDEN en que se consume depende de la estrategia del seller (FIFO / FEFO / dirigido).
    const available = await this.orderByStrategy(sellerId, cmd.sku, candidates, seller.pickingStrategy);

    const totalAvailable = available.reduce((s, b) => s + b.qty, 0);
    if (totalAvailable < cmd.qty) {
      const lotHint = requiredLot ? ` (lote ${requiredLot})` : '';
      throw new InsufficientStockError(
        `Stock reservable (en almacenaje/picking) insuficiente para ${cmd.sku}${lotHint}: disponible ${totalAvailable}, requerido ${cmd.qty}. ` +
          `El stock en recepción debe guardarse (putaway) en almacenaje antes de reservarse.`,
      );
    }

    const groupId = this.ids.next();
    const occurredAt = this.clock.now();
    const actor = cmd.actor ?? 'system';
    const toAppend: StockMovement[] = [];
    const allocations: Allocation[] = [];
    let remaining = cmd.qty;

    // Consolidación por ubicación (opcional, por seller): si UNA sola ubicación
    // alcanza para toda la cantidad, se prefiere esa (tomando la primera en el
    // orden de la estrategia FIFO/FEFO). Si ninguna alcanza sola, se combinan varias.
    let consumeOrder = available;
    if (seller.consolidateByLocation) {
      const perLoc: Record<string, number> = {};
      for (const b of available) perLoc[b.locationId] = (perLoc[b.locationId] ?? 0) + b.qty;
      let chosen: string | null = null;
      for (const b of available) {
        if ((perLoc[b.locationId] ?? 0) >= cmd.qty) { chosen = b.locationId; break; }
      }
      if (chosen) {
        const first = available.filter((b) => b.locationId === chosen);
        const rest = available.filter((b) => b.locationId !== chosen);
        consumeOrder = [...first, ...rest];
      }
    }

    for (const bucket of consumeOrder) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, bucket.qty);
      const base = {
        sellerId,
        sku: cmd.sku,
        locationId: bucket.locationId,
        lot: bucket.lot,
        type: MovementType.RESERVE,
        uom: Uom.EACH,
        reference: cmd.reference ?? null,
        groupId,
        actor,
        occurredAt,
      };
      toAppend.push(
        { ...base, id: this.ids.next(), state: StockState.AVAILABLE, qtyDelta: -take },
        { ...base, id: this.ids.next(), state: StockState.RESERVED, qtyDelta: take },
      );
      allocations.push({ locationId: bucket.locationId, lot: bucket.lot, qty: take });
      remaining -= take;
    }

    await this.movements.append(toAppend);
    return allocations;
  }

  /**
   * Libera reservas (p.ej. al cancelar una orden): RESERVED -> AVAILABLE.
   */
  async release(
    sellerId: string,
    sku: string,
    allocations: Allocation[],
    cmd: { reference?: string | null; actor?: string } = {},
  ): Promise<void> {
    await this.assertSellerActive(sellerId);
    const groupId = this.ids.next();
    const occurredAt = this.clock.now();
    const actor = cmd.actor ?? 'system';
    const toAppend: StockMovement[] = [];

    for (const a of allocations) {
      if (a.qty <= 0) continue;
      const base = {
        sellerId,
        sku,
        locationId: a.locationId,
        lot: a.lot,
        type: MovementType.RELEASE,
        uom: Uom.EACH,
        reference: cmd.reference ?? null,
        groupId,
        actor,
        occurredAt,
      };
      toAppend.push(
        { ...base, id: this.ids.next(), state: StockState.RESERVED, qtyDelta: -a.qty },
        { ...base, id: this.ids.next(), state: StockState.AVAILABLE, qtyDelta: a.qty },
      );
    }

    if (toAppend.length > 0) await this.movements.append(toAppend);
  }

  /**
   * Picking: retira stock reservado de una ubicación (sale de la bodega).
   * Consume el RESERVED de esa ubicación/lote (movimiento PICK, delta negativo).
   */
  async pick(
    sellerId: string,
    cmd: {
      sku: string;
      qty: number;
      locationId: string;
      lot?: string | null;
      reference?: string | null;
      actor?: string;
    },
  ): Promise<StockMovement> {
    this.assertPositive(cmd.qty);
    await this.assertSellerActive(sellerId);
    const lot = cmd.lot ?? null;

    const balances = await this.movements.balances({ sellerId, sku: cmd.sku, locationId: cmd.locationId });
    const reserved = balances
      .filter((b) => b.state === StockState.RESERVED && (b.lot ?? null) === lot)
      .reduce((s, b) => s + b.qty, 0);
    if (reserved < cmd.qty) {
      throw new InsufficientStockError(
        `Stock reservado insuficiente para pickear ${cmd.sku} en ${cmd.locationId}: reservado ${reserved}, requerido ${cmd.qty}`,
      );
    }

    const movement: StockMovement = {
      id: this.ids.next(),
      sellerId,
      sku: cmd.sku,
      locationId: cmd.locationId,
      lot,
      state: StockState.RESERVED,
      type: MovementType.PICK,
      qtyDelta: -cmd.qty,
      uom: Uom.EACH,
      reference: cmd.reference ?? null,
      groupId: null,
      actor: cmd.actor ?? 'system',
      occurredAt: this.clock.now(),
    };
    await this.movements.append([movement]);
    return movement;
  }

  /** Consulta de saldos (suma de movimientos) acotada al seller. */
  async getStock(query: StockQuery): Promise<StockBalance[]> {
    return this.movements.balances(query);
  }

  /** Movimientos crudos del seller (más recientes primero) — para actividad y recepción. */
  /** ¿La ubicación registró alguna vez un movimiento (de cualquier cliente)? */
  async locationHasHistory(locationId: string): Promise<boolean> {
    const occ = await this.movements.occupancyByLocation();
    return Object.prototype.hasOwnProperty.call(occ, locationId);
  }

  async listMovements(sellerId: string, limit = 50): Promise<StockMovement[]> {
    const all = await this.movements.find({ sellerId });
    return all
      .slice()
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
      .slice(0, limit);
  }

  /** Igual que availableQty pero público — usado por servicios de nivel superior (recepción). */
  async availableAt(sellerId: string, sku: string, locationId: string, lot: string | null): Promise<number> {
    return this.availableQty(sellerId, sku, locationId, lot);
  }

  /**
   * Ajuste de inventario: postea UN movimiento ADJUSTMENT con `qtyDelta` (puede ser
   * negativo). Se usa, por ejemplo, para revertir el stock de una recepción anulada
   * o editada. Nunca deja un bucket en negativo.
   */
  async adjust(sellerId: string, cmd: AdjustCommand): Promise<StockMovement> {
    if (!Number.isFinite(cmd.qtyDelta) || cmd.qtyDelta === 0) {
      throw new ValidationError(`El ajuste debe ser un delta distinto de cero, recibido: ${cmd.qtyDelta}`);
    }
    const seller = await this.assertSellerActive(sellerId);
    await this.assertSku(sellerId, cmd.sku);
    await this.assertLocation(cmd.locationId, seller.operationId);
    const state = cmd.state ?? StockState.AVAILABLE;
    const lot = cmd.lot ?? null;
    if (cmd.qtyDelta < 0) {
      const balances = await this.movements.balances({ sellerId, sku: cmd.sku, locationId: cmd.locationId });
      const current = balances
        .filter((b) => b.state === state && (b.lot ?? null) === lot)
        .reduce((s, b) => s + b.qty, 0);
      if (current + cmd.qtyDelta < 0) {
        throw new InsufficientStockError(
          `Ajuste inválido para ${cmd.sku} en ${cmd.locationId}: saldo ${current}, ajuste ${cmd.qtyDelta}`,
        );
      }
    }
    const movement: StockMovement = {
      id: this.ids.next(),
      sellerId,
      sku: cmd.sku,
      locationId: cmd.locationId,
      lot,
      state,
      type: MovementType.ADJUSTMENT,
      qtyDelta: cmd.qtyDelta,
      uom: cmd.uom ?? Uom.EACH,
      reference: cmd.reference ?? null,
      groupId: null,
      actor: cmd.actor ?? 'system',
      occurredAt: this.clock.now(),
    };
    await this.movements.append([movement]);
    return movement;
  }

  /**
   * Entrada por DEVOLUCIÓN: suma stock (+qty) en el estado indicado (AVAILABLE para
   * stock vendible, DAMAGED para merma, QUARANTINE para cuarentena) y en la ubicación
   * dada. Deja un movimiento de tipo RETURN en el ledger (visible como "Devolución").
   */
  async postReturn(
    sellerId: string,
    cmd: { sku: string; qty: number; state: StockState; locationId: string; lot?: string | null; reference?: string | null; actor?: string },
  ): Promise<StockMovement> {
    this.assertPositive(cmd.qty);
    const seller = await this.assertSellerActive(sellerId);
    await this.assertSku(sellerId, cmd.sku);
    await this.assertLocation(cmd.locationId, seller.operationId);
    const movement: StockMovement = {
      id: this.ids.next(),
      sellerId,
      sku: cmd.sku,
      locationId: cmd.locationId,
      lot: cmd.lot ?? null,
      state: cmd.state,
      type: MovementType.RETURN,
      qtyDelta: cmd.qty,
      uom: Uom.EACH,
      reference: cmd.reference ?? null,
      groupId: null,
      actor: cmd.actor ?? 'system',
      occurredAt: this.clock.now(),
    };
    await this.movements.append([movement]);
    return movement;
  }

  /**
   * Marca de AUDITORÍA en el kardex (qtyDelta 0: no altera saldos). Sirve para dejar
   * traza de eventos como la reactivación de una orden, con su usuario y referencia.
   */
  async postAudit(
    sellerId: string,
    cmd: { sku: string; locationId?: string; type: MovementType; reference?: string | null; actor?: string },
  ): Promise<StockMovement | null> {
    const seller = await this.assertSellerActive(sellerId);
    await this.assertSku(sellerId, cmd.sku);
    let locationId = cmd.locationId;
    if (!locationId) {
      const locs = await this.locations.listByOperation(seller.operationId);
      const loc = locs.find((l) => l.active !== false) || locs[0];
      if (!loc) return null; // sin ubicaciones no hay dónde anclar la marca; se omite
      locationId = loc.id;
    } else {
      await this.assertLocation(locationId, seller.operationId);
    }
    const movement: StockMovement = {
      id: this.ids.next(),
      sellerId,
      sku: cmd.sku,
      locationId,
      lot: null,
      state: StockState.AVAILABLE,
      type: cmd.type,
      qtyDelta: 0,
      uom: Uom.EACH,
      reference: cmd.reference ?? null,
      groupId: null,
      actor: cmd.actor ?? 'system',
      occurredAt: this.clock.now(),
    };
    await this.movements.append([movement]);
    return movement;
  }

  /** Stock disponible de un SKU en una ubicación/lote específicos. */
  private async availableQty(
    sellerId: string,
    sku: string,
    locationId: string,
    lot: string | null,
  ): Promise<number> {
    const balances = await this.movements.balances({ sellerId, sku, locationId });
    return balances
      .filter((b) => b.state === StockState.AVAILABLE && (b.lot ?? null) === lot)
      .reduce((sum, b) => sum + b.qty, 0);
  }

  private assertPositive(qty: number): void {
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ValidationError(`La cantidad debe ser un número positivo, recibido: ${qty}`);
    }
  }

  private async assertSellerActive(sellerId: string): Promise<Seller> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    if (!seller.active) throw new ValidationError(`Seller inactivo: ${sellerId}`);
    return seller;
  }

  /**
   * Ordena los buckets candidatos según la estrategia de picking del seller:
   *  - FEFO: primero el que vence antes (por vencimiento del lote).
   *  - FIFO / LOT_DIRECTED: primero el que entró antes (fecha de recepción).
   * La antigüedad sale de la metadata del lote; si no hay lote, del primer
   * movimiento de entrada de ese bucket.
   */
  private async orderByStrategy(
    sellerId: string,
    sku: string,
    buckets: StockBalance[],
    strategy: PickingStrategy,
  ): Promise<StockBalance[]> {
    const raw = await this.movements.find({ sellerId, sku });
    const earliestIn: Record<string, string> = {};
    for (const m of raw) {
      if (m.qtyDelta > 0) {
        const k = `${m.locationId}|${m.lot ?? ''}`;
        if (!earliestIn[k] || m.occurredAt < earliestIn[k]) earliestIn[k] = m.occurredAt;
      }
    }

    const FAR = '9999-12-31T00:00:00.000Z';
    const enriched = [];
    for (const b of buckets) {
      let receivedAt = earliestIn[`${b.locationId}|${b.lot ?? ''}`] ?? FAR;
      let expiry: string | null = null;
      if (b.lot) {
        const meta = await this.lots.get(sellerId, sku, b.lot);
        if (meta) {
          receivedAt = meta.receivedAt;
          expiry = meta.expiryDate;
        }
      }
      enriched.push({ b, receivedAt, expiry });
    }

    enriched.sort((x, y) => {
      if (strategy === PickingStrategy.FEFO) {
        const ex = x.expiry ?? FAR;
        const ey = y.expiry ?? FAR;
        if (ex !== ey) return ex < ey ? -1 : 1;
      }
      if (x.receivedAt !== y.receivedAt) return x.receivedAt < y.receivedAt ? -1 : 1;
      return x.b.locationId < y.b.locationId ? -1 : 1;
    });
    return enriched.map((e) => e.b);
  }

  private async assertSku(sellerId: string, sku: string): Promise<void> {
    const found = await this.skus.find(sellerId, sku);
    // Si no existe para ESTE seller, es NotFound aunque exista el mismo código en otro seller.
    if (!found) throw new NotFoundError(`SKU no encontrado para el seller ${sellerId}: ${sku}`);
    if (!found.active) throw new ValidationError(`SKU inactivo: ${sku}`);
  }

  private async assertLocation(locationId: string, operationId?: string): Promise<void> {
    const loc = await this.locations.findById(locationId);
    if (!loc) throw new NotFoundError(`Ubicación no encontrada: ${locationId}`);
    if (!loc.active) throw new ValidationError(`Ubicación inactiva: ${locationId}`);
    // Invariante multi-operación: solo se usa una ubicación de la MISMA operación del seller.
    if (operationId && loc.operationId !== operationId) {
      throw new TenantViolationError(
        `La ubicación ${loc.code} no pertenece a la operación ${operationId}`,
      );
    }
  }
}
