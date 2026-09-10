import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { CreateReturnDto, ProcessReturnDto } from './dto';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Devoluciones (logística reversa), scoped al seller.
 *   POST /sellers/:sellerId/returns              -> crea una devolución enlazada a la orden original
 *   GET  /sellers/:sellerId/returns              -> lista
 *   GET  /sellers/:sellerId/returns/:id          -> detalle
 *   POST /sellers/:sellerId/returns/:id/process  -> QA: dispone a stock/merma/cuarentena
 *   POST /sellers/:sellerId/returns/:id/cancel   -> anula (si no tiene unidades ingresadas)
 *
 * Usa el permiso 'inventory:receive' (las devoluciones son un flujo de entrada).
 */
@Controller('sellers/:sellerId/returns')
export class ReturnsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Post()
  @RequirePermission('inventory:receive')
  create(
    @Param('sellerId') sellerId: string,
    @Body() dto: CreateReturnDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.createReturn(
      sellerId,
      { originalOrderRef: dto.originalOrderRef, reason: dto.reason ?? null },
      actorOf(user),
    );
  }

  @Get()
  @RequirePermission('stock:read')
  list(@Param('sellerId') sellerId: string) {
    return this.wms.listReturns(sellerId);
  }

  @Get(':returnId')
  @RequirePermission('stock:read')
  get(@Param('sellerId') sellerId: string, @Param('returnId') returnId: string) {
    return this.wms.getReturn(sellerId, returnId);
  }

  @Post(':returnId/process')
  @RequirePermission('inventory:receive')
  process(
    @Param('sellerId') sellerId: string,
    @Param('returnId') returnId: string,
    @Body() dto: ProcessReturnDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.processReturn(
      sellerId,
      returnId,
      { lines: dto.lines, close: dto.close },
      actorOf(user),
    );
  }

  @Post(':returnId/cancel')
  @RequirePermission('inventory:receive')
  cancel(
    @Param('sellerId') sellerId: string,
    @Param('returnId') returnId: string,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.cancelReturn(sellerId, returnId, actorOf(user));
  }
}
