import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Onboarding y activación (PLG · Fase 2): checklist de puesta en marcha y carga de
 * datos de ejemplo para llevar a la cuenta nueva a despachar su primera orden.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Estado del checklist de la operación (con el paso de verificación resuelto del usuario). */
  @Get()
  @RequirePermission('stock:read')
  async state(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    const op = actorOperation(user, operationId);
    const st = await this.wms.getOnboardingState(op);
    // El paso "verifica tu email" se completa con el usuario actual.
    const verified = user ? user.emailVerified !== false : true;
    const steps = st.steps.map((s) => (s.key === 'verify_email' ? { ...s, done: verified } : s));
    const done = steps.filter((s) => s.done).length;
    return { ...st, steps, done };
  }

  /** Carga datos de ejemplo en la cuenta (solo si está vacía). */
  @Post('sample-data')
  @RequirePermission('master:manage')
  sampleData(@CurrentUser() user: User | null, @Body() body: { operationId?: string }) {
    const op = actorOperation(user, body?.operationId);
    return this.wms.loadSampleData(op, actorOf(user));
  }
}
