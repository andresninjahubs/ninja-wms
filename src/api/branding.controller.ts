import { Controller, Get } from '@nestjs/common';

/**
 * Branding / white-label.
 *
 * Endpoint PÚBLICO (sin @RequirePermission) que expone la configuración de
 * marca del deployment. El panel de administración (webadmin) lo consume para
 * pintar el nombre de la app, el color primario y la URL del logo.
 *
 * White-label SIN tocar código: cada deployment ajusta la marca por variables
 * de entorno y, opcionalmente, reemplazando el archivo del logo servido en
 * `/brand/logo.svg`.
 *
 *   BRAND_APP_NAME       Nombre visible de la app        (def. "Ninja WMS")
 *   BRAND_PRIMARY_COLOR  Color primario del tema (hex)   (def. "#0E9F6E")
 *   BRAND_LOGO_URL       URL del logo servido            (def. "/brand/logo.svg")
 */
@Controller('branding')
export class BrandingController {
  @Get()
  branding() {
    return {
      appName: process.env.BRAND_APP_NAME ?? 'Ninja WMS',
      primaryColor: process.env.BRAND_PRIMARY_COLOR ?? '#0E9F6E',
      logoUrl: process.env.BRAND_LOGO_URL ?? '/brand/logo.svg',
    };
  }
}
