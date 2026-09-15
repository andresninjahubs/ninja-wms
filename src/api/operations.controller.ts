import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { CreateOperationDto, DeadlineConfigDto, UpdateBrandingDto, UpdateOperationDto } from './dto';
import { RequirePermission } from './auth/permissions.decorator';
import { actorOf, CurrentUser } from './auth/current-user.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Operaciones = el tenant de más alto nivel. Solo el PLATFORM_ADMIN (Ninja Hubs)
 * las crea y las lista; cada operación es un mundo aislado.
 */
@Controller('operations')
export class OperationsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Post()
  @RequirePermission('operation:manage')
  create(@Body() dto: CreateOperationDto) {
    return this.wms.createOperation({ id: dto.id, name: dto.name });
  }

  @Get()
  @RequirePermission('operation:manage')
  list() {
    return this.wms.listOperations();
  }

  /** Editar nombre / activar-desactivar una operación (solo plataforma). */
  @Patch(':operationId')
  @RequirePermission('operation:manage')
  update(@Param('operationId') operationId: string, @Body() dto: UpdateOperationDto) {
    return this.wms.updateOperation(operationId, { name: dto.name, active: dto.active });
  }

  /** Marca (white-label) de la operación — la leen todos sus usuarios (incluye clientes). */
  @Get(':operationId/branding')
  @RequirePermission('stock:read')
  getBranding(@Param('operationId') operationId: string) {
    return this.wms.getOperationBranding(operationId);
  }

  /** Configura la marca de la operación. Solo el admin de la operación (master:manage). */
  @Patch(':operationId/branding')
  @RequirePermission('master:manage')
  setBranding(@Param('operationId') operationId: string, @Body() dto: UpdateBrandingDto) {
    return this.wms.setOperationBranding(operationId, {
      companyName: dto.companyName,
      legalName: dto.legalName,
      taxId: dto.taxId,
      address: dto.address,
      email: dto.email,
      phone: dto.phone,
      website: dto.website,
      primaryColor: dto.primaryColor,
      logoDataUri: dto.logoDataUri,
    });
  }

  /** Clientes (sellers) de una operación. */
  /**
   * Deadlines de preparación de la operación: horas de corte por courier, ventana de
   * riesgo y desfase horario de la bodega. Lo administra el administrador de la operación.
   */
  @Get(':operationId/deadline-config')
  @RequirePermission('stock:read')
  getDeadlineConfig(@Param('operationId') operationId: string) {
    return this.wms.getDeadlineConfig(operationId);
  }

  @Patch(':operationId/deadline-config')
  @RequirePermission('master:manage')
  setDeadlineConfig(@Param('operationId') operationId: string, @Body() dto: DeadlineConfigDto) {
    return this.wms.setDeadlineConfig(operationId, {
      offsetHoras: dto.offsetHoras,
      riesgoHoras: dto.riesgoHoras,
      cortes: (dto.cortes || []).map((c) => ({ courier: c.courier, hora: c.hora, dias: c.dias })),
    });
  }

  /** Órdenes de toda la operación con el deadline vencido o por vencer. */
  @Get(':operationId/orders-due-soon')
  @RequirePermission('stock:read')
  ordersDueSoon(@Param('operationId') operationId: string, @Query('horas') horas?: string, @Query('sellerId') sellerId?: string) {
    return this.wms.getOrdersDueSoon(operationId, { sellerId: sellerId || null, withinHours: horas ? Number(horas) : 4, limit: 200 });
  }

  /**
   * Siembra un sandbox de demostración del agente en esta operación (cliente de
   * juguete con productos, ubicaciones, stock, 20 órdenes con deadlines variados
   * y tareas pendientes de todos los tipos). Solo el administrador de la operación.
   */
  @Post(':operationId/demo-sandbox')
  @RequirePermission('master:manage')
  seedDemoSandbox(@Param('operationId') operationId: string, @CurrentUser() user: User | null) {
    return this.wms.seedAgentSandbox(operationId, actorOf(user));
  }

  /**
   * Panel de control consolidado: toda la operación (o un cliente como filtro),
   * en una sola llamada. La pantalla se refresca sola, así que conviene un
   * request por refresco y no catorce.
   */
  @Get(':operationId/dashboard')
  @RequirePermission('stock:read')
  dashboard(
    @Param('operationId') operationId: string,
    @Query('sellerId') sellerId?: string,
    @Query('window') window?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const w = ['24h', '7d', '30d', '90d'].includes(String(window)) ? (window as any) : '24h';
    return this.wms.operationDashboard(operationId, { sellerId: sellerId || null, window: w, from: from || null, to: to || null });
  }

  @Get(':operationId/sellers')
  @RequirePermission('stock:read')
  sellers(@Param('operationId') operationId: string) {
    return this.wms.listSellers(operationId);
  }

  /** Exactitud de inventario (KPI G8): valor global y tendencia por conteo. */
  @Get(':operationId/inventory-accuracy')
  @RequirePermission('stock:read')
  inventoryAccuracy(@Param('operationId') operationId: string, @Query('sellerId') sellerId?: string, @Query('limit') limit?: string) {
    const lim = limit ? parseInt(limit, 10) : undefined;
    return this.wms.getInventoryAccuracy(operationId, { sellerId: sellerId || null, limit: lim && !Number.isNaN(lim) ? lim : undefined });
  }

  /** Ubicaciones de una operación. */
  @Get(':operationId/locations')
  @RequirePermission('stock:read')
  locations(@Param('operationId') operationId: string) {
    return this.wms.listLocations(operationId);
  }

  /** Dashboard de facturación 3PL de la operación (consolidado + por cliente + por concepto). */
  @Get(':operationId/billing/dashboard')
  @RequirePermission('billing:manage')
  billingDashboard(@Param('operationId') operationId: string) {
    return this.wms.billingDashboard(operationId);
  }

  /** Bandeja de chats de la operación: qué cliente y usuario está hablando, y no leídos. */
  @Get(':operationId/chat')
  @RequirePermission('chat:manage')
  chatInbox(@Param('operationId') operationId: string) {
    return this.wms.chatSummary(operationId);
  }
}
