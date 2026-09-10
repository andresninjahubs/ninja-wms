import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { CreateWebhookDto, UpdateWebhookDto } from './dto';
import { CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { UnauthorizedError } from '../domain/errors';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Suscripciones de webhook del alcance del usuario (CLIENT→seller, ADMIN/SUP→operación,
 * PLATFORM→global). Como /webhooks no lleva params de scope, la autorización de
 * pertenencia la resuelve el servicio a partir del usuario autenticado.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  private must(user: User | null): User {
    if (!user) throw new UnauthorizedError('Se requiere un usuario autenticado para gestionar webhooks');
    return user;
  }

  @Get()
  @RequirePermission('webhook:manage')
  list(@CurrentUser() user: User | null) {
    return this.wms.listWebhooks(this.must(user));
  }

  @Post()
  @RequirePermission('webhook:manage')
  create(@Body() dto: CreateWebhookDto, @CurrentUser() user: User | null) {
    return this.wms.createWebhook(this.must(user), { url: dto.url, events: dto.events });
  }

  @Patch(':id')
  @RequirePermission('webhook:manage')
  update(@Param('id') id: string, @Body() dto: UpdateWebhookDto, @CurrentUser() user: User | null) {
    return this.wms.updateWebhook(this.must(user), id, { url: dto.url, events: dto.events, active: dto.active });
  }

  @Delete(':id')
  @RequirePermission('webhook:manage')
  remove(@Param('id') id: string, @CurrentUser() user: User | null) {
    return this.wms.deleteWebhook(this.must(user), id);
  }

  @Get(':id/deliveries')
  @RequirePermission('webhook:manage')
  deliveries(@Param('id') id: string, @CurrentUser() user: User | null) {
    return this.wms.webhookDeliveries(this.must(user), id);
  }

  @Post(':id/test')
  @RequirePermission('webhook:manage')
  test(@Param('id') id: string, @CurrentUser() user: User | null) {
    return this.wms.testWebhook(this.must(user), id);
  }
}
