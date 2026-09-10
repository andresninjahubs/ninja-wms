import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto';
import { RequirePermission } from './auth/permissions.decorator';
import { actorOf, CurrentUser } from './auth/current-user.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Panel de plataforma (transversal a TODAS las operaciones). El uso exige
 * `operation:manage`; el mantenedor de anuncios exige `announcement:manage`.
 * Ambos son exclusivos del PLATFORM_ADMIN (Ninja Hubs).
 */
@Controller('platform')
export class PlatformController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Nivel de uso por operación + consolidado. `days` = ventana (7/30/90; default 7), o rango ?from&to. */
  @Get('usage')
  @RequirePermission('operation:manage')
  usage(@Query('days') days?: string, @Query('from') from?: string, @Query('to') to?: string) {
    if (from && to) return this.wms.platformUsageRange(from, to);
    return this.wms.platformUsage(Number(days) || 7);
  }

  // ---- Mantenedor de anuncios (barra superior) ----
  @Get('announcements')
  @RequirePermission('announcement:manage')
  listAnnouncements() {
    return this.wms.listAnnouncements();
  }

  @Post('announcements')
  @RequirePermission('announcement:manage')
  createAnnouncement(@Body() dto: CreateAnnouncementDto, @CurrentUser() user: User | null) {
    return this.wms.createAnnouncement(dto, actorOf(user));
  }

  @Patch('announcements/:id')
  @RequirePermission('announcement:manage')
  updateAnnouncement(@Param('id') id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.wms.updateAnnouncement(id, dto);
  }

  @Delete('announcements/:id')
  @RequirePermission('announcement:manage')
  deleteAnnouncement(@Param('id') id: string) {
    return this.wms.deleteAnnouncement(id);
  }

  /** Reporte de clics: qué usuario, de qué operación/cliente y cuándo abrió el anuncio. */
  @Get('announcements/:id/clicks')
  @RequirePermission('announcement:manage')
  announcementClicks(@Param('id') id: string) {
    return this.wms.announcementClicks(id);
  }
}
