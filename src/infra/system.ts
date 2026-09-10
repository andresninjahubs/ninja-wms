import { randomUUID } from 'node:crypto';
import { Clock, IdGenerator } from '../domain/ports';

/** IDs aleatorios (UUID) para producción. */
export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

/** Reloj del sistema. */
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/**
 * Reloj del sistema con override opcional. Por defecto devuelve la hora real, pero
 * la semilla puede fijar un instante pasado para "retro-fechar" la actividad histórica
 * (movimientos, órdenes, recepciones) y así poblar las métricas y sus comparativos.
 * En operación normal nunca se fija override → se comporta como SystemClock.
 */
export class MutableClock implements Clock {
  private overrideMs: number | null = null;
  now(): string {
    return new Date(this.overrideMs == null ? Date.now() : this.overrideMs).toISOString();
  }
  /** Fija el instante (ms epoch) que devolverá now() hasta que se limpie. */
  setNow(ms: number): void {
    this.overrideMs = ms;
  }
  /** Vuelve a la hora real. */
  reset(): void {
    this.overrideMs = null;
  }
}
