/**
 * Desnormaliza el historial `events` (JSON, append-only) de una orden/recepción/
 * devolución a filas `DomainEvent` para el event store consultable (G2+G6).
 *
 * El id es DETERMINÍSTICO (`${entityType}:${entityId}:${seq}`): re-guardar la misma
 * entidad reemite las mismas filas, así que `append` puede ser idempotente y el
 * dual-write nunca duplica. `seq` es la posición en el historial (0-based).
 */
import { DomainEvent, DomainEntityType, OrderEvent } from './types';

export function toDomainEvents(
  entityType: DomainEntityType,
  entityId: string,
  entityRef: string | null,
  sellerId: string,
  events: OrderEvent[] | undefined | null,
): DomainEvent[] {
  return (events || []).map((e, seq) => ({
    id: `${entityType}:${entityId}:${seq}`,
    entityType,
    entityId,
    entityRef: entityRef ?? null,
    sellerId,
    seq,
    type: e.type,
    at: e.at,
    actor: e.actor,
    detail: e.detail ?? null,
  }));
}
