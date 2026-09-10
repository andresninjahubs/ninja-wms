/**
 * UserService — identidad, roles, permisos y mantenedor de usuarios.
 *
 * Da "control total sobre los movimientos": cada acción sensible exige un permiso,
 * y el usuario autenticado se convierte en el `actor` de los movimientos del ledger.
 *
 * Modelo multi-tenant de usuarios:
 *  - Staff del operador 3PL (ADMIN/SUPERVISOR/OPERATOR): sellerId = null, opera sobre todos.
 *  - Usuario del seller (CLIENT): sellerId fijo, solo puede ver/actuar sobre SU seller.
 */
import * as bcrypt from 'bcryptjs';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { IdGenerator, UserRepository } from './ports';
import { Permission, ROLE_PERMISSIONS, User, UserRole } from './types';

export interface CreateUserInput {
  id?: string;
  name: string;
  email: string;
  role: UserRole;
  operationId?: string | null; // requerido salvo PLATFORM_ADMIN
  sellerId?: string | null; // requerido para CLIENT
  password?: string | null; // contraseña inicial opcional (si no, queda invitación pendiente)
  emailVerified?: boolean; // default true; las altas self-serve lo fijan en false
}

export interface UpdateUserInput {
  name?: string;
  role?: UserRole;
  sellerId?: string | null;
  active?: boolean;
}

export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly ids: IdGenerator,
  ) {}

  // ---- Mantenedor de usuarios ----------------------------------------------
  async createUser(input: CreateUserInput): Promise<User> {
    const email = input.email.trim().toLowerCase();
    if (!email.includes('@')) throw new ValidationError(`Email inválido: ${input.email}`);
    if (await this.users.findByEmail(email)) {
      throw new ValidationError(`Ya existe un usuario con el email ${email}`);
    }
    const user: User = {
      id: input.id ?? this.ids.next(),
      name: input.name,
      email,
      role: input.role,
      operationId: this.normalizeOperationId(input.role, input.operationId ?? null),
      sellerId: this.normalizeSellerId(input.role, input.sellerId ?? null),
      active: true,
      emailVerified: input.emailVerified ?? true,
      passwordHash: input.password ? await this.hash(input.password) : null,
    };
    await this.users.save(user);
    return user;
  }

  // ---- Credenciales ---------------------------------------------------------
  private async hash(plain: string): Promise<string> {
    if (!plain || plain.length < 6) {
      throw new ValidationError('La contraseña debe tener al menos 6 caracteres');
    }
    return bcrypt.hash(plain, 10);
  }

  /** Fija/reemplaza la contraseña de un usuario (alta por invitación o reset por admin). */
  async setPassword(userId: string, plain: string): Promise<User> {
    const user = await this.mustGet(userId);
    const updated: User = { ...user, passwordHash: await this.hash(plain) };
    await this.users.save(updated);
    return updated;
  }

  /** Marca (o desmarca) el email de un usuario como verificado. */
  async setEmailVerified(userId: string, verified: boolean): Promise<User> {
    const user = await this.mustGet(userId);
    const updated: User = { ...user, emailVerified: verified };
    await this.users.save(updated);
    return updated;
  }

  /** Busca un usuario por email (normalizado). */
  findByEmail(email: string): Promise<User | null> {
    return this.users.findByEmail((email || '').trim().toLowerCase());
  }

  /** Cambio de contraseña por el propio usuario (verifica la actual). */
  async changePassword(userId: string, current: string, next: string): Promise<User> {
    const user = await this.mustGet(userId);
    if (!user.passwordHash || !(await bcrypt.compare(current, user.passwordHash))) {
      throw new ForbiddenError('La contraseña actual no es correcta');
    }
    return this.setPassword(userId, next);
  }

  /** Login real: email + contraseña. Devuelve el usuario si coincide y está activo. */
  async authenticateWithPassword(email: string, password: string): Promise<User | null> {
    const user = await this.users.findByEmail((email || '').trim().toLowerCase());
    if (!user || !user.active || !user.passwordHash) return null;
    const ok = await bcrypt.compare(password || '', user.passwordHash);
    return ok ? user : null;
  }

  async updateUser(userId: string, patch: UpdateUserInput): Promise<User> {
    const user = await this.mustGet(userId);
    const role = patch.role ?? user.role;
    const sellerId =
      patch.sellerId !== undefined ? patch.sellerId : user.sellerId;
    const updated: User = {
      ...user,
      name: patch.name ?? user.name,
      role,
      sellerId: this.normalizeSellerId(role, sellerId),
      active: patch.active ?? user.active,
    };
    await this.users.save(updated);
    return updated;
  }

  async deactivateUser(userId: string): Promise<User> {
    return this.updateUser(userId, { active: false });
  }

  async getUser(userId: string): Promise<User | null> {
    return this.users.findById(userId);
  }

  /** Sin argumento: todos (PLATFORM_ADMIN). Con operationId: solo esa operación. */
  async listUsers(operationId?: string | null): Promise<User[]> {
    return this.users.list(operationId ?? undefined);
  }

  // ---- Autenticación (skeleton) --------------------------------------------
  /**
   * Autenticación mínima para el skeleton: el token ES el id del usuario.
   * En producción se reemplaza por login con contraseña/JWT, misma interfaz de salida.
   */
  async authenticate(token: string): Promise<User | null> {
    if (!token) return null;
    const byId = await this.users.findById(token);
    const user = byId ?? (await this.users.findByEmail(token.trim().toLowerCase()));
    return user && user.active ? user : null;
  }

  // ---- Autorización ---------------------------------------------------------
  /** ¿El rol del usuario incluye este permiso? (sin considerar el seller objetivo) */
  can(user: User, permission: Permission): boolean {
    return user.active && ROLE_PERMISSIONS[user.role].includes(permission);
  }

  /**
   * Verifica permiso + fronteras de OPERACIÓN y de seller. Lanza ForbiddenError si no procede.
   * El PLATFORM_ADMIN atraviesa todas las operaciones.
   * `target` indica sobre qué operación/seller actúa la solicitud (si aplica).
   */
  authorize(
    user: User,
    permission: Permission,
    target: { operationId?: string | null; sellerId?: string | null } = {},
  ): void {
    if (!user.active) throw new ForbiddenError(`Usuario inactivo: ${user.email}`);
    if (!ROLE_PERMISSIONS[user.role].includes(permission)) {
      throw new ForbiddenError(`El rol ${user.role} no tiene el permiso ${permission}`);
    }
    // Super-admin de plataforma: sin frontera de operación ni de seller.
    if (user.role === UserRole.PLATFORM_ADMIN) return;

    // Frontera de OPERACIÓN: solo se opera sobre la operación propia.
    if (target.operationId != null && target.operationId !== user.operationId) {
      throw new ForbiddenError(
        `El usuario ${user.email} solo puede operar sobre su operación (${user.operationId})`,
      );
    }
    // Frontera de SELLER: un CLIENT solo actúa sobre su propio seller.
    if (user.sellerId !== null && target.sellerId != null && target.sellerId !== user.sellerId) {
      throw new ForbiddenError(
        `El usuario ${user.email} solo puede operar sobre su seller (${user.sellerId})`,
      );
    }
  }

  private normalizeOperationId(role: UserRole, operationId: string | null): string | null {
    if (role === UserRole.PLATFORM_ADMIN) return null; // transversal
    if (!operationId) throw new ValidationError(`El rol ${role} debe pertenecer a una operación`);
    return operationId;
  }

  private normalizeSellerId(role: UserRole, sellerId: string | null): string | null {
    if (role === UserRole.CLIENT) {
      if (!sellerId) throw new ValidationError('Un usuario CLIENT debe tener sellerId');
      return sellerId;
    }
    return null; // el staff del operador no está atado a un seller
  }

  private async mustGet(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError(`Usuario no encontrado: ${userId}`);
    return user;
  }
}
