import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { CurrentUser, actorOf } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';
import { ConsigneeInput } from '../domain/consignee';

/**
 * Libreta de destinatarios frecuentes de un cliente (seller).
 *
 * Va montada bajo `sellers/:sellerId` a propósito: ese parámetro es lo que hace
 * que el guard aplique la frontera de seller, así un usuario CLIENT solo alcanza
 * su propia libreta y el staff de la operación solo la de sus clientes.
 *
 * Permisos: leer con `stock:read` (quien crea órdenes necesita ver la lista);
 * escribir con `product:manage`, que es el permiso de mantenedores del cliente
 * y lo tienen el propio CLIENT, el staff de operación y los administradores.
 */
@Controller('sellers/:sellerId/consignees')
export class ConsigneesController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Get()
  @RequirePermission('stock:read')
  list(@Param('sellerId') sellerId: string, @Query('includeInactive') includeInactive?: string) {
    return this.wms.listConsignees(sellerId, { includeInactive: includeInactive === 'true' });
  }

  @Get(':id')
  @RequirePermission('stock:read')
  get(@Param('sellerId') sellerId: string, @Param('id') id: string) {
    return this.wms.getConsignee(sellerId, id);
  }

  @Post()
  @RequirePermission('product:manage')
  create(@Param('sellerId') sellerId: string, @Body() dto: ConsigneeInput, @CurrentUser() user: User | null) {
    return this.wms.createConsignee(sellerId, dto, actorOf(user));
  }

  @Patch(':id')
  @RequirePermission('product:manage')
  update(@Param('sellerId') sellerId: string, @Param('id') id: string, @Body() dto: ConsigneeInput, @CurrentUser() user: User | null) {
    return this.wms.updateConsignee(sellerId, id, dto, actorOf(user));
  }

  @Delete(':id')
  @RequirePermission('product:manage')
  remove(@Param('sellerId') sellerId: string, @Param('id') id: string, @CurrentUser() user: User | null) {
    return this.wms.deleteConsignee(sellerId, id, actorOf(user));
  }
}
