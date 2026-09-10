import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { WmsFacade } from '../app/wms.facade';
import { PerformCountDto, PutawayDto, ReceiveDto, ScanCodeDto, ScanInboundDto, ScanPickDto, ScanPutawayDto } from './dto';
import { actorOf, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

// Etiquetas legibles del tipo de movimiento (kardex) para la exportación.
const MOV_LABELS: Record<string, string> = {
  RECEIPT: 'Recepción',
  PUTAWAY: 'Guardado',
  TRANSFER: 'Traslado',
  RESERVE: 'Reserva',
  RELEASE: 'Liberación',
  PICK: 'Picking',
  SHIP: 'Despacho',
  ADJUSTMENT: 'Ajuste',
  RETURN: 'Devolución',
  REACTIVATION: 'Reactivación',
};
const STATE_LABELS: Record<string, string> = {
  AVAILABLE: 'Disponible',
  RESERVED: 'Reservado',
  QUARANTINE: 'Cuarentena',
  DAMAGED: 'Merma',
};

/**
 * Operaciones de inventario, siempre acotadas a un seller vía el path.
 * El guard resuelve el usuario y verifica el permiso; el usuario queda como
 * `actor` de cada movimiento del ledger (auditoría de quién movió el stock).
 */
@Controller('sellers/:sellerId')
export class InventoryController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Recepción de mercadería. */
  @Post('inbounds')
  @RequirePermission('inventory:receive')
  receive(@Param('sellerId') sellerId: string, @Body() dto: ReceiveDto, @CurrentUser() user: User | null) {
    return this.wms.receive(sellerId, {
      sku: dto.sku,
      qty: dto.qty,
      locationId: dto.locationId,
      lot: dto.lot ?? null,
      expiry: dto.expiry ?? null,
      uom: dto.uom,
      reference: dto.reference ?? null,
      actor: actorOf(user),
    });
  }

  /** Guardado dirigido (traslado recepción -> almacenaje). */
  @Post('putaway')
  @RequirePermission('inventory:putaway')
  putaway(@Param('sellerId') sellerId: string, @Body() dto: PutawayDto, @CurrentUser() user: User | null) {
    return this.wms.putaway(sellerId, {
      sku: dto.sku,
      qty: dto.qty,
      fromLocationId: dto.fromLocationId,
      toLocationId: dto.toLocationId,
      lot: dto.lot ?? null,
      uom: dto.uom,
      reference: dto.reference ?? null,
      actor: actorOf(user),
    });
  }

  /** Resolver un código escaneado -> SKU + nivel de empaque + factor. */
  @Get('barcodes/:barcode')
  @RequirePermission('stock:read')
  resolveBarcode(@Param('sellerId') sellerId: string, @Param('barcode') barcode: string) {
    return this.wms.resolveBarcode(sellerId, barcode);
  }

  /** Interpreta un código GS1 (o plano): devuelve SKU + lote + vencimiento + serie. */
  @Post('scan/parse')
  @RequirePermission('inventory:receive')
  parseScan(@Param('sellerId') sellerId: string, @Body() dto: ScanCodeDto) {
    return this.wms.parseScannedCode(sellerId, dto.code);
  }

  /** Recepción por escaneo: traduce packs a unidades base (múltiplos del EAN) e ingresa. */
  @Post('scan/inbound')
  @RequirePermission('inventory:receive')
  scanInbound(@Param('sellerId') sellerId: string, @Body() dto: ScanInboundDto, @CurrentUser() user: User | null) {
    return this.wms.scanInbound(sellerId, {
      barcode: dto.barcode,
      packCount: dto.packCount,
      locationId: dto.locationId,
      locationCode: dto.locationCode,
      lot: dto.lot ?? null,
      expiry: dto.expiry ?? null,
      actor: actorOf(user),
    });
  }

  /** Guardado por escaneo: producto + ubicaciones (con conversión de unidades). */
  @Post('scan/putaway')
  @RequirePermission('inventory:putaway')
  scanPutaway(@Param('sellerId') sellerId: string, @Body() dto: ScanPutawayDto, @CurrentUser() user: User | null) {
    return this.wms.scanPutaway(sellerId, {
      productBarcode: dto.productBarcode,
      packCount: dto.packCount,
      fromLocationCode: dto.fromLocationCode,
      toLocationCode: dto.toLocationCode,
      lot: dto.lot ?? null,
      actor: actorOf(user),
    });
  }

  /** Picking por escaneo: ubicación + producto (con conversión de unidades). */
  @Post('scan/pick')
  @RequirePermission('order:fulfill')
  scanPick(@Param('sellerId') sellerId: string, @Body() dto: ScanPickDto, @CurrentUser() user: User | null) {
    return this.wms.scanPick(sellerId, {
      productBarcode: dto.productBarcode,
      packCount: dto.packCount,
      locationCode: dto.locationCode,
      lot: dto.lot ?? null,
      actor: actorOf(user),
    });
  }

  /** Movimientos del seller (actividad reciente / recepción). */
  @Get('movements')
  @RequirePermission('stock:read')
  movements(@Param('sellerId') sellerId: string, @Query('limit') limit?: string) {
    return this.wms.listMovements(sellerId, limit ? Number(limit) : undefined);
  }

  /** Trazabilidad por número de serie. ?sku= filtra; ?serial= busca uno puntual. */
  @Get('serials')
  @RequirePermission('stock:read')
  async serials(
    @Param('sellerId') sellerId: string,
    @Query('sku') sku?: string,
    @Query('serial') serial?: string,
  ) {
    if (sku && serial) {
      const one = await this.wms.getSerial(sellerId, sku, serial);
      return one ? [one] : [];
    }
    return this.wms.listSerials(sellerId, sku || undefined);
  }

  /** Exporta el kardex de movimientos a Excel (.xlsx). */
  @Get('movements/export')
  @RequirePermission('stock:read')
  async exportMovements(@Param('sellerId') sellerId: string, @Res() res: Response) {
    const movs = await this.wms.listMovements(sellerId, 1_000_000);
    // Resuelve el código legible de cada ubicación (evita mostrar UUIDs).
    const locCode = new Map<string, string>();
    for (const id of new Set(movs.map((m) => m.locationId).filter(Boolean))) {
      const loc = await this.wms.getLocation(id);
      if (loc) locCode.set(id, loc.code);
    }
    const HEADERS = ['Fecha', 'Tipo', 'SKU', 'Ubicación', 'Lote', 'Estado', 'Cantidad (Δ)', 'UdM', 'Referencia', 'Usuario', 'ID movimiento'];
    const rows = [
      HEADERS,
      ...movs.map((m) => [
        m.occurredAt ? new Date(m.occurredAt).toLocaleString('es-CL') : '',
        MOV_LABELS[m.type] || m.type,
        m.sku,
        locCode.get(m.locationId) || m.locationId,
        m.lot || '',
        STATE_LABELS[m.state] || m.state,
        m.qtyDelta,
        m.uom,
        m.reference || '',
        m.actor || '',
        m.id,
      ]),
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 24 }, { wch: 18 }, { wch: 26 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Kardex');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="kardex-movimientos-ninjawms.xlsx"');
    res.send(buf);
  }

  /** Métricas operativas del dashboard (24h/7d/30d/90d, o rango ?from&to con comparativo vs período previo). */
  @Get('metrics')
  @RequirePermission('stock:read')
  metrics(@Param('sellerId') sellerId: string, @Query('from') from?: string, @Query('to') to?: string) {
    if (from && to) return this.wms.dashboardMetricsRange(sellerId, from, to);
    return this.wms.dashboardMetrics(sellerId);
  }

  /** Consulta de stock del seller (opcionalmente filtrada por SKU o ubicación). */
  @Get('inventory')
  @RequirePermission('stock:read')
  getStock(
    @Param('sellerId') sellerId: string,
    @Query('sku') sku?: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.wms.getStock({ sellerId, sku, locationId });
  }

  /** Sugerencia de guardado dirigido (motor caótico): dónde guardar `qty` de `sku`. */
  @Get('putaway-suggestions')
  @RequirePermission('inventory:putaway')
  suggestPutaway(
    @Param('sellerId') sellerId: string,
    @Query('sku') sku: string,
    @Query('qty') qty: string,
  ) {
    return this.wms.suggestPutaway(sellerId, { sku, qty: Number(qty) });
  }

  /** Plan de conteo cíclico del día, según la estrategia del seller. */
  @Get('cycle-counts/plan')
  @RequirePermission('stock:read')
  planCounts(@Param('sellerId') sellerId: string) {
    return this.wms.planCounts(sellerId);
  }

  /** Ejecuta un conteo en una ubicación y reconcilia el ledger. */
  @Post('cycle-counts')
  @RequirePermission('count:perform')
  performCount(@Param('sellerId') sellerId: string, @Body() dto: PerformCountDto, @CurrentUser() user: User | null) {
    return this.wms.performCount(
      sellerId,
      dto.locationId,
      dto.counted.map((c) => ({ sku: c.sku, lot: c.lot ?? null, countedQty: c.countedQty })),
      actorOf(user),
    );
  }
}
