/**
 * OrderService — ingreso de órdenes desde el OMS y reserva de stock.
 *
 * Flujo:
 *   1. El OMS ingresa una orden (createOrder) con seller y canal ya resueltos.
 *   2. allocate() reserva el stock: AVAILABLE -> RESERVED, evitando la sobreventa.
 *      La reserva es full-or-nothing: si alguna línea no alcanza, se revierte todo.
 *   3. cancel() libera las reservas (RESERVED -> AVAILABLE).
 *
 * El mismo modelo sirve para B2C y B2B (cambia orderType y unidad de las líneas).
 */
import { NotFoundError, ValidationError } from './errors';
import { InventoryService } from './inventory.service';
import {
  Clock,
  IdGenerator,
  OrderRepository,
  SellerRepository,
  SkuRepository,
} from './ports';
import {
  Allocation,
  MovementType,
  KitMode,
  OrderEvent,
  OrderLine,
  OrderStatus,
  OrderType,
  PackingInfo,
  PickTask,
  SalesOrder,
  Shipment,
  ShipTo,
  ShippingLabel,
  ShippingMode,
  Uom,
} from './types';

/** Resultado del OMS al empacar: tracking + etiquetas por bulto. */
export interface AttachLabelsInput {
  trackingNumber?: string | null;
  carrier?: string | null;
  labels?: ShippingLabel[];
  source?: string; // 'oms-ninja' | 'manual'
}

export interface CreateOrderLineInput {
  sku: string;
  qty: number;
  uom?: Uom;
  lot?: string | null; // opcional: exige reservar de ese lote/serie
}

export interface CreateOrderInput {
  externalOrderId: string;
  salesChannel: string;
  orderType?: OrderType;
  purchaseOrderRef?: string | null;
  documentType?: string | null;
  carrier?: string | null;
  priority?: string;
  shipTo: ShipTo;
  lines: CreateOrderLineInput[];
}

export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly inventory: InventoryService,
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** Ingesta de una orden desde el OMS. No reserva stock todavía. */
  /** Crea un evento de auditoría con fecha/hora y actor. */
  private ev(type: string, actor?: string, detail?: string | null): OrderEvent {
    return { type, at: this.clock.now(), actor: actor || 'system', detail: detail ?? null };
  }
  private unitsOf(order: SalesOrder): number {
    return order.lines.reduce((a, l) => a + l.qty, 0);
  }

  /**
   * Demanda real de stock de una línea. Un kit VIRTUAL se explota en sus componentes
   * (cantidad = componente.qty × cantidad de la línea); cualquier otro SKU —incluido un
   * kit ARMADO, que tiene stock propio— reserva su propio código.
   */
  private async demandFor(sellerId: string, line: OrderLine): Promise<{ sku: string; qty: number; lot: string | null }[]> {
    const s = await this.skus.find(sellerId, line.sku);
    if (s && s.isKit && s.kitMode === KitMode.VIRTUAL) {
      return s.components.map((c) => ({ sku: c.sku, qty: c.qty * line.qty, lot: null }));
    }
    return [{ sku: line.sku, qty: line.qty, lot: line.lot }];
  }

  async createOrder(sellerId: string, input: CreateOrderInput, actor?: string): Promise<SalesOrder> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    if (!seller.active) throw new ValidationError(`Seller inactivo: ${sellerId}`);
    // Idempotencia (G1): si ya existe una orden con este externalOrderId para el seller,
    // el ingreso es un reintento del OMS — devolvemos la orden existente en vez de duplicar.
    if (input.externalOrderId) {
      const existing = await this.orders.findByExternal(sellerId, input.externalOrderId);
      if (existing) return existing;
    }
    if (!input.lines || input.lines.length === 0) {
      throw new ValidationError('La orden debe tener al menos una línea');
    }

    const lines: OrderLine[] = [];
    let lineNo = 0;
    for (const l of input.lines) {
      lineNo += 1;
      if (!(l.qty > 0)) throw new ValidationError(`Cantidad inválida en línea ${lineNo}: ${l.qty}`);
      const sku = await this.skus.find(sellerId, l.sku);
      if (!sku) throw new NotFoundError(`SKU no encontrado para el seller ${sellerId}: ${l.sku}`);
      lines.push({
        lineNo,
        sku: l.sku,
        qty: l.qty,
        uom: l.uom ?? Uom.EACH,
        lot: l.lot ?? null,
        allocations: [],
      });
    }

    const order: SalesOrder = {
      id: this.ids.next(),
      sellerId,
      externalOrderId: input.externalOrderId,
      salesChannel: input.salesChannel,
      orderType: input.orderType ?? OrderType.B2C,
      purchaseOrderRef: input.purchaseOrderRef ?? null,
      documentType: input.documentType ?? null,
      carrier: input.carrier ?? null,
      priority: input.priority ?? 'normal',
      shipTo: input.shipTo,
      status: OrderStatus.RECEIVED,
      lines,
      packing: null,
      shipment: null,
      createdAt: this.clock.now(),
      events: [],
    };
    order.events.push(this.ev('CREATED', actor, `${lines.length} línea(s) · ${this.unitsOf(order)} un`));
    await this.orders.save(order);
    return order;
  }

  /**
   * Edita una orden que AÚN no ha reservado stock (estado RECEIVED). Reemplaza el
   * encabezado y las líneas. No se permite editar una vez reservada/pickeada/despachada
   * (habría que liberar reservas primero — cancélala y créala de nuevo).
   */
  async updateOrder(sellerId: string, orderId: string, input: CreateOrderInput, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.RECEIVED) {
      throw new ValidationError(
        `Solo se puede editar una orden antes de reservar stock (estado actual: ${order.status})`,
      );
    }
    if (!input.lines || input.lines.length === 0) {
      throw new ValidationError('La orden debe tener al menos una línea');
    }
    const lines: OrderLine[] = [];
    let lineNo = 0;
    for (const l of input.lines) {
      lineNo += 1;
      if (!(l.qty > 0)) throw new ValidationError(`Cantidad inválida en línea ${lineNo}: ${l.qty}`);
      const sku = await this.skus.find(sellerId, l.sku);
      if (!sku) throw new NotFoundError(`SKU no encontrado para el seller ${sellerId}: ${l.sku}`);
      lines.push({ lineNo, sku: l.sku, qty: l.qty, uom: l.uom ?? Uom.EACH, lot: l.lot ?? null, allocations: [] });
    }
    const updated: SalesOrder = {
      ...order,
      externalOrderId: input.externalOrderId,
      salesChannel: input.salesChannel,
      orderType: input.orderType ?? order.orderType,
      purchaseOrderRef: input.purchaseOrderRef ?? null,
      documentType: input.documentType ?? null,
      carrier: input.carrier ?? null,
      priority: input.priority ?? order.priority,
      shipTo: input.shipTo,
      lines,
    };
    updated.events = (order.events || []).concat(
      this.ev('UPDATED', actor, `${lines.length} línea(s) · ${this.unitsOf(updated)} un`),
    );
    await this.orders.save(updated);
    return updated;
  }

  /**
   * Reserva el stock de una orden (full-or-nothing).
   * Si una línea no puede reservarse completa, se liberan las reservas ya hechas.
   */
  async allocate(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.RECEIVED) {
      throw new ValidationError(`La orden ${orderId} no se puede reservar en estado ${order.status}`);
    }

    const done: { sku: string; allocations: Allocation[] }[] = [];
    try {
      for (const line of order.lines) {
        // Un kit VIRTUAL se explota en sus componentes; el resto reserva su propio SKU.
        const demands = await this.demandFor(sellerId, line);
        const lineAllocs: Allocation[] = [];
        for (const d of demands) {
          const allocations = await this.inventory.reserve(sellerId, {
            sku: d.sku,
            qty: d.qty,
            lot: d.lot,
            reference: `ORDER:${order.id}`,
          });
          const tagged = allocations.map((a) => ({ ...a, sku: d.sku }));
          lineAllocs.push(...tagged);
          done.push({ sku: d.sku, allocations: tagged });
        }
        line.allocations = lineAllocs;
      }
    } catch (err) {
      // Rollback: liberar lo ya reservado para no dejar stock atrapado.
      for (const d of done) {
        await this.inventory.release(sellerId, d.sku, d.allocations, { reference: `ROLLBACK:${order.id}` });
      }
      for (const line of order.lines) line.allocations = [];
      throw err;
    }

    order.status = OrderStatus.ALLOCATED;
    order.events = (order.events || []).concat(this.ev('ALLOCATED', actor, `${this.unitsOf(order)} un reservadas`));
    await this.orders.save(order);
    return order;
  }

  /**
   * Genera la lista de recolección (pick list) desde las reservas de la orden.
   * Es la instrucción que usa el pickeador/escáner: qué SKU tomar, de qué ubicación,
   * qué lote y cuánto. Ordenada por ubicación (ruta tipo serpentina, simplificada).
   */
  async pickList(sellerId: string, orderId: string): Promise<PickTask[]> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.ALLOCATED && order.status !== OrderStatus.PICKING) {
      throw new ValidationError(`No hay pick list para la orden en estado ${order.status}`);
    }
    const tasks: PickTask[] = [];
    for (const line of order.lines) {
      for (const a of line.allocations) {
        tasks.push({ lineNo: line.lineNo, sku: a.sku ?? line.sku, locationId: a.locationId, lot: a.lot, qty: a.qty, pickedQty: a.pickedQty ?? 0, uom: line.uom });
      }
    }
    tasks.sort((a, b) => (a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : a.lineNo - b.lineNo));
    return tasks;
  }

  /** ¿Están todas las asignaciones completamente recolectadas? */
  private isFullyPicked(order: SalesOrder): boolean {
    return order.lines.every((l) => l.allocations.every((a) => (a.pickedQty ?? 0) >= a.qty));
  }

  /**
   * Inicia el picking de una orden reservada: ALLOCATED → PICKING, sin recolectar aún.
   * Marca la orden como "recolección en curso" (la pick list ya está disponible) para que
   * el equipo/escáner empiece a surtirla. Idempotente si ya está en PICKING.
   */
  async startPicking(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status === OrderStatus.PICKING) return order; // ya en curso
    if (order.status !== OrderStatus.ALLOCATED) {
      throw new ValidationError(`Solo se puede iniciar el picking de una orden ALLOCATED (está ${order.status})`);
    }
    order.status = OrderStatus.PICKING;
    order.events = (order.events || []).concat(this.ev('PICKING', actor, 'picking iniciado'));
    await this.orders.save(order);
    return order;
  }

  /**
   * Confirma el picking de UNA ubicación específica de la orden (picking dirigido).
   * Permite surtir la orden desde varias ubicaciones, confirmando de a una.
   * - Lleva la orden a PICKING en la primera confirmación.
   * - Cuando todas las asignaciones quedan recolectadas, pasa a PICKED.
   */
  async pickTask(
    sellerId: string,
    orderId: string,
    input: { sku: string; locationId: string; lot?: string | null; qty?: number },
    actor?: string,
  ): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.ALLOCATED && order.status !== OrderStatus.PICKING) {
      throw new ValidationError(`La orden ${orderId} no está en picking (estado: ${order.status})`);
    }
    const lot = input.lot ?? null;
    // El SKU puede ser el de la línea o —si es un kit VIRTUAL— el de un componente.
    let line: OrderLine | undefined;
    let alloc: Allocation | undefined;
    for (const l of order.lines) {
      const a = l.allocations.find((x) => (x.sku ?? l.sku) === input.sku && x.locationId === input.locationId && (x.lot ?? null) === lot);
      if (a) { line = l; alloc = a; break; }
    }
    if (!line || !alloc) throw new NotFoundError(`No hay reserva de ${input.sku} en la ubicación indicada`);
    const remaining = alloc.qty - (alloc.pickedQty ?? 0);
    if (remaining <= 0) throw new ValidationError(`Esa ubicación ya fue recolectada por completo para ${input.sku}`);
    const take = input.qty != null ? input.qty : remaining;
    if (!(take > 0)) throw new ValidationError(`Cantidad de picking inválida: ${take}`);
    if (take > remaining) throw new ValidationError(`No puedes pickear ${take}: quedan ${remaining} en esa ubicación`);

    await this.inventory.pick(sellerId, {
      sku: input.sku,
      qty: take,
      locationId: alloc.locationId,
      lot: alloc.lot,
      reference: `PICK:${order.id}`,
    });
    alloc.pickedQty = (alloc.pickedQty ?? 0) + take;

    const first = order.status === OrderStatus.ALLOCATED;
    if (first) {
      order.status = OrderStatus.PICKING;
      order.events = (order.events || []).concat(this.ev('PICKING', actor, 'picking iniciado'));
    }
    if (this.isFullyPicked(order)) {
      order.status = OrderStatus.PICKED;
      order.events = (order.events || []).concat(this.ev('PICKED', actor, `${this.unitsOf(order)} un recolectadas`));
    }
    await this.orders.save(order);
    return order;
  }

  /**
   * Confirma la recolección: retira de la bodega el stock reservado de la orden.
   * Cada reserva se pickea de su ubicación/lote (RESERVED sale del inventario).
   */
  /** Completa el picking de la orden: recolecta TODO lo que reste en cada ubicación. */
  async confirmPick(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.ALLOCATED && order.status !== OrderStatus.PICKING) {
      throw new ValidationError(`La orden ${orderId} no se puede pickear en estado ${order.status}`);
    }
    for (const line of order.lines) {
      for (const a of line.allocations) {
        const remaining = a.qty - (a.pickedQty ?? 0);
        if (remaining <= 0) continue;
        await this.inventory.pick(sellerId, {
          sku: a.sku ?? line.sku,
          qty: remaining,
          locationId: a.locationId,
          lot: a.lot,
          reference: `PICK:${order.id}`,
          actor, // G4: el movimiento PICK queda atribuido al operario (no a 'system')
        });
        a.pickedQty = a.qty;
      }
    }
    if (order.status === OrderStatus.ALLOCATED) {
      order.events = (order.events || []).concat(this.ev('PICKING', actor, 'picking iniciado'));
    }
    order.status = OrderStatus.PICKED;
    order.events = (order.events || []).concat(this.ev('PICKED', actor, `${this.unitsOf(order)} un recolectadas`));
    await this.orders.save(order);
    return order;
  }

  /**
   * Empaca la orden (PICKED -> PACKED): las unidades pickeadas se embalan en `bultos`.
   * Deja la información de empaque con las etiquetas PENDIENTES; la fachada conecta
   * luego con el OMS de Ninja para traer el tracking + las etiquetas de cada bulto.
   */
  async packOrder(
    sellerId: string,
    orderId: string,
    input: { bultos?: number; materials?: { sku: string; name: string; qty: number }[] } = {},
    actor?: string,
  ): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.PICKED) {
      throw new ValidationError(`La orden ${orderId} debe estar PICKED para empacar (está ${order.status})`);
    }
    const bultos = Math.max(1, Math.floor(input.bultos ?? 1));
    const materials = input.materials ?? [];
    const packing: PackingInfo = {
      packedAt: this.clock.now(),
      bultos,
      packedBy: actor || 'system',
      trackingNumber: null,
      carrier: null,
      labelStatus: 'PENDING',
      labelError: null,
      labels: [],
      source: null,
      labeledAt: null,
      materials,
    };
    order.packing = packing;
    order.status = OrderStatus.PACKED;
    const matNote = materials.length ? ` · embalaje: ${materials.map((m) => `${m.qty}× ${m.name}`).join(', ')}` : '';
    order.events = (order.events || []).concat(
      this.ev('PACKED', actor, `${bultos} bulto(s) · esperando etiquetas del OMS${matNote}`),
    );
    await this.orders.save(order);
    return order;
  }

  /**
   * Adjunta a una orden empacada el tracking + las etiquetas que devolvió el OMS.
   * Marca las etiquetas como LISTAS para que el operario las vea/imprima en packing.
   */
  async attachShippingLabels(
    sellerId: string,
    orderId: string,
    result: AttachLabelsInput,
    actor?: string,
  ): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (!order.packing || (order.status !== OrderStatus.PACKED && order.status !== OrderStatus.SHIPPED)) {
      throw new ValidationError(`La orden ${orderId} no está empacada; no se pueden adjuntar etiquetas`);
    }
    const labels = result.labels ?? [];
    order.packing = {
      ...order.packing,
      trackingNumber: result.trackingNumber ?? order.packing.trackingNumber,
      carrier: result.carrier ?? order.packing.carrier,
      labels,
      labelStatus: 'READY',
      labelError: null,
      source: result.source ?? 'oms-ninja',
      labeledAt: this.clock.now(),
    };
    const detail = [order.packing.carrier, order.packing.trackingNumber].filter(Boolean).join(' ')
      || `${labels.length} etiqueta(s)`;
    order.events = (order.events || []).concat(this.ev('LABELED', actor, detail));
    await this.orders.save(order);
    return order;
  }

  /** Marca que el OMS no entregó etiquetas (se puede reintentar desde packing). */
  async markLabelError(sellerId: string, orderId: string, error: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (!order.packing) return order;
    order.packing = { ...order.packing, labelStatus: 'ERROR', labelError: error };
    await this.orders.save(order);
    return order;
  }

  /**
   * Despacha la orden. El modo se deriva del tipo: B2C -> paquetería, B2B -> transporte.
   * En producción aquí se cotiza y genera la guía con el courier/transporte.
   * Acepta despachar desde PICKED (sin packing) o PACKED (heredando tracking/courier del OMS).
   */
  async ship(
    sellerId: string,
    orderId: string,
    input: { carrier?: string | null; trackingNumber?: string | null } = {},
    actor?: string,
  ): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.PICKED && order.status !== OrderStatus.PACKED) {
      throw new ValidationError(`La orden ${orderId} debe estar PICKED o PACKED para despachar (está ${order.status})`);
    }
    // Si viene empacada, hereda el courier/tracking que asignó el OMS cuando no se indica otro.
    const carrier = input.carrier ?? order.packing?.carrier ?? null;
    const trackingNumber = input.trackingNumber ?? order.packing?.trackingNumber ?? null;
    const shipment: Shipment = {
      mode: order.orderType === OrderType.B2B ? ShippingMode.FREIGHT : ShippingMode.PARCEL,
      carrier,
      trackingNumber,
      shippedAt: this.clock.now(),
    };
    order.shipment = shipment;
    order.status = OrderStatus.SHIPPED;
    const shipDetail = [shipment.carrier, shipment.trackingNumber].filter(Boolean).join(' ') || String(shipment.mode);
    order.events = (order.events || []).concat(this.ev('SHIPPED', actor, shipDetail));
    await this.orders.save(order);
    return order;
  }

  /** Cancela una orden y libera sus reservas (solo antes de pickear). */
  async cancel(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status === OrderStatus.CANCELLED) return order;
    if (
      order.status === OrderStatus.PICKED ||
      order.status === OrderStatus.PACKED ||
      order.status === OrderStatus.SHIPPED
    ) {
      throw new ValidationError(`No se puede cancelar una orden en estado ${order.status}`);
    }

    const released = order.status === OrderStatus.ALLOCATED || order.status === OrderStatus.PICKING;
    if (released) {
      for (const line of order.lines) {
        // Liberar por SKU real de cada reserva (los kits virtuales reservan componentes).
        const bySku: Record<string, Allocation[]> = {};
        for (const a of line.allocations) {
          const s = a.sku ?? line.sku;
          (bySku[s] = bySku[s] || []).push(a);
        }
        for (const s of Object.keys(bySku)) {
          await this.inventory.release(sellerId, s, bySku[s], { reference: `CANCEL:${order.id}` });
        }
        line.allocations = [];
      }
    }
    order.status = OrderStatus.CANCELLED;
    order.events = (order.events || []).concat(
      this.ev('CANCELLED', actor, released ? 'reservas liberadas' : null),
    );
    await this.orders.save(order);
    return order;
  }

  /**
   * Reactiva una orden CANCELADA, devolviéndola al flujo. Como al cancelar se
   * liberan las reservas, vuelve a "Ingresada" (estado base) y, si antes tenía
   * stock reservado, intenta re-reservarlo para dejarla lista igual que antes.
   * Deja rastro en el HISTORIAL de la orden y una marca en el KARDEX, con el usuario.
   */
  async reactivate(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.CANCELLED) {
      throw new ValidationError(`Solo se puede reactivar una orden cancelada (estado actual: ${order.status})`);
    }
    // Inferir el estado previo a la cancelación desde el historial.
    let hadReservations = false;
    const evs = order.events || [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const t = evs[i].type;
      if (t === 'ALLOCATED' || t === 'PICKING') { hadReservations = true; break; }
      if (t === 'CREATED' || t === 'UPDATED') break;
    }
    // Marca de auditoría en el kardex (qty 0), con el usuario y la referencia de la orden.
    const auditSku = order.lines[0] ? order.lines[0].sku : null;
    if (auditSku) {
      await this.inventory.postAudit(sellerId, {
        sku: auditSku,
        type: MovementType.REACTIVATION,
        reference: `REACT:${order.externalOrderId || order.id}`,
        actor,
      });
    }
    // Vuelve a Ingresada (las reservas ya se liberaron al cancelar).
    order.status = OrderStatus.RECEIVED;
    order.events = evs.concat(
      this.ev('REACTIVATED', actor, hadReservations ? 'Reactivada; se intentará re-reservar el stock' : 'Reactivada → Ingresada'),
    );
    await this.orders.save(order);

    // Si antes tenía stock reservado, intentar dejarla reservada de nuevo.
    if (hadReservations) {
      try {
        return await this.allocate(sellerId, orderId, actor);
      } catch (err) {
        const o2 = await this.mustGet(sellerId, orderId);
        o2.events = (o2.events || []).concat(
          this.ev('REACTIVATED', actor, `No se pudo re-reservar (${(err as Error).message}); quedó en Ingresada`),
        );
        await this.orders.save(o2);
        return o2;
      }
    }
    return order;
  }

  async getOrder(sellerId: string, orderId: string): Promise<SalesOrder | null> {
    return this.orders.findById(sellerId, orderId);
  }

  async listOrders(sellerId: string): Promise<SalesOrder[]> {
    return this.orders.list(sellerId);
  }

  /** Busca una orden por su referencia externa del OMS (clave de idempotencia). */
  findByExternal(sellerId: string, externalOrderId: string): Promise<SalesOrder | null> {
    return this.orders.findByExternal(sellerId, externalOrderId);
  }

  /** Elimina una orden (consolidación de duplicados; G1). */
  delete(sellerId: string, orderId: string): Promise<void> {
    return this.orders.delete(sellerId, orderId);
  }

  private async mustGet(sellerId: string, orderId: string): Promise<SalesOrder> {
    const order = await this.orders.findById(sellerId, orderId);
    if (!order) throw new NotFoundError(`Orden no encontrada para el seller ${sellerId}: ${orderId}`);
    return order;
  }
}
