import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { AssembleKitDto, CreateProductDto, UpdateProductDto } from './dto';
import { actorOf, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Mantenedor de productos (SKUs + kits) del seller. Accesible por el cliente
 * (acotado a su seller) y por el staff de operación — permiso `product:manage`.
 */
@Controller('sellers/:sellerId/products')
export class ProductsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Get()
  @RequirePermission('stock:read')
  list(@Param('sellerId') sellerId: string) {
    return this.wms.listSkus(sellerId);
  }

  @Post()
  @RequirePermission('product:manage')
  create(@Param('sellerId') sellerId: string, @Body() dto: CreateProductDto, @CurrentUser() user: User | null) {
    return this.wms.createProduct(
      sellerId,
      {
        sku: dto.sku,
        description: dto.description,
        barcode: dto.barcode ?? null,
        lotControlled: dto.lotControlled,
        serialControlled: dto.serialControlled,
        expiryControlled: dto.expiryControlled,
        rotationClass: dto.rotationClass,
        active: dto.active,
        isKit: dto.isKit,
        kitMode: dto.kitMode ?? null,
        components: dto.components?.map((c) => ({ sku: c.sku, qty: c.qty })),
      },
      actorOf(user),
    );
  }

  @Patch(':sku')
  @RequirePermission('product:manage')
  update(
    @Param('sellerId') sellerId: string,
    @Param('sku') sku: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.updateProduct(
      sellerId,
      sku,
      {
        description: dto.description,
        barcode: dto.barcode !== undefined ? dto.barcode : undefined,
        lotControlled: dto.lotControlled,
        serialControlled: dto.serialControlled,
        expiryControlled: dto.expiryControlled,
        rotationClass: dto.rotationClass,
        active: dto.active,
        isKit: dto.isKit,
        kitMode: dto.kitMode !== undefined ? dto.kitMode : undefined,
        components: dto.components?.map((c) => ({ sku: c.sku, qty: c.qty })),
      },
      actorOf(user),
    );
  }

  /**
   * Armar un kit ASSEMBLED: el usuario elige de qué ubicación sale cada componente
   * (`sources`). Consume esas extracciones y produce stock del kit. Operación de bodega
   * — requiere el permiso de guardado (staff de operación).
   */
  @Post(':sku/assemble')
  @RequirePermission('inventory:putaway')
  assemble(
    @Param('sellerId') sellerId: string,
    @Param('sku') sku: string,
    @Body() dto: AssembleKitDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.assembleKit(
      sellerId,
      {
        kitSku: sku,
        qty: dto.qty,
        toLocationId: dto.toLocationId,
        sources: dto.sources.map((s) => ({ sku: s.sku, locationId: s.locationId, lot: s.lot ?? null, qty: s.qty })),
      },
      actorOf(user),
    );
  }

  /** Historial auditable de armados de kit del seller. */
  @Get('assemblies')
  @RequirePermission('stock:read')
  assemblies(@Param('sellerId') sellerId: string) {
    return this.wms.listAssemblies(sellerId);
  }

  /** Historial de cambios de todos los productos del seller. */
  @Get('log')
  @RequirePermission('stock:read')
  log(@Param('sellerId') sellerId: string) {
    return this.wms.listProductLog(sellerId);
  }

  /** Historial de cambios de un producto específico. */
  @Get(':sku/log')
  @RequirePermission('stock:read')
  logForSku(@Param('sellerId') sellerId: string, @Param('sku') sku: string) {
    return this.wms.listProductLog(sellerId, sku);
  }

  @Get(':sku')
  @RequirePermission('stock:read')
  async get(@Param('sellerId') sellerId: string, @Param('sku') sku: string) {
    const p = await this.wms.getProduct(sellerId, sku);
    if (!p) throw new NotFoundException(`Producto no encontrado: ${sku}`);
    return p;
  }
}
