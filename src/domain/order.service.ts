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
import { NotFoundError, ValidationError, StockShortageError, StockShortage } from './errors';
import { InventoryService } from './inventory.service';
import {
  Clock,
  IdGenerator,
  OrderRepository,
  ReceiptOrderRepository,
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
  PackVerification,
  PickTask,
  StockState,
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
  /** Deadline de preparación ya resuelto (lo calcula el facade con la config de la operación). */
  dueAt?: string | null;
  /** De dónde salió ese deadline: oms | manual | corte | sla. */
  dueSource?: string | null;
}

export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly inventory: InventoryService,
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    /** Opcional: permite decir DE QUÉ recepción viene el stock que está sin guardar. */
    private readonly receipts?: ReceiptOrderRepository,
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
      dueAt: input.dueAt ?? null,
      dueSource: input.dueAt ? (input.dueSource ?? 'manual') : null,
      events: [],
    };
    order.events.push(this.ev('CREATED', actor, `${lines.length} línea(s) · ${this.unitsOf(order)} un`));
    await this.orders.save(order);
    return order;
  }

  /**
   * Fija o quita el deadline de preparación de una orden ya creada.
   * A diferencia de editar la orden, esto se puede hacer en cualquier estado abierto:
   * que el courier mueva su hora de retiro no tiene nada que ver con las líneas ni
   * con el stock comprometido. Solo se bloquea en órdenes ya cerradas.
   */
  async setDueAt(sellerId: string, orderId: string, dueAt: string | null, source: string | null, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status === OrderStatus.SHIPPED || order.status === OrderStatus.CANCELLED) {
      throw new ValidationError(`No se puede cambiar el deadline de una orden ${order.status === OrderStatus.SHIPPED ? 'ya despachada' : 'cancelada'}.`);
    }
    let iso: string | null = null;
    if (dueAt) {
      const t = Date.parse(dueAt);
      if (Number.isNaN(t)) throw new ValidationError(`Fecha de deadline inválida: ${dueAt}`);
      iso = new Date(t).toISOString();
    }
    const antes = order.dueAt || 'sin deadline';
    const updated: SalesOrder = {
      ...order,
      dueAt: iso,
      dueSource: iso ? (source || 'manual') : null,
      events: (order.events || []).concat(this.ev('DUE_SET', actor, `${antes} → ${iso || 'sin deadline'}`)),
    };
    await this.orders.save(updated);
    return updated;
  }

  /**
   * SOLO PARA DATOS DE DEMOSTRACIÓN: corre hacia atrás las fechas de una orden
   * (creación e historial) para poder mostrar órdenes "detenidas hace N horas"
   * sin esperar N horas. No toca stock, estado ni líneas.
   */
  async backdateForDemo(sellerId: string, orderId: string, horas: number): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    const shift = (iso: string) => new Date(Date.parse(iso) - horas * 3600000).toISOString();
    const updated: SalesOrder = {
      ...order,
      createdAt: shift(order.createdAt),
      events: (order.events || []).map((e) => ({ ...e, at: shift(e.at) })),
    };
    await this.orders.save(updated);
    return updated;
  }

  /**
   * Sube una orden a prioridad ALTA. Lo usa el agente cuando un compromiso está
   * en riesgo y no queda ningún operario libre: si la orden tiene que esperar en
   * la bandeja de alguien, al menos que espere primera. El recálculo de
   * prioridades ya premia a las órdenes 'alta', así que la escalada sobrevive.
   */
  async escalatePriority(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.priority === 'alta') return order;
    const updated: SalesOrder = {
      ...order,
      priority: 'alta',
      events: [...(order.events || []), { type: 'PRIORIDAD', at: this.clock.now(), actor: actor || 'agente', detail: 'Prioridad ALTA por deadline en riesgo' } as any],
    };
    await this.orders.save(updated);
    return updated;
  }

  /** Libera TODAS las reservas pendientes de una orden (lo ya recolectado no vuelve). */
  private async releaseAllocations(order: SalesOrder, sellerId: string, reference: string): Promise<void> {
    for (const line of order.lines) {
      const bySku: Record<string, Allocation[]> = {};
      for (const a of line.allocations || []) {
        const sk = a.sku ?? line.sku;
        const pending = a.qty - Math.max(0, Math.min(a.qty, a.pickedQty ?? 0));
        if (pending <= 0) continue;
        (bySku[sk] = bySku[sk] || []).push({ ...a, qty: pending });
      }
      for (const sk of Object.keys(bySku)) {
        await this.inventory.release(sellerId, sk, bySku[sk], { reference });
      }
      line.allocations = [];
    }
  }

  /**
   * Edita una orden ya creada. Reemplaza el encabezado y las líneas.
   *
   * - RECEIVED (ingresada): edición directa, no hay stock comprometido.
   * - ALLOCATED (reservada): se puede editar igual. Como hay stock reservado, la edición
   *   es una operación en tres pasos — liberar las reservas, aplicar los cambios y volver
   *   a reservar — y es TODO O NADA: si las líneas nuevas no alcanzan a reservarse (no hay
   *   stock), se restauran las líneas anteriores y su reserva, y la orden queda como estaba.
   * - Desde PICKING en adelante NO se puede editar: ya hay mercadería fuera de su ubicación.
   *
   * El N° de orden externo nunca cambia: es la referencia con la que el cliente y el OMS
   * identifican el pedido.
   */
  async updateOrder(sellerId: string, orderId: string, input: CreateOrderInput, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    const editable = order.status === OrderStatus.RECEIVED || order.status === OrderStatus.ALLOCATED;
    if (!editable) {
      const porQue = order.status === OrderStatus.PICKING || order.status === OrderStatus.PICKED
        ? 'ya se está recolectando: la mercadería salió de su ubicación'
        : order.status === OrderStatus.PACKED ? 'ya está empacada'
        : order.status === OrderStatus.SHIPPED ? 'ya fue despachada'
        : 'está cancelada';
      throw new ValidationError(`No se puede editar esta orden porque ${porQue} (estado: ${order.status}).`);
    }
    if (input.externalOrderId && input.externalOrderId !== order.externalOrderId) {
      throw new ValidationError('El N° de orden no se puede cambiar: es la referencia del pedido para el cliente y el OMS.');
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

    const wasAllocated = order.status === OrderStatus.ALLOCATED;
    // Copia profunda para poder deshacer si la reserva nueva no alcanza.
    const previo: SalesOrder | null = wasAllocated ? JSON.parse(JSON.stringify(order)) : null;
    const antes = `${order.lines.length} línea(s) · ${this.unitsOf(order)} un`;

    if (wasAllocated) await this.releaseAllocations(order, sellerId, `EDIT:${order.id}`);

    const updated: SalesOrder = {
      ...order,
      externalOrderId: order.externalOrderId,
      salesChannel: input.salesChannel,
      orderType: input.orderType ?? order.orderType,
      purchaseOrderRef: input.purchaseOrderRef ?? null,
      documentType: input.documentType ?? null,
      carrier: input.carrier ?? null,
      priority: input.priority ?? order.priority,
      shipTo: input.shipTo,
      lines,
      status: OrderStatus.RECEIVED,
      dueAt: input.dueAt ?? null,
      dueSource: input.dueAt ? (input.dueSource ?? 'manual') : null,
    };
    const despues = `${lines.length} línea(s) · ${this.unitsOf(updated)} un`;
    updated.events = (order.events || []).concat(
      this.ev('UPDATED', actor, wasAllocated ? `${antes} → ${despues} (reservas rehechas)` : despues),
    );
    await this.orders.save(updated);
    if (!wasAllocated) return updated;

    // Estaba reservada: hay que dejarla reservada otra vez, o deshacer del todo.
    try {
      return await this.allocate(sellerId, orderId, actor);
    } catch (e) {
      await this.restoreAfterFailedEdit(previo as SalesOrder, sellerId, actor);
      const ref = order.externalOrderId || order.id;
      if (e instanceof StockShortageError) {
        // Se conserva el detalle por producto y se agrega qué pasó con la orden.
        throw new StockShortageError(
          `No se pudo guardar la orden ${ref}: no hay stock para las líneas nuevas. La orden quedó como estaba (${antes}, reservada).`,
          e.faltantes,
          ref,
        );
      }
      throw new ValidationError(
        `No se pudo reservar el stock de las líneas nuevas: ${(e as Error).message} — la orden quedó como estaba (${antes}, reservada).`,
      );
    }
  }

  /** Deshace una edición fallida: vuelve a las líneas anteriores y a su reserva. */
  private async restoreAfterFailedEdit(previo: SalesOrder, sellerId: string, actor?: string): Promise<void> {
    const restaurada: SalesOrder = {
      ...previo,
      status: OrderStatus.RECEIVED,
      lines: previo.lines.map((l) => ({ ...l, allocations: [] })),
    };
    await this.orders.save(restaurada);
    try {
      await this.allocate(sellerId, previo.id, actor);
    } catch {
      // Caso extremo: alguien tomó el stock entremedio. Queda ingresada y con aviso.
      const aviso: SalesOrder = {
        ...restaurada,
        events: (restaurada.events || []).concat(
          this.ev('UPDATED', actor, 'la edición se deshizo pero el stock ya no alcanzó para volver a reservar: la orden quedó INGRESADA'),
        ),
      };
      await this.orders.save(aviso);
    }
  }

  /**
   * Reserva el stock de una orden (full-or-nothing).
   * Si una línea no puede reservarse completa, se liberan las reservas ya hechas.
   */
  /**
   * Revisa la orden completa y devuelve TODOS los productos cuyo stock reservable no
   * alcanza. Agrupa por SKU y lote, porque un mismo producto puede venir en varias
   * líneas (y un kit virtual aporta la demanda de sus componentes).
   */
  private async checkShortages(sellerId: string, order: SalesOrder): Promise<StockShortage[]> {
    const demanda = new Map<string, { sku: string; lot: string | null; qty: number }>();
    for (const line of order.lines) {
      for (const d of await this.demandFor(sellerId, line)) {
        const lot = d.lot ?? null;
        const key = `${d.sku}|${lot ?? ''}`;
        const cur = demanda.get(key);
        if (cur) cur.qty += d.qty;
        else demanda.set(key, { sku: d.sku, lot, qty: d.qty });
      }
    }
    const faltantes: StockShortage[] = [];
    for (const d of demanda.values()) {
      const r = await this.inventory.reservableSummary(sellerId, d.sku, d.lot);
      if (r.reservable >= d.qty) continue;
      const sku = await this.skus.find(sellerId, d.sku).catch(() => null);
      // Si hay stock esperando en el dock, se dice de QUÉ recepción viene y cuánto,
      // para poder ir a buscarla sin tener que revisar una por una.
      let recepciones: StockShortage['recepciones'];
      if (r.enRecepcion > 0) {
        try {
          const origen = await this.inventory.receivingByReceipt(sellerId, d.sku, d.lot);
          recepciones = [];
          for (const o of origen) {
            const rec = this.receipts ? await this.receipts.findById(sellerId, o.receiptId).catch(() => null) : null;
            recepciones.push({
              id: o.receiptId,
              referencia: rec?.reference ?? null,
              proveedor: rec?.supplier ?? null,
              fecha: o.at,
              cantidad: o.pendiente,
            });
          }
        } catch { recepciones = undefined; }
      }
      faltantes.push({
        sku: d.sku,
        descripcion: sku?.description ?? null,
        lot: d.lot,
        requerido: d.qty,
        reservable: r.reservable,
        falta: d.qty - r.reservable,
        enRecepcion: r.enRecepcion,
        enOtrasZonas: r.enOtrasZonas,
        ...(recepciones && recepciones.length ? { recepciones } : {}),
      });
    }
    return faltantes;
  }

  async allocate(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.RECEIVED) {
      throw new ValidationError(`La orden ${orderId} no se puede reservar en estado ${order.status}`);
    }

    // Antes de reservar nada, se revisan TODAS las líneas: si falta stock, la orden no
    // se puede reservar igual, y reportar de a un producto obliga a arreglar y reintentar
    // tantas veces como productos falten. Se informan todos juntos, por orden.
    const faltantes = await this.checkShortages(sellerId, order);
    if (faltantes.length) {
      const ref = order.externalOrderId || order.id;
      const resumen = faltantes.map((f) => `${f.sku} (faltan ${f.falta})`).join(', ');
      throw new StockShortageError(
        `No se puede reservar la orden ${ref}: falta stock de ${faltantes.length} producto(s) — ${resumen}.`,
        faltantes,
        ref,
      );
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
    input: { bultos?: number; materials?: { sku: string; name: string; qty: number }[]; verify?: Array<{ sku: string; lot?: string | null; qty: number }> | null } = {},
    actor?: string,
  ): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    if (order.status !== OrderStatus.PICKED) {
      throw new ValidationError(`La orden ${orderId} debe estar PICKED para empacar (está ${order.status})`);
    }
    const bultos = Math.max(1, Math.floor(input.bultos ?? 1));
    const materials = input.materials ?? [];
    const verification = input.verify ? this.verifyPack(order, input.verify, actor) : null;
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
      verification,
    };
    order.packing = packing;
    order.status = OrderStatus.PACKED;
    const matNote = materials.length ? ` · embalaje: ${materials.map((m) => `${m.qty}× ${m.name}`).join(', ')}` : '';
    const verNote = verification
      ? (verification.ok
        ? ' · verificado: calza'
        : ` · VERIFICACIÓN CON DIFERENCIAS: ${verification.diferencias.map((d) => `${d.sku} pedía ${d.esperado}, contado ${d.contado}`).join('; ')}`)
      : '';
    order.events = (order.events || []).concat(
      this.ev('PACKED', actor, `${bultos} bulto(s) · esperando etiquetas del OMS${matNote}${verNote}`),
    );
    await this.orders.save(order);
    return order;
  }

  /**
   * Compara lo que el operario contó al cerrar el bulto contra lo que la orden pedía.
   * No bloquea el empaque: registra la diferencia, que es lo que después mide la
   * PRECISIÓN DE PREPARACIÓN. Un pedido con cualquier diferencia cuenta como error.
   */
  private verifyPack(order: SalesOrder, contado: Array<{ sku: string; lot?: string | null; qty: number }>, actor?: string): PackVerification {
    const key = (sku: string, lot: string | null | undefined) => `${sku}|${lot || ''}`;
    const esperado = new Map<string, number>();
    for (const l of order.lines) esperado.set(key(l.sku, l.lot), (esperado.get(key(l.sku, l.lot)) || 0) + l.qty);
    const real = new Map<string, number>();
    for (const c of contado) real.set(key(c.sku, c.lot), (real.get(key(c.sku, c.lot)) || 0) + Math.max(0, Math.floor(c.qty || 0)));
    const diferencias: PackVerification['diferencias'] = [];
    for (const k of new Set([...esperado.keys(), ...real.keys()])) {
      const e = esperado.get(k) || 0, r = real.get(k) || 0;
      if (e === r) continue;
      const [sku, lot] = k.split('|');
      diferencias.push({ sku, lot: lot || null, esperado: e, contado: r });
    }
    return {
      at: this.clock.now(),
      by: actor || 'system',
      ok: diferencias.length === 0,
      lineasVerificadas: esperado.size,
      lineasConError: diferencias.length,
      diferencias,
    };
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
  /**
   * Cancela una orden y DEVUELVE la mercadería a la bodega.
   *
   * Según dónde estaba la orden, hay dos cosas distintas que deshacer:
   *  - lo que seguía RESERVADO (no se tocó físicamente) vuelve a disponible; y
   *  - lo que ya fue RECOLECTADO vuelve como devolución a la MISMA ubicación de la que
   *    salió, que es la que quedó registrada en la reserva de cada línea.
   * Por eso se puede cancelar en ingresada, reservada, en picking, pickeada y empacada.
   *
   * Despachada NO se puede cancelar: la mercadería ya salió de la bodega y el camino
   * correcto es una devolución, que registra el estado en que vuelve (stock, merma o
   * cuarentena) en vez de darla por buena a ciegas.
   *
   * Los insumos de embalaje de una orden ya empacada no se reponen: la caja se usó.
   */
  async cancel(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.mustGet(sellerId, orderId);
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    if (order.status === OrderStatus.CANCELLED) return order;
    if (order.status === OrderStatus.SHIPPED) {
      throw new ValidationError(
        'No se puede cancelar una orden ya despachada: la mercadería salió de la bodega. Regístrala como devolución para que vuelva a stock.',
      );
    }

    let liberadas = 0;   // seguían reservadas: vuelven a disponible donde estaban
    let devueltas = 0;   // ya recolectadas: vuelven a su ubicación de origen
    const ubicaciones = new Set<string>();

    for (const line of order.lines) {
      // Se libera por SKU real de cada reserva (un kit virtual reserva sus componentes).
      const bySku: Record<string, Allocation[]> = {};
      for (const a of line.allocations || []) {
        const sk = a.sku ?? line.sku;
        const picked = Math.max(0, Math.min(a.qty, a.pickedQty ?? 0));
        const pendiente = a.qty - picked;
        if (pendiente > 0) {
          (bySku[sk] = bySku[sk] || []).push({ ...a, qty: pendiente });
          liberadas += pendiente;
        }
        if (picked > 0) {
          // La mercadería recolectada está físicamente en un carro, NO en su estante.
          // Si volviera directo a su ubicación, el sistema la daría por disponible y
          // otra orden podría reservarla sin que esté ahí. Por eso aterriza en la
          // ubicación de REPOSICIÓN (zona de recepción: visible pero no reservable) y
          // queda pendiente una tarea de reposición que la devuelve a su sitio.
          // La referencia guarda de DÓNDE salió, para poder sugerir ese destino.
          const repo = await this.inventory.ensureReposicionLocation(seller.operationId);
          await this.inventory.postReturn(sellerId, {
            sku: sk,
            qty: picked,
            state: StockState.AVAILABLE,
            locationId: repo.id,
            lot: a.lot,
            reference: `CANCEL:${order.id}|FROM:${a.locationId}`,
            actor,
          });
          devueltas += picked;
          ubicaciones.add(a.locationId);
        }
      }
      for (const sk of Object.keys(bySku)) {
        await this.inventory.release(sellerId, sk, bySku[sk], { reference: `CANCEL:${order.id}`, actor });
      }
      line.allocations = [];
    }

    order.status = OrderStatus.CANCELLED;
    const partes: string[] = [];
    if (liberadas) partes.push(`${liberadas} un liberadas de reserva`);
    if (devueltas) partes.push(`${devueltas} un recolectadas quedan pendientes de reposición a ${ubicaciones.size} ubicación(es)`);
    if (order.packing) partes.push('los insumos de embalaje usados no se reponen');
    order.events = (order.events || []).concat(this.ev('CANCELLED', actor, partes.join(' · ') || null));
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
  /**
   * ELIMINAR UNA ORDEN ESTÁ BLOQUEADO. Una orden nunca se borra: se cancela, y así
   * conserva su historial, su trazabilidad y los movimientos de stock que generó.
   * El único uso permitido es interno: consolidar filas DUPLICADAS creadas por
   * reintentos del webhook del OMS, que no representan un pedido real.
   */
  delete(sellerId: string, orderId: string, motivo?: 'consolidacion-de-duplicados'): Promise<void> {
    if (motivo !== 'consolidacion-de-duplicados') {
      throw new ValidationError(
        'Las órdenes no se eliminan: cancélala. Cancelar devuelve el stock a la bodega y conserva el historial del pedido.',
      );
    }
    return this.orders.delete(sellerId, orderId);
  }

  private async mustGet(sellerId: string, orderId: string): Promise<SalesOrder> {
    const order = await this.orders.findById(sellerId, orderId);
    if (!order) throw new NotFoundError(`Orden no encontrada para el seller ${sellerId}: ${orderId}`);
    return order;
  }
}
