import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { WmsFacade } from '../app/wms.facade';
import { AllocateAllDto, AttachLabelsDto, CreateOrderDto, PackOrderDto, PickTaskDto, SetDueDateDto, ShipDto } from './dto';
import { actorOf, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

// Etiquetas legibles para la exportación de la lista de órdenes.
const ORDER_STATUS_LABELS: Record<string, string> = {
  RECEIVED: 'Ingresada',
  ALLOCATED: 'Reservada',
  PICKING: 'En picking',
  PICKED: 'Pickeada',
  PACKED: 'Empacada',
  SHIPPED: 'Despachada',
  CANCELLED: 'Cancelada',
};
const DOC_LABELS: Record<string, string> = {
  boleta: 'Boleta',
  factura: 'Factura',
  guia_despacho: 'Guía de despacho',
  orden_compra: 'Orden de compra',
};

/**
 * Órdenes de venta. El OMS ingresa aquí con seller (en el path) y canal (en el body).
 * `?allocate=true` reserva el stock en el mismo paso del ingreso.
 */
@Controller('sellers/:sellerId/orders')
export class OrdersController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Post()
  @RequirePermission('order:create')
  async create(
    @Param('sellerId') sellerId: string,
    @Body() dto: CreateOrderDto,
    @CurrentUser() user: User | null,
    @Query('allocate') allocate?: string,
  ) {
    const actor = actorOf(user);
    const order = await this.wms.createOrder(sellerId, {
      externalOrderId: dto.externalOrderId,
      salesChannel: dto.salesChannel,
      orderType: dto.orderType,
      purchaseOrderRef: dto.purchaseOrderRef ?? null,
      documentType: dto.documentType ?? null,
      carrier: dto.carrier ?? null,
      priority: dto.priority,
      dueAt: dto.dueAt ?? null,
      dueSource: dto.dueSource ?? (dto.dueAt ? 'oms' : null),
      shipTo: dto.shipTo,
      lines: dto.lines.map((l) => ({ sku: l.sku, qty: l.qty, uom: l.unit, lot: l.lot ?? null })),
    }, actor);
    // Reserva explícita por request. Si el cliente ya reserva al ingresar, createOrder
    // pudo dejarla ALLOCATED: solo reservamos si sigue RECEIVED, para no reservar dos veces.
    if (allocate === 'true' && order.status === 'RECEIVED') {
      return this.wms.allocateOrder(sellerId, order.id, actor);
    }
    return order;
  }

  /** Editar una orden aún en estado RECEIVED (encabezado + líneas). */
  @Patch(':orderId')
  @RequirePermission('order:create')
  update(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @Body() dto: CreateOrderDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.updateOrder(sellerId, orderId, {
      externalOrderId: dto.externalOrderId,
      salesChannel: dto.salesChannel,
      orderType: dto.orderType,
      purchaseOrderRef: dto.purchaseOrderRef ?? null,
      documentType: dto.documentType ?? null,
      carrier: dto.carrier ?? null,
      priority: dto.priority,
      dueAt: dto.dueAt ?? null,
      dueSource: dto.dueSource ?? null,
      shipTo: dto.shipTo,
      lines: dto.lines.map((l) => ({ sku: l.sku, qty: l.qty, uom: l.unit, lot: l.lot ?? null })),
    }, actorOf(user));
  }

  /**
   * Fija o quita el deadline de preparación de una orden. Se puede en cualquier estado
   * abierto: que el courier mueva su hora de retiro no cambia las líneas ni el stock.
   */
  @Patch(':orderId/due-date')
  @RequirePermission('order:create')
  setDueDate(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @Body() dto: SetDueDateDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.setOrderDueAt(sellerId, orderId, dto.dueAt || null, dto.source || 'manual', actorOf(user));
  }

  @Post(':orderId/allocate')
  @RequirePermission('order:fulfill')
  allocate(@Param('sellerId') sellerId: string, @Param('orderId') orderId: string, @CurrentUser() user: User | null) {
    return this.wms.allocateOrder(sellerId, orderId, actorOf(user));
  }

  /** Reserva de stock MASIVA: reserva varias órdenes de una vez.
   *  Body opcional { orderIds:[...] }; si se omite, reserva todas las RECEIVED. */
  @Post('allocate-all')
  @RequirePermission('order:fulfill')
  allocateAll(
    @Param('sellerId') sellerId: string,
    @Body() dto: AllocateAllDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.allocateOrders(sellerId, dto?.orderIds ?? null, actorOf(user));
  }

  @Post(':orderId/cancel')
  @RequirePermission('order:cancel')
  cancel(@Param('sellerId') sellerId: string, @Param('orderId') orderId: string, @CurrentUser() user: User | null) {
    return this.wms.cancelOrder(sellerId, orderId, actorOf(user));
  }

  @Post(':orderId/reactivate')
  @RequirePermission('order:cancel')
  reactivate(@Param('sellerId') sellerId: string, @Param('orderId') orderId: string, @CurrentUser() user: User | null) {
    return this.wms.reactivateOrder(sellerId, orderId, actorOf(user));
  }

  /** Lista de recolección (instrucción para el pickeador). */
  @Get(':orderId/picklist')
  @RequirePermission('stock:read')
  pickList(@Param('sellerId') sellerId: string, @Param('orderId') orderId: string) {
    return this.wms.getPickList(sellerId, orderId);
  }

  /** Tareas (todas las etapas) de una orden: reserva, picking, packing, despacho, con id/tipo/estado. */
  @Get(':orderId/tasks')
  @RequirePermission('stock:read')
  tasks(@Param('sellerId') sellerId: string, @Param('orderId') orderId: string) {
    return this.wms.orderTasks(sellerId, orderId);
  }

  /** Pasar a picking: ALLOCATED → PICKING (marca la recolección en curso, sin recolectar aún). */
  @Post(':orderId/start-picking')
  @RequirePermission('order:fulfill')
  startPicking(@Param('sellerId') sellerId: string, @Param('orderId') orderId: string, @CurrentUser() user: User | null) {
    return this.wms.startPicking(sellerId, orderId, actorOf(user));
  }

  /** Confirmar picking COMPLETO: recolecta todo lo que reste de la orden. */
  @Post(':orderId/pick')
  @RequirePermission('order:fulfill')
  pick(@Param('sellerId') sellerId: string, @Param('orderId') orderId: string, @CurrentUser() user: User | null) {
    return this.wms.confirmPick(sellerId, orderId, actorOf(user));
  }

  /** Confirmar picking de UNA ubicación (picking dirigido / multi-ubicación). */
  @Post(':orderId/pick-task')
  @RequirePermission('order:fulfill')
  pickTask(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @Body() dto: PickTaskDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.pickTask(
      sellerId,
      orderId,
      { sku: dto.sku, locationId: dto.locationId, lot: dto.lot ?? null, qty: dto.qty },
      actorOf(user),
    );
  }

  /** Empacar la orden (PICKED → PACKED): embala en bultos y conecta con el OMS
   * para traer el tracking del transporte + las etiquetas de cada bulto. */
  @Post(':orderId/pack')
  @RequirePermission('order:fulfill')
  pack(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @Body() dto: PackOrderDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.packOrder(sellerId, orderId, {
      bultos: dto.bultos,
      materials: (dto.materials ?? []).map((m) => ({ sku: m.sku, qty: m.qty })),
      verify: dto.verify ? dto.verify.map((v) => ({ sku: v.sku, lot: v.lot ?? null, qty: v.qty })) : null,
    }, actorOf(user));
  }

  /** Reintentar la obtención de tracking + etiquetas desde el OMS. */
  @Post(':orderId/labels/fetch')
  @RequirePermission('order:fulfill')
  fetchLabels(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.fetchShippingLabels(sellerId, orderId, actorOf(user));
  }

  /** Callback del OMS (inbound): adjunta tracking + etiquetas a una orden empacada. */
  @Post(':orderId/labels')
  @RequirePermission('order:fulfill')
  attachLabels(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @Body() dto: AttachLabelsDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.attachShippingLabels(
      sellerId,
      orderId,
      {
        trackingNumber: dto.trackingNumber ?? null,
        carrier: dto.carrier ?? null,
        labels: (dto.labels ?? []).map((l) => ({
          bultoNo: l.bultoNo,
          trackingNumber: l.trackingNumber ?? null,
          carrier: l.carrier ?? null,
          format: l.format ?? 'SVG',
          dataUri: l.dataUri,
        })),
      },
      actorOf(user),
    );
  }

  /** Despachar (courier B2C / transporte B2B). */
  @Post(':orderId/ship')
  @RequirePermission('order:fulfill')
  ship(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @Body() dto: ShipDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.shipOrder(sellerId, orderId, {
      carrier: dto.carrier ?? null,
      trackingNumber: dto.trackingNumber ?? null,
    }, actorOf(user));
  }

  @Get()
  @RequirePermission('stock:read')
  list(@Param('sellerId') sellerId: string) {
    return this.wms.listOrders(sellerId);
  }

  /** Exporta la lista de órdenes a Excel (.xlsx). Ruta estática: debe ir ANTES de :orderId. */
  @Get('export')
  @RequirePermission('stock:read')
  async export(@Param('sellerId') sellerId: string, @Res() res: Response) {
    const orders = await this.wms.listOrders(sellerId);
    const HEADERS = [
      'N° de orden', 'Estado', 'Canal', 'Tipo', 'Prioridad', 'Documento', 'Courier',
      'Destinatario', 'Teléfono', 'Comuna/Ciudad', 'Dirección',
      'Líneas', 'Unidades', 'Tracking', 'Creada',
    ];
    const rows = [
      HEADERS,
      ...orders.map((o) => {
        const units = (o.lines || []).reduce((a, l) => a + (l.qty || 0), 0);
        const st = (o.shipTo || {}) as any;
        return [
          o.externalOrderId,
          ORDER_STATUS_LABELS[o.status] || o.status,
          o.salesChannel || '',
          o.orderType,
          o.priority || '',
          o.documentType ? (DOC_LABELS[o.documentType] || o.documentType) : '',
          o.carrier || '',
          st.name || '',
          st.phone || '',
          st.comuna || '',
          st.address || '',
          (o.lines || []).length,
          units,
          (o.shipment && o.shipment.trackingNumber) || '',
          o.createdAt ? new Date(o.createdAt).toLocaleString('es-CL') : '',
        ];
      }),
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [
      { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 10 }, { wch: 16 }, { wch: 14 },
      { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 28 }, { wch: 8 }, { wch: 9 }, { wch: 18 }, { wch: 20 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Órdenes');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="ordenes-ninjawms.xlsx"');
    res.send(buf);
  }

  /**
   * Órdenes con el deadline de preparación vencido o por vencer dentro de N horas.
   * Ruta estática: va antes de :orderId.
   */
  @Get('due-soon')
  @RequirePermission('stock:read')
  async dueSoon(@Param('sellerId') sellerId: string, @Query('horas') horas?: string) {
    const opId = await this.wms.operationIdOfSeller(sellerId);
    return this.wms.getOrdersDueSoon(opId, { sellerId, withinHours: horas ? Number(horas) : 4, limit: 200 });
  }

  /** Cola de preparación (picking): deadline en riesgo → courier → FIFO. Ruta estática antes de :orderId. */
  @Get('picking-queue')
  @RequirePermission('stock:read')
  pickingQueue(@Param('sellerId') sellerId: string) {
    return this.wms.getPickingQueue(sellerId);
  }

  @Get(':orderId')
  @RequirePermission('stock:read')
  async get(@Param('sellerId') sellerId: string, @Param('orderId') orderId: string) {
    const order = await this.wms.getOrder(sellerId, orderId);
    if (!order) throw new NotFoundException(`Orden no encontrada: ${orderId}`);
    return order;
  }
}
