import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import {
  CreatePackagingDto,
  PackagingSellerPriceDto,
  PackagingStockDto,
  UpdatePackagingDto,
} from './dto';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Insumos de embalaje (packaging) — catálogo y stock a nivel OPERACIÓN (bodega).
 * Se consumen al empacar y se cobran al seller. El catálogo es compartido entre
 * clientes; el precio por defecto admite override por seller.
 */
@Controller('packaging')
export class PackagingController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Catálogo con saldo (onHand) por insumo. */
  @Get()
  @RequirePermission('stock:read')
  list(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.listPackaging(actorOperation(user, operationId));
  }

  /** Movimientos del ledger de embalaje (?materialSku, ?sellerId). */
  @Get('movements')
  @RequirePermission('stock:read')
  movements(
    @CurrentUser() user: User | null,
    @Query('operationId') operationId?: string,
    @Query('materialSku') materialSku?: string,
    @Query('sellerId') sellerId?: string,
  ) {
    return this.wms.listPackagingMovements(actorOperation(user, operationId), {
      materialSku: materialSku || undefined,
      sellerId: sellerId || undefined,
    });
  }

  @Post()
  @RequirePermission('product:manage')
  create(@Body() dto: CreatePackagingDto, @CurrentUser() user: User | null) {
    return this.wms.createPackaging(actorOperation(user, dto.operationId), {
      sku: dto.sku,
      name: dto.name,
      barcode: dto.barcode ?? null,
      unitPrice: dto.unitPrice,
      active: dto.active,
    });
  }

  @Patch(':sku')
  @RequirePermission('product:manage')
  update(@Param('sku') sku: string, @Body() dto: UpdatePackagingDto, @CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.updatePackaging(actorOperation(user, operationId), sku, {
      name: dto.name,
      barcode: dto.barcode,
      unitPrice: dto.unitPrice,
      active: dto.active,
    });
  }

  /** Define/actualiza (o borra, con price null) el precio custom de un seller. */
  @Post(':sku/seller-price')
  @RequirePermission('product:manage')
  sellerPrice(@Param('sku') sku: string, @Body() dto: PackagingSellerPriceDto, @CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.setPackagingSellerPrice(actorOperation(user, operationId), sku, dto.sellerId, dto.price ?? null);
  }

  /** Ingreso de stock de un insumo (+). */
  @Post(':sku/receive')
  @RequirePermission('inventory:receive')
  receive(@Param('sku') sku: string, @Body() dto: PackagingStockDto, @CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.receivePackagingStock(actorOperation(user, operationId), sku, dto.qty, actorOf(user));
  }

  /** Ajuste manual del stock de un insumo (+/−). */
  @Post(':sku/adjust')
  @RequirePermission('inventory:receive')
  adjust(@Param('sku') sku: string, @Body() dto: PackagingStockDto, @CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.adjustPackagingStock(actorOperation(user, operationId), sku, dto.qty, actorOf(user));
  }
}
