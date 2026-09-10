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
import { CreateSellerDto, CreateSkuDto, RegisterPackDto, UpdateSellerDto, UpdateSellerPolicyDto } from './dto';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

@Controller('sellers')
export class SellersController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Post()
  @RequirePermission('master:manage')
  createSeller(@Body() dto: CreateSellerDto, @CurrentUser() user: User | null) {
    return this.wms.createSeller({
      id: dto.id,
      operationId: actorOperation(user, dto.operationId),
      name: dto.name,
      pickingStrategy: dto.pickingStrategy,
      cycleCountStrategy: dto.cycleCountStrategy,
      consolidateByLocation: dto.consolidateByLocation,
      courierPriority: dto.courierPriority,
      autoAllocateOnIngest: dto.autoAllocateOnIngest,
    });
  }

  /** Configura la política operativa del seller (estrategias de picking y conteo). */
  @Patch(':sellerId/policy')
  @RequirePermission('seller:config')
  updatePolicy(@Param('sellerId') sellerId: string, @Body() dto: UpdateSellerPolicyDto) {
    return this.wms.updateSellerPolicy(sellerId, {
      pickingStrategy: dto.pickingStrategy,
      cycleCountStrategy: dto.cycleCountStrategy,
      consolidateByLocation: dto.consolidateByLocation,
      courierPriority: dto.courierPriority,
      autoAllocateOnIngest: dto.autoAllocateOnIngest,
    });
  }

  /** Mantenedor de clientes: editar nombre, estrategias y activar/desactivar. */
  @Patch(':sellerId')
  @RequirePermission('master:manage')
  updateSeller(
    @Param('sellerId') sellerId: string,
    @Body() dto: UpdateSellerDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.updateSeller(
      sellerId,
      {
        name: dto.name,
        pickingStrategy: dto.pickingStrategy,
        cycleCountStrategy: dto.cycleCountStrategy,
        consolidateByLocation: dto.consolidateByLocation,
        courierPriority: dto.courierPriority,
        autoAllocateOnIngest: dto.autoAllocateOnIngest,
        active: dto.active,
      },
      user,
    );
  }

  @Get(':sellerId')
  @RequirePermission('stock:read')
  async getSeller(@Param('sellerId') sellerId: string) {
    const seller = await this.wms.getSeller(sellerId);
    if (!seller) throw new NotFoundException(`Seller no encontrado: ${sellerId}`);
    return seller;
  }

  /** Maestro de SKUs del seller (para poblar el formulario de recepción, etc.). */
  @Get(':sellerId/skus')
  @RequirePermission('stock:read')
  listSkus(@Param('sellerId') sellerId: string) {
    return this.wms.listSkus(sellerId);
  }

  @Post(':sellerId/skus')
  @RequirePermission('product:manage')
  createSku(@Param('sellerId') sellerId: string, @Body() dto: CreateSkuDto, @CurrentUser() user: User | null) {
    return this.wms.createSku(sellerId, {
      sku: dto.sku,
      description: dto.description,
      barcode: dto.barcode ?? null,
      lotControlled: dto.lotControlled,
      rotationClass: dto.rotationClass,
    }, actorOf(user));
  }

  /** Registra un nivel de empaque del SKU (unidad/caja/pallet) con su código de barras. */
  @Post(':sellerId/skus/:sku/packs')
  @RequirePermission('product:manage')
  registerPack(
    @Param('sellerId') sellerId: string,
    @Param('sku') sku: string,
    @Body() dto: RegisterPackDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.registerPack(sellerId, {
      sku,
      code: dto.code,
      barcode: dto.barcode,
      factor: dto.factor,
      label: dto.label,
    }, actorOf(user));
  }

  /** Lista los niveles de empaque del SKU con sus códigos y factores. */
  @Get(':sellerId/skus/:sku/packs')
  @RequirePermission('stock:read')
  listPacks(@Param('sellerId') sellerId: string, @Param('sku') sku: string) {
    return this.wms.listPacks(sellerId, sku);
  }
}
