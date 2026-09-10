/**
 * Emisión y validación de JWT (HS256) para el login real.
 *
 * El secreto se toma de AUTH_SECRET. En producción DEBE definirse un secreto
 * robusto por entorno; el valor por defecto es solo para desarrollo/demo.
 */
import * as jwt from 'jsonwebtoken';
import { User } from '../domain/types';

const SECRET: string = process.env.AUTH_SECRET || 'dev-secret-cambiar-en-produccion';
const EXPIRES_IN: string = process.env.AUTH_TOKEN_TTL || '12h';

export interface TokenPayload {
  sub: string; // id del usuario
  email: string;
  role: string;
  operationId: string | null;
  sellerId: string | null;
}

/** Firma un JWT con los datos de identidad del usuario. */
export function signToken(user: User): string {
  const payload: TokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    operationId: user.operationId,
    sellerId: user.sellerId,
  };
  const options: jwt.SignOptions = { expiresIn: EXPIRES_IN as unknown as number };
  return jwt.sign(payload as object, SECRET, options);
}

/** Valida un JWT y devuelve su payload, o null si es inválido/expirado. */
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

/** ¿El string tiene forma de JWT (tres segmentos separados por punto)? */
export function looksLikeJwt(token: string): boolean {
  return typeof token === 'string' && token.split('.').length === 3;
}
