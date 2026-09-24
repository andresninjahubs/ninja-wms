import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { ChangePasswordDto, CreateUserDto, EmailOnlyDto, LoginDto, RegisterDto, ResetPasswordDto, SetPasswordDto, UpdateUserDto, VerifyEmailDto } from './dto';
import { CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/** Mantenedor de usuarios. Todo endpoint exige el permiso `user:manage` (rol ADMIN). */
@Controller('users')
export class UsersController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Post()
  @RequirePermission('user:manage')
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: User | null) {
    // El ADMIN de una operación solo crea usuarios en SU operación; el PLATFORM_ADMIN elige.
    const operationId = actor && actor.operationId ? actor.operationId : dto.operationId ?? null;
    return this.wms.createUser({
      name: dto.name,
      email: dto.email,
      role: dto.role,
      operationId,
      sellerId: dto.sellerId ?? null,
      password: dto.password ?? null,
    });
  }

  /** El admin fija/restablece la contraseña de un usuario de su alcance. */
  @Post(':userId/password')
  @RequirePermission('user:manage')
  setPassword(@Param('userId') userId: string, @Body() dto: SetPasswordDto) {
    return this.wms.setUserPassword(userId, dto.password);
  }

  @Get()
  @RequirePermission('user:manage')
  list(@CurrentUser() actor: User | null) {
    // PLATFORM_ADMIN (operationId null) ve todos; un ADMIN de operación, solo la suya.
    return this.wms.listUsers(actor?.operationId ?? null);
  }

  @Get(':userId')
  @RequirePermission('user:manage')
  async get(@Param('userId') userId: string) {
    const user = await this.wms.getUser(userId);
    if (!user) throw new NotFoundException(`Usuario no encontrado: ${userId}`);
    return user;
  }

  @Patch(':userId')
  @RequirePermission('user:manage')
  update(@Param('userId') userId: string, @Body() dto: UpdateUserDto) {
    return this.wms.updateUser(userId, dto);
  }

  @Post(':userId/deactivate')
  @RequirePermission('user:manage')
  deactivate(@Param('userId') userId: string) {
    return this.wms.deactivateUser(userId);
  }
}

/**
 * Login. Soporta el flujo real (email + contraseña -> JWT) y, para el modo demo,
 * un token que es el id/email del usuario (solo si AUTH_REQUIRED != 'true').
 * Endpoint público.
 */
@Controller('auth')
export class AuthController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @Post('login')
  async login(@Body() dto: LoginDto) {
    // 1) Login real con email + contraseña.
    if (dto.email && dto.password) {
      const res = await this.wms.loginWithPassword(dto.email, dto.password);
      if (!res.authenticated) {
        return { authenticated: false, detail: 'Email o contraseña incorrectos' };
      }
      // Registra el login exitoso (auditoría + métricas de uso de plataforma).
      if (res.user) await this.wms.recordLogin(res.user.id, res.user.operationId ?? null);
      return { authenticated: true, token: res.token, user: res.user };
    }
    // 2) Modo demo: token = id/email (solo si no se exige auth).
    if (dto.token && process.env.AUTH_REQUIRED !== 'true') {
      const user = await this.wms.authenticate(dto.token);
      if (!user) return { authenticated: false, detail: 'Token inválido o usuario inactivo' };
      await this.wms.recordLogin(user.id, user.operationId ?? null);
      return { authenticated: true, token: user.id, user };
    }
    return { authenticated: false, detail: 'Faltan credenciales (email y contraseña)' };
  }

  /** El propio usuario autenticado cambia su contraseña. */
  @Post('change-password')
  async changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: User | null) {
    if (!user) throw new UnauthorizedException('Debes iniciar sesión');
    await this.wms.changePassword(user.id, dto.currentPassword, dto.newPassword);
    return { changed: true };
  }

  // ---- Registro self-serve (público, sin @RequirePermission) ----------------

  /** Alta self-serve: crea la cuenta, auto-loguea y envía verificación de email. */
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    const res = await this.wms.registerSelfServe({
      companyName: dto.companyName, name: dto.name, email: dto.email, phone: dto.phone, password: dto.password, track: dto.track,
    });
    await this.wms.recordLogin(res.user.id, res.user.operationId ?? null);
    return { authenticated: true, token: res.token, user: res.user, operationId: res.operationId, sellerId: res.sellerId, verification: res.verification };
  }

  /** Canjea el enlace de verificación de email. */
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.wms.verifyEmail(dto.token);
  }

  /** Reenvía el correo de verificación (respuesta genérica). */
  @Post('resend-verification')
  resendVerification(@Body() dto: EmailOnlyDto) {
    return this.wms.resendVerification(dto.email);
  }

  /** Solicita un enlace de reset de contraseña (respuesta genérica). */
  @Post('request-password-reset')
  requestPasswordReset(@Body() dto: EmailOnlyDto) {
    return this.wms.requestPasswordReset(dto.email);
  }

  /** Fija una nueva contraseña con el token de reset. */
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.wms.resetPassword(dto.token, dto.password);
  }
}
