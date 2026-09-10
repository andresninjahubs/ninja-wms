/**
 * ReceiptOrderService — Órdenes de recepción (inbound) con cotejo físico vs teórico.
 *
 * Ciclo de vida:
 *   1. create()  → la orden se crea con cantidades ESPERADAS (teóricas). No entra stock.
 *                  Estado PENDING.
 *   2. receive() → cotejo: el equipo cuenta el físico por SKU y confirma lo recibido en
 *                  ESTE evento. Se postea a la ubicación de recepción (RECEIPT) SOLO lo
 *                  contado. Puede repetirse en varios eventos (entregas parciales).
 *                  Estado PARTIAL mientras falte; RECEIVED cuando se recibe todo.
 *   3. close()   → cierra la orden como recibida aunque falte mercadería (parcial). El
 *                  faltante queda registrado (no se postea). Estado RECEIVED.
 *
 * Editar/eliminar: se puede editar la orden mientras esté PENDING (sin recibir). Eliminar
 * revierte el stock ya recibido (ADJUSTMENT negativo) siempre que siga íntegro en
 * recepción; los movimientos de reverso quedan en el ledger para auditoría.
 */
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { InventoryService } from './inventory.service';
import {
  Clock,
  IdGenerator,
  LocationRepository,
  ReceiptOrderRepository,
  SellerRepository,
  SerialRepository,
  SkuRepository,
} from './ports';
import { OrderEvent, ReceiptLine, ReceiptOrder, ReceiptOrderStatus, Seller, SerialStatus, Uom, ZoneType } from './types';

export interface ReceiptLineInput {
  sku: string;
  qty: number; // cantidad ESPERADA (teórica) al crear/editar la orden
  uom?: Uom;
  lot?: string | null;
  expiry?: string | null;
}

export interface CreateReceiptInput {
  supplier?: string | null;
  reference?: string | null;
  locationId?: string | null; // ubicación de recepción; default: primera RECEIVING de la operación
  notes?: string | null;
  lines: ReceiptLineInput[];
}

/** Un conteo de cotejo: cuánto se recibió físicamente de una línea en este evento. */
export interface ReceiptCountInput {
  lineNo: number;
  qty: number; // recibido AHORA (se acumula sobre lo ya recibido)
  lot?: string | null; // lote capturado/confirmado en la recepción (opcional; si viene, pisa el declarado)
  expiry?: string | null; // vencimiento capturado en la recepción (ISO; opcional)
  serials?: string[]; // números de serie de las unidades recibidas (obligatorio si el SKU es serializado)
}

export class ReceiptOrderService {
  constructor(
    private readonly receipts: ReceiptOrderRepository,
    private readonly inventory: InventoryService,
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly locations: LocationRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly serials?: SerialRepository,
  ) {}

  private ev(type: string, actor?: string, detail?: string | null): OrderEvent {
    return { type, at: this.clock.now(), actor: actor || 'system', detail: detail ?? null };
  }
  private genCode(): string {
    const ymd = this.clock.now().slice(0, 10).replace(/-/g, '');
    const suffix = this.ids.next().replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
    return `OR-${ymd}-${suffix}`;
  }
  private expectedUnits(o: ReceiptOrder): number {
    return o.lines.reduce((a, l) => a + l.expectedQty, 0);
  }
  private receivedUnits(o: ReceiptOrder): number {
    return o.lines.reduce((a, l) => a + l.receivedQty, 0);
  }
  private isComplete(o: ReceiptOrder): boolean {
    return o.lines.every((l) => l.receivedQty >= l.expectedQty);
  }

  private async resolveReceivingLocation(seller: Seller, wanted?: string | null): Promise<string> {
    const locs = await this.locations.listByOperation(seller.operationId);
    if (wanted) {
      const l = locs.find((x) => x.id === wanted);
      if (!l) throw new NotFoundError(`Ubicación no encontrada: ${wanted}`);
      return l.id;
    }
    const recv =
      locs.find((x) => x.zoneType === ZoneType.RECEIVING && x.active !== false) ||
      locs.find((x) => x.active !== false);
    if (!recv) throw new ValidationError('No hay ubicación de recepción disponible en la operación');
    return recv.id;
  }

  private async validateExpectedLines(sellerId: string, lines: ReceiptLineInput[]): Promise<ReceiptLine[]> {
    if (!lines || lines.length === 0) {
      throw new ValidationError('La orden de recepción debe tener al menos una línea');
    }
    const out: ReceiptLine[] = [];
    let n = 0;
    for (const l of lines) {
      n += 1;
      if (!(l.qty > 0)) throw new ValidationError(`Cantidad esperada inválida en línea ${n}: ${l.qty}`);
      const sku = await this.skus.find(sellerId, l.sku);
      if (!sku) throw new NotFoundError(`SKU no encontrado para el seller ${sellerId}: ${l.sku}`);
      out.push({
        lineNo: n,
        sku: l.sku,
        expectedQty: l.qty,
        receivedQty: 0,
        uom: l.uom ?? Uom.EACH,
        lot: l.lot ?? null,
        expiry: l.expiry ?? null,
      });
    }
    return out;
  }

  /** Crea la orden con cantidades ESPERADAS. No ingresa stock (estado PENDING). */
  async create(sellerId: string, input: CreateReceiptInput, actor?: string): Promise<ReceiptOrder> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    if (!seller.active) throw new ValidationError(`Seller inactivo: ${sellerId}`);
    const locationId = await this.resolveReceivingLocation(seller, input.locationId);
    const lines = await this.validateExpectedLines(sellerId, input.lines);
    const order: ReceiptOrder = {
      id: this.genCode(),
      sellerId,
      supplier: input.supplier ?? null,
      reference: input.reference ?? null,
      locationId,
      notes: input.notes ?? null,
      status: ReceiptOrderStatus.PENDING,
      lines,
      createdAt: this.clock.now(),
      createdBy: actor || 'system',
      events: [],
    };
    order.events.push(this.ev('CREADA', actor, `${lines.length} línea(s) · ${this.expectedUnits(order)} un esperadas`));
    await this.receipts.save(order);
    return order;
  }

  /** Edita encabezado y líneas ESPERADAS. Solo mientras la orden esté PENDING (sin recibir). */
  async update(sellerId: string, orderId: string, input: CreateReceiptInput, actor?: string): Promise<ReceiptOrder> {
    const order = await this.receipts.findById(sellerId, orderId);
    if (!order) throw new NotFoundError(`Orden de recepción no encontrada: ${orderId}`);
    if (order.status !== ReceiptOrderStatus.PENDING) {
      throw new ValidationError('Solo se puede editar una recepción pendiente (aún sin recibir). Anúlala si necesitas rehacerla.');
    }
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    const newLocationId = await this.resolveReceivingLocation(seller, input.locationId ?? order.locationId);
    const newLines = await this.validateExpectedLines(sellerId, input.lines);
    order.supplier = input.supplier ?? null;
    order.reference = input.reference ?? null;
    order.notes = input.notes ?? null;
    order.locationId = newLocationId;
    order.lines = newLines;
    order.events.push(this.ev('EDITADA', actor, `${newLines.length} línea(s) · ${this.expectedUnits(order)} un esperadas`));
    await this.receipts.save(order);
    return order;
  }

  /**
   * Cotejo: registra el físico recibido en ESTE evento por línea y postea el stock a la
   * ubicación de recepción. Acumula sobre lo ya recibido. Recalcula el estado.
   */
  async receive(sellerId: string, orderId: string, counts: ReceiptCountInput[], actor?: string): Promise<ReceiptOrder> {
    const order = await this.receipts.findById(sellerId, orderId);
    if (!order) throw new NotFoundError(`Orden de recepción no encontrada: ${orderId}`);
    if (order.status === ReceiptOrderStatus.CANCELLED || order.status === ReceiptOrderStatus.RECEIVED) {
      throw new ValidationError(`La orden ${orderId} ya está cerrada (${order.status}); no admite más recepciones.`);
    }
    if (!counts || counts.length === 0) throw new ValidationError('Indica al menos una cantidad recibida.');

    // --- PASO 1: validar TODO antes de postear nada (atomicidad de series) ---
    // Resuelve por conteo: la línea, el lote/vencimiento efectivos y las series validadas.
    type Prepared = { c: ReceiptCountInput; line: ReceiptLine; lot: string | null; expiry: string | null; serials: string[] };
    const prepared: Prepared[] = [];
    for (const c of counts) {
      if (c.qty == null || c.qty === 0) continue; // línea no contada en este evento
      if (!(c.qty > 0)) throw new ValidationError(`Cantidad recibida inválida en línea ${c.lineNo}: ${c.qty}`);
      const line = order.lines.find((l) => l.lineNo === c.lineNo);
      if (!line) throw new NotFoundError(`Línea ${c.lineNo} no existe en la orden ${orderId}`);

      // Lote/vencimiento efectivos: lo capturado en la recepción pisa lo declarado.
      const lot = (c.lot != null && c.lot !== '' ? c.lot : line.lot) || null;
      const expiry = (c.expiry != null && c.expiry !== '' ? c.expiry : line.expiry) || null;

      // Controles obligatorios según el maestro de productos.
      const sku = await this.skus.find(sellerId, line.sku);
      if (sku?.lotControlled && !lot) {
        throw new ValidationError(`La línea ${c.lineNo} (${line.sku}) es controlada por lote: debes indicar el lote al recepcionar.`);
      }
      if (sku?.expiryControlled && !expiry) {
        throw new ValidationError(`La línea ${c.lineNo} (${line.sku}) es controlada por vencimiento: debes indicar el vencimiento al recepcionar.`);
      }
      const rawSerials = (c.serials || []).map((s) => String(s).trim()).filter(Boolean);
      const requiresSerial = !!sku?.serialControlled;
      let serials: string[] = [];
      if (requiresSerial || rawSerials.length > 0) {
        if (rawSerials.length !== c.qty) {
          throw new ValidationError(
            `La línea ${c.lineNo} (${line.sku}) requiere ${c.qty} número(s) de serie; se ingresaron ${rawSerials.length}.`,
          );
        }
        // Sin duplicados dentro de esta carga.
        const seen = new Set<string>();
        for (const s of rawSerials) {
          if (seen.has(s)) throw new ValidationError(`Número de serie duplicado en la carga: ${s} (${line.sku}).`);
          seen.add(s);
        }
        // Sin colisión con series ya en stock (permite re-registrar una serie despachada).
        if (this.serials) {
          for (const s of rawSerials) {
            const ex = await this.serials.get(sellerId, line.sku, s);
            if (ex && ex.status !== SerialStatus.SHIPPED) {
              throw new ValidationError(`El número de serie ${s} de ${line.sku} ya está registrado en stock.`);
            }
          }
        }
        serials = rawSerials;
      }
      prepared.push({ c, line, lot, expiry, serials });
    }
    if (prepared.length === 0) throw new ValidationError('No se recibió ninguna cantidad (todas en 0).');

    // --- PASO 2: postear stock, actualizar líneas y registrar series ---
    let postedUnits = 0;
    const touched: string[] = [];
    const now = this.clock.now();
    for (const p of prepared) {
      const { c, line, lot, expiry, serials } = p;
      await this.inventory.receive(sellerId, {
        sku: line.sku,
        qty: c.qty,
        locationId: order.locationId,
        lot,
        expiry,
        uom: line.uom,
        reference: order.id,
        actor,
      });
      // Refleja en la línea el lote/vencimiento realmente recibido (si se capturaron).
      if (c.lot != null && c.lot !== '') line.lot = lot;
      if (c.expiry != null && c.expiry !== '') line.expiry = expiry;
      // Registra cada número de serie (trazabilidad unidad-a-unidad).
      if (this.serials && serials.length) {
        for (const s of serials) {
          await this.serials.save({
            sellerId,
            sku: line.sku,
            serial: s,
            lot,
            expiry,
            status: SerialStatus.IN_STOCK,
            receiptId: order.id,
            locationId: order.locationId,
            receivedAt: now,
            actor: actor || 'system',
          });
        }
      }
      line.receivedQty += c.qty;
      postedUnits += c.qty;
      touched.push(`${line.sku} +${c.qty}${serials.length ? ` (${serials.length} serie/s)` : ''}`);
    }
    if (postedUnits === 0) throw new ValidationError('No se recibió ninguna cantidad (todas en 0).');

    order.status = this.isComplete(order) ? ReceiptOrderStatus.RECEIVED : ReceiptOrderStatus.PARTIAL;
    const tag = order.status === ReceiptOrderStatus.RECEIVED ? 'RECEPCIÓN (completa)' : 'RECEPCIÓN (parcial)';
    order.events.push(this.ev(tag, actor, `${touched.join(', ')} · ${this.receivedUnits(order)}/${this.expectedUnits(order)} un`));
    await this.receipts.save(order);
    return order;
  }

  /** Cierra la orden como recibida aunque falte mercadería (parcial). El faltante queda registrado. */
  async close(sellerId: string, orderId: string, actor?: string): Promise<ReceiptOrder> {
    const order = await this.receipts.findById(sellerId, orderId);
    if (!order) throw new NotFoundError(`Orden de recepción no encontrada: ${orderId}`);
    if (order.status === ReceiptOrderStatus.CANCELLED) throw new ValidationError('La orden está anulada.');
    if (order.status === ReceiptOrderStatus.RECEIVED) throw new ValidationError('La orden ya está cerrada.');
    order.status = ReceiptOrderStatus.RECEIVED;
    const missing = this.expectedUnits(order) - this.receivedUnits(order);
    const detail = missing > 0
      ? `Cerrada con faltante de ${missing} un (${this.receivedUnits(order)}/${this.expectedUnits(order)} recibidas)`
      : `Cerrada completa (${this.receivedUnits(order)}/${this.expectedUnits(order)} recibidas)`;
    order.events.push(this.ev('CERRADA', actor, detail));
    await this.receipts.save(order);
    return order;
  }

  /** El stock ya recibido debe seguir íntegro en su ubicación de recepción para poder revertir. */
  private async assertReversible(order: ReceiptOrder): Promise<void> {
    const need: Record<string, number> = {};
    for (const l of order.lines) {
      if (l.receivedQty <= 0) continue;
      const k = l.sku + '::' + (l.lot ?? '');
      need[k] = (need[k] || 0) + l.receivedQty;
    }
    for (const k of Object.keys(need)) {
      const sep = k.indexOf('::');
      const sku = k.slice(0, sep);
      const lot = k.slice(sep + 2) || null;
      const avail = await this.inventory.availableAt(order.sellerId, sku, order.locationId, lot);
      if (avail < need[k]) {
        throw new ForbiddenError(
          `No se puede eliminar la recepción ${order.id}: parte del stock de ${sku} ya fue guardado o reservado ` +
            `(disponible en recepción ${avail}, la orden recibió ${need[k]}). Reversa primero el guardado/reserva.`,
        );
      }
    }
  }

  private async reverseReceived(order: ReceiptOrder, actor?: string): Promise<void> {
    for (const l of order.lines) {
      if (l.receivedQty <= 0) continue;
      await this.inventory.adjust(order.sellerId, {
        sku: l.sku,
        locationId: order.locationId,
        lot: l.lot,
        qtyDelta: -l.receivedQty,
        uom: l.uom,
        reference: `ANULA ${order.id}`,
        actor,
      });
    }
  }

  /** Elimina/anula la orden. Revierte el stock ya recibido (si sigue íntegro en recepción). */
  async remove(sellerId: string, orderId: string, actor?: string): Promise<{ ok: true; id: string }> {
    const order = await this.receipts.findById(sellerId, orderId);
    if (!order) throw new NotFoundError(`Orden de recepción no encontrada: ${orderId}`);
    if (this.receivedUnits(order) > 0) {
      await this.assertReversible(order);
      await this.reverseReceived(order, actor);
    }
    await this.receipts.delete(sellerId, orderId);
    return { ok: true, id: orderId };
  }

  get(sellerId: string, orderId: string): Promise<ReceiptOrder | null> {
    return this.receipts.findById(sellerId, orderId);
  }
  list(sellerId: string): Promise<ReceiptOrder[]> {
    return this.receipts.list(sellerId);
  }
}
