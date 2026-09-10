import { Body, Controller, Inject, Param, Patch, Post } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { CreateLocationDto, UpdateLocationDto } from './dto';
import { actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/** Las ubicaciones son propias de cada OPERACIÓN. */
@Controller('locations')
export class LocationsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Post()
  @RequirePermission('master:manage')
  createLocation(@Body() dto: CreateLocationDto, @CurrentUser() user: User | null) {
    return this.wms.createLocation({
      operationId: actorOperation(user, dto.operationId),
      code: dto.code,
      zoneType: dto.zoneType,
      warehouseId: dto.warehouseId,
      capacity: dto.capacity,
      pickRank: dto.pickRank,
    });
  }

  /** Editar/activar/desactivar una ubicación. Respeta la frontera de operación. */
  @Patch(':locationId')
  @RequirePermission('master:manage')
  updateLocation(
    @Param('locationId') locationId: string,
    @Body() dto: UpdateLocationDto,
    @CurrentUser() user: User | null,
  ) {
    return this.wms.updateLocation(
      locationId,
      {
        code: dto.code,
        zoneType: dto.zoneType,
        warehouseId: dto.warehouseId,
        capacity: dto.capacity,
        pickRank: dto.pickRank,
        active: dto.active,
      },
      user,
    );
  }
}
