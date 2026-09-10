import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { CreateReceiptDto, ReceiveCountsDto } from './dto';
import { actorOf, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Órdenes de recepción (inbound). Un ingreso de mercadería con ID propio y varias
 * líneas (SKUs), imprimible como manifiesto. Editable/eliminable mientras el stock
 * siga íntegro en recepción.
 */
@Controller('sellers/:sellerId/receipts')
export class ReceiptsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Post()
  @RequirePermission('inventory:receive')
  create(
    @Param('sellerId') sellerId: string,
    @Body() dto: CreateReceiptDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.createReceipt(
      sellerId,
      {
        supplier: dto.supplier ?? null,
        reference: dto.reference ?? null,
        locationId: dto.locationId ?? null,
        notes: dto.notes ?? null,
        lines: dto.lines.map((l) => ({ sku: l.sku, qty: l.qty, uom: l.uom, lot: l.lot ?? null, expiry: l.expiry ?? null })),
      },
      actorOf(user),
    );
  }

  @Get()
  @RequirePermission('stock:read')
  list(@Param('sellerId') sellerId: string) {
    return this.wms.listReceipts(sellerId);
  }

  @Get(':orderId')
  @RequirePermission('stock:read')
  async get(@Param('sellerId') sellerId: string, @Param('orderId') orderId: string) {
    const order = await this.wms.getReceipt(sellerId, orderId);
    if (!order) throw new NotFoundException(`Orden de recepción no encontrada: ${orderId}`);
    return order;
  }

  @Patch(':orderId')
  @RequirePermission('inventory:receive')
  update(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @Body() dto: CreateReceiptDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.updateReceipt(
      sellerId,
      orderId,
      {
        supplier: dto.supplier ?? null,
        reference: dto.reference ?? null,
        locationId: dto.locationId ?? null,
        notes: dto.notes ?? null,
        lines: dto.lines.map((l) => ({ sku: l.sku, qty: l.qty, uom: l.uom, lot: l.lot ?? null, expiry: l.expiry ?? null })),
      },
      actorOf(user),
    );
  }

  /** Cotejo / recepción física: registra lo recibido por línea (postea el stock contado). */
  @Post(':orderId/receive')
  @RequirePermission('inventory:receive')
  receive(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @Body() dto: ReceiveCountsDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.receiveReceipt(
      sellerId,
      orderId,
      dto.counts.map((c) => ({ lineNo: c.lineNo, qty: c.qty, lot: c.lot ?? null, expiry: c.expiry ?? null, serials: c.serials ?? [] })),
      actorOf(user),
    );
  }

  /** Cierra la orden como recibida aunque falte mercadería (parcial). */
  @Post(':orderId/close')
  @RequirePermission('inventory:receive')
  close(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.closeReceipt(sellerId, orderId, actorOf(user));
  }

  @Delete(':orderId')
  @RequirePermission('inventory:receive')
  remove(
    @Param('sellerId') sellerId: string,
    @Param('orderId') orderId: string,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.deleteReceipt(sellerId, orderId, actorOf(user));
  }
}
