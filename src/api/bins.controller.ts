import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User, UserRole } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Bins: contenedores lógicos (pallet, caja, tote, jaula) identificados con un número
 * correlativo. Un Bin NO es una ubicación: se ubica DENTRO de una. Un usuario del portal
 * del cliente ve los Bins donde tiene mercadería, pero solo SUS líneas.
 */
@Controller('bins')
export class BinsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  private scope(user: User | null): string | null {
    return user && String(user.role) === UserRole.CLIENT ? (user.sellerId ?? '__ninguno__') : null;
  }

  @Get('settings')
  @RequirePermission('stock:read')
  settings(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.binSettings(actorOperation(user, operationId));
  }

  @Patch('settings')
  @RequirePermission('master:manage')
  updateSettings(@CurrentUser() user: User | null, @Body() body: any) {
    return this.wms.updateBinSettings(actorOperation(user, body?.operationId), body || {}, actorOf(user));
  }

  @Get()
  @RequirePermission('stock:read')
  list(
    @CurrentUser() user: User | null,
    @Query('operationId') operationId?: string,
    @Query('sellerId') sellerId?: string,
    @Query('estado') estado?: string,
    @Query('ubicacion') ubicacion?: string,
    @Query('sku') sku?: string,
    @Query('q') q?: string,
    @Query('inactivos') inactivos?: string,
  ) {
    return this.wms.listBins(actorOperation(user, operationId), { sellerId: sellerId || null, estado: estado || null, ubicacion: ubicacion || null, sku: sku || null, q: q || null, incluirInactivos: inactivos === '1' || inactivos === 'true' }, this.scope(user));
  }

  @Post()
  @RequirePermission('inventory:putaway')
  create(@CurrentUser() user: User | null, @Body() body: { operationId?: string; cantidad?: number; tipo?: string; ubicacion?: string; receiptId?: string }) {
    return this.wms.createBins(actorOperation(user, body?.operationId), { cantidad: body?.cantidad, tipo: body?.tipo ?? null, ubicacion: body?.ubicacion ?? null, receiptId: body?.receiptId ?? null }, actorOf(user));
  }

  @Post('consolidate')
  @RequirePermission('inventory:putaway')
  consolidate(@CurrentUser() user: User | null, @Body() body: { operationId?: string; origenes: string[]; destino?: string | null; tipo?: string | null; comoTarea?: boolean }) {
    return this.wms.consolidateBins(actorOperation(user, body?.operationId), { origenes: Array.isArray(body?.origenes) ? body.origenes : [], destino: body?.destino ?? null, tipo: body?.tipo ?? null, comoTarea: !!body?.comoTarea }, actorOf(user));
  }

  @Post('transfer')
  @RequirePermission('inventory:putaway')
  transfer(@CurrentUser() user: User | null, @Body() body: { operationId?: string; desde: string; hacia?: string; items?: Array<{ sellerId: string; sku: string; lot?: string | null; qty: number }> }) {
    return this.wms.transferBetweenBins(actorOperation(user, body?.operationId), body.desde, body.hacia || 'nuevo', Array.isArray(body?.items) ? body.items : null, actorOf(user));
  }

  @Get(':ref')
  @RequirePermission('stock:read')
  detail(@CurrentUser() user: User | null, @Param('ref') ref: string, @Query('operationId') operationId?: string) {
    return this.wms.getBinDetail(actorOperation(user, operationId), ref, this.scope(user));
  }

  @Get(':ref/label')
  @RequirePermission('stock:read')
  label(@CurrentUser() user: User | null, @Param('ref') ref: string, @Query('operationId') operationId?: string) {
    return this.wms.binLabel(actorOperation(user, operationId), ref);
  }

  @Get(':ref/suggest')
  @RequirePermission('stock:read')
  suggest(@CurrentUser() user: User | null, @Param('ref') ref: string, @Query('operationId') operationId?: string) {
    return this.wms.suggestBinLocation(actorOperation(user, operationId), ref);
  }

  @Post(':ref/close')
  @RequirePermission('inventory:receive')
  close(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string }) {
    return this.wms.closeBin(actorOperation(user, body?.operationId), ref, actorOf(user));
  }

  @Post(':ref/reopen')
  @RequirePermission('inventory:receive')
  reopen(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string }) {
    return this.wms.reopenBin(actorOperation(user, body?.operationId), ref, actorOf(user));
  }

  /** Putaway del Bin (o ejecución de un traslado pendiente): Bin + ubicación destino. */
  @Post(':ref/putaway')
  @RequirePermission('inventory:putaway')
  putaway(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string; destino: string }) {
    return this.wms.putawayBin(actorOperation(user, body?.operationId), ref, body?.destino, actorOf(user));
  }

  /** Mover un Bin: directo o como tarea asignable (comoTarea). */
  @Post(':ref/move')
  @RequirePermission('inventory:putaway')
  move(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string; destino?: string | null; comoTarea?: boolean; nota?: string | null }) {
    return this.wms.moveBin(actorOperation(user, body?.operationId), ref, { destino: body?.destino ?? null, comoTarea: !!body?.comoTarea, nota: body?.nota ?? null }, actorOf(user));
  }

  @Post(':ref/cancel-pending')
  @RequirePermission('inventory:putaway')
  cancelPending(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string }) {
    return this.wms.cancelBinPending(actorOperation(user, body?.operationId), ref, actorOf(user));
  }

  /** Ejecuta la consolidación pendiente (el operario ya juntó los Bins). */
  @Post(':ref/consolidate-execute')
  @RequirePermission('inventory:putaway')
  consolidateExecute(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string }) {
    return this.wms.executeBinConsolidation(actorOperation(user, body?.operationId), ref, actorOf(user));
  }

  /** Pasa stock suelto de una ubicación al Bin. */
  @Post(':ref/add')
  @RequirePermission('inventory:putaway')
  add(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string; ubicacion: string; items: Array<{ sellerId: string; sku: string; lot?: string | null; qty: number }> }) {
    return this.wms.addLooseToBin(actorOperation(user, body?.operationId), ref, { ubicacion: body?.ubicacion, items: Array.isArray(body?.items) ? body.items : [] }, actorOf(user));
  }

  /** Saca contenido del Bin a stock suelto. */
  @Post(':ref/remove')
  @RequirePermission('inventory:putaway')
  remove(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string; ubicacion?: string | null; items: Array<{ sellerId: string; sku: string; lot?: string | null; qty: number }> }) {
    return this.wms.removeFromBin(actorOperation(user, body?.operationId), ref, { items: Array.isArray(body?.items) ? body.items : [], ubicacion: body?.ubicacion ?? null }, actorOf(user));
  }

  @Post(':ref/unpack')
  @RequirePermission('inventory:putaway')
  unpack(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string; haciaBin?: string | null }) {
    return this.wms.unpackBin(actorOperation(user, body?.operationId), ref, { haciaBin: body?.haciaBin ?? null }, actorOf(user));
  }

  @Post(':ref/count')
  @RequirePermission('count:perform')
  count(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string; lineas: Array<{ sellerId: string; sku: string; lot?: string | null; qty: number }>; motivo?: string | null }) {
    return this.wms.countBin(actorOperation(user, body?.operationId), ref, { lineas: Array.isArray(body?.lineas) ? body.lineas : [], motivo: body?.motivo ?? null }, actorOf(user));
  }

  /** Conteo rápido: confirma que el Bin está en la ubicación escaneada. */
  @Post(':ref/presence')
  @RequirePermission('count:perform')
  presence(@CurrentUser() user: User | null, @Param('ref') ref: string, @Body() body: { operationId?: string; ubicacion: string }) {
    return this.wms.validateBinPresence(actorOperation(user, body?.operationId), ref, body?.ubicacion, actorOf(user));
  }

  @Delete(':ref')
  @RequirePermission('inventory:putaway')
  del(@CurrentUser() user: User | null, @Param('ref') ref: string, @Query('operationId') operationId?: string) {
    return this.wms.deleteBin(actorOperation(user, operationId), ref, actorOf(user));
  }
}
