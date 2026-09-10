import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: 'ninjahubs-wms', version: '0.1.0' };
  }

  /**
   * Configuración de UI del panel (pública, sin auth): módulos del menú que se ocultan
   * en esta versión. Se controla con la env HIDDEN_MODULES (lista separada por comas con
   * los ids de sección del panel: voz, costos, plan, aiaudit, asignaciones, agente, ...).
   * HIDDEN_MODULES="" (vacío) muestra todo. Si no está definida, aplica el default de la versión.
   * HIDDEN_MODULES_FOR_PLATFORM=true oculta también para el super-admin de plataforma (default: no).
   */
  @Get('ui-config')
  uiConfig() {
    const raw = process.env.HIDDEN_MODULES;
    const defaults = ['voz', 'costos', 'plan', 'aiaudit', 'asignaciones', 'agente'];
    const hidden = raw == null ? defaults : raw.split(',').map((s) => s.trim()).filter(Boolean);
    return { hiddenModules: hidden, hideForPlatformAdmin: process.env.HIDDEN_MODULES_FOR_PLATFORM === 'true' };
  }
}
