import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { PlanConfigDto, PlanDto } from './dto';
import { actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { ROLE_PERMISSIONS, User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * ¿Este usuario puede ver cuánto cuesta un plan?
 *
 * Solo la plataforma (Ninja Hubs). El administrador de un 3PL y el usuario de un
 * seller ven qué incluye su plan y cuánto están usando; la tarifa la conversan con
 * comercial, no la leen en una pantalla. Sin usuario (modo demo sin auth) se asume
 * plataforma, que es el comportamiento que ya tenía el resto del panel.
 */
function puedeVerPrecios(user: User | null): boolean {
  if (!user) return true;
  return ROLE_PERMISSIONS[user.role]?.includes('operation:manage') ?? false;
}

/**
 * Plan del SaaS (PLG · Fase 1): estado del plan de la operación, catálogo público
 * y grant manual por el super-admin (aún sin pagos).
 */
@Controller('plan')
export class PlanController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Estado del plan de la operación del usuario: plan efectivo, prueba y uso vs límite. */
  @Get()
  @RequirePermission('stock:read')
  state(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    const op = actorOperation(user, operationId);
    return this.wms.getPlanState(op, puedeVerPrecios(user));
  }

  /**
   * Catálogo de planes (para el comparador). Los precios solo viajan a la plataforma;
   * los demás reciben el mismo catálogo sin tarifas.
   */
  @Get('catalog')
  @RequirePermission('stock:read')
  async catalog(@CurrentUser() user: User | null) {
    return { plans: await this.wms.planCatalog(puedeVerPrecios(user)) };
  }

  /** Cambia el plan de una operación (grant manual del super-admin). */
  @Put()
  @RequirePermission('operation:manage')
  setPlan(@Body() dto: PlanDto, @CurrentUser() user: User | null) {
    const op = actorOperation(user, dto.operationId);
    return this.wms.setOperationPlan(op, dto.planId);
  }

  // ---- Mantenedor de empaquetado (matriz módulo × plan; solo plataforma) ----

  /** Matriz de empaquetado: planes efectivos, módulos, límites y cuentas por plan. */
  @Get('admin/matrix')
  @RequirePermission('operation:manage')
  matrix() {
    return this.wms.getPackagingMatrix();
  }

  /** Actualiza la config de un plan (módulos, límites, nombre y precio). */
  @Put('admin/:planId')
  @RequirePermission('operation:manage')
  updatePlan(@Param('planId') planId: string, @Body() dto: PlanConfigDto) {
    return this.wms.updatePlanConfig(planId, {
      name: dto.name, prices: dto.prices, blurb: dto.blurb, limits: dto.limits, features: dto.features,
    });
  }

  /** Restaura toda la matriz a los valores por defecto del código. */
  @Post('admin/reset')
  @RequirePermission('operation:manage')
  reset() {
    return this.wms.resetPackaging();
  }
}
