import { Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Anuncios vistos por los usuarios (barra superior). El anuncio activo lo puede
 * consultar quien tenga `announcement:view` (admin/supervisor + plataforma). Al abrir
 * el enlace se registra el clic con la identidad del usuario (y su operación/cliente).
 */
@Controller('announcements')
export class AnnouncementsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Anuncio activo más reciente para la barra, según la audiencia del espectador. */
  @Get('active')
  @RequirePermission('announcement:view')
  active(@CurrentUser() user: User | null) {
    return this.wms.activeAnnouncement(user?.role);
  }

  /** Registra que el usuario abrió el enlace del anuncio. */
  @Post(':id/click')
  @RequirePermission('announcement:view')
  click(@Param('id') id: string, @CurrentUser() user: User | null) {
    return this.wms.clickAnnouncement(id, user);
  }
}
