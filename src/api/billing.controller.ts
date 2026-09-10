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
} from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { AttachTaxDocDto, GenerateInvoiceDto, SendInvoiceDto, SetRateDto, UpdateInvoiceDto } from './dto';
import { actorOf, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { sendInvoiceEmail } from '../infra/mailer';
import { WMS_FACADE } from './tokens';
import { Delete } from '@nestjs/common';

/**
 * Facturación 3PL por cliente. El tarifario y la generación de facturas son del staff
 * de operación (`billing:manage`); el cliente puede consultar (leer) sus facturas.
 */
@Controller('sellers/:sellerId/billing')
export class BillingController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Get('rate')
  @RequirePermission('stock:read')
  getRate(@Param('sellerId') sellerId: string) {
    return this.wms.getBillingRate(sellerId);
  }

  @Patch('rate')
  @RequirePermission('billing:manage')
  setRate(@Param('sellerId') sellerId: string, @Body() dto: SetRateDto) {
    return this.wms.setBillingRate(sellerId, dto);
  }

  /** Vista previa (sin persistir) de la factura de un mes. */
  @Get('preview')
  @RequirePermission('billing:manage')
  preview(@Param('sellerId') sellerId: string, @Query('year') year: string, @Query('month') month: string) {
    return this.wms.previewInvoice(sellerId, Number(year), Number(month));
  }

  @Get('invoices')
  @RequirePermission('stock:read')
  listInvoices(@Param('sellerId') sellerId: string) {
    return this.wms.listInvoices(sellerId);
  }

  @Post('invoices')
  @RequirePermission('billing:manage')
  generate(@Param('sellerId') sellerId: string, @Body() dto: GenerateInvoiceDto, @CurrentUser() user: User | null) {
    return this.wms.generateInvoice(sellerId, dto.year, dto.month, actorOf(user));
  }

  @Get('invoices/:id')
  @RequirePermission('stock:read')
  async getInvoice(@Param('sellerId') sellerId: string, @Param('id') id: string) {
    const inv = await this.wms.getInvoice(sellerId, id);
    if (!inv) throw new NotFoundException(`Factura no encontrada: ${id}`);
    return inv;
  }

  /** Edita una factura emitida: número, cantidades y/o conceptos adicionales. */
  @Patch('invoices/:id')
  @RequirePermission('billing:manage')
  updateInvoice(@Param('sellerId') sellerId: string, @Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.wms.updateInvoice(sellerId, id, {
      number: dto.number,
      lines: dto.lines?.map((l) => ({ concept: l.concept, unit: l.unit, qty: l.qty, rate: l.rate })),
    });
  }

  @Delete('invoices/:id')
  @RequirePermission('billing:manage')
  deleteInvoice(@Param('sellerId') sellerId: string, @Param('id') id: string) {
    return this.wms.deleteInvoice(sellerId, id);
  }

  /**
   * Adjunta el documento tributario (la factura real en PDF u otro archivo) a una
   * factura. Con `markInvoiced:true` además la deja en estado Facturado. Solo staff.
   */
  @Post('invoices/:id/tax-document')
  @RequirePermission('billing:manage')
  attachTaxDocument(
    @Param('sellerId') sellerId: string,
    @Param('id') id: string,
    @Body() dto: AttachTaxDocDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.attachInvoiceTaxDocument(
      sellerId,
      id,
      { fileName: dto.fileName, mimeType: dto.mimeType, contentBase64: dto.contentBase64, markInvoiced: dto.markInvoiced },
      actorOf(user),
    );
  }

  /** Marca la factura como Facturado (requiere documento tributario adjunto). */
  @Post('invoices/:id/mark-invoiced')
  @RequirePermission('billing:manage')
  markInvoiced(@Param('sellerId') sellerId: string, @Param('id') id: string) {
    return this.wms.markInvoiceInvoiced(sellerId, id);
  }

  /** Quita el documento tributario y la marca de Facturado (vuelve a Pre-factura). */
  @Delete('invoices/:id/tax-document')
  @RequirePermission('billing:manage')
  removeTaxDocument(@Param('sellerId') sellerId: string, @Param('id') id: string) {
    return this.wms.removeInvoiceTaxDocument(sellerId, id);
  }

  /** Descarga el documento tributario de una factura. El cliente puede ver el suyo (stock:read). */
  @Get('invoices/:id/tax-document')
  @RequirePermission('stock:read')
  async getTaxDocument(@Param('sellerId') sellerId: string, @Param('id') id: string) {
    const inv = await this.wms.getInvoice(sellerId, id);
    if (!inv) throw new NotFoundException(`Factura no encontrada: ${id}`);
    if (!inv.taxDocument) throw new NotFoundException('Esta factura no tiene documento tributario adjunto');
    const blob = await this.wms.getInvoiceTaxDocument(sellerId, id);
    if (!blob) throw new NotFoundException('El documento tributario no está disponible');
    return { fileName: blob.fileName, mimeType: blob.mimeType, size: inv.taxDocument.size, contentBase64: blob.contentBase64 };
  }

  /** El cliente aprueba su factura desde su portal (queda fecha, hora y usuario). */
  @Post('invoices/:id/approve')
  @RequirePermission('billing:approve')
  approve(@Param('sellerId') sellerId: string, @Param('id') id: string, @CurrentUser() user: User | null) {
    return this.wms.approveInvoice(sellerId, id, actorOf(user));
  }

  /** Envía la factura por correo. Registra el envío; entrega real requiere SMTP (SMTP_URL). */
  @Post('invoices/:id/send')
  @RequirePermission('billing:manage')
  async send(
    @Param('sellerId') sellerId: string,
    @Param('id') id: string,
    @Body() dto: SendInvoiceDto,
    @CurrentUser() user: User | null,
  ) {
    const inv = await this.wms.getInvoice(sellerId, id);
    if (!inv) throw new NotFoundException(`Factura no encontrada: ${id}`);
    const seller = await this.wms.getSeller(sellerId);
    const result = await sendInvoiceEmail({ to: dto.to, invoice: inv, sellerName: seller?.name || sellerId });
    const updated = await this.wms.recordInvoiceSend(sellerId, id, dto.to, result.delivered, actorOf(user));
    return { delivered: result.delivered, reason: result.reason ?? null, to: dto.to, invoice: updated };
  }
}
