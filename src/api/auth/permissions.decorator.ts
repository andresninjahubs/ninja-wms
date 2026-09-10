import { SetMetadata } from '@nestjs/common';
import { Permission } from '../../domain/types';

/** Marca el permiso que exige un endpoint. Lo lee AuthGuard. */
export const PERMISSION_KEY = 'wms:permission';
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);
