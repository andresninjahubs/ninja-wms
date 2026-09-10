/**
 * PutawayAdvisor — el motor de guardado caótico DIRIGIDO.
 *
 * En un WMS caótico, ninguna posición está reservada a un SKU fijo: el sistema
 * decide dónde guardar según reglas. Este advisor puntúa las ubicaciones de
 * almacenaje y sugiere las mejores para recibir `qty` unidades de un `sku`.
 *
 * Reglas de puntaje (de mayor a menor peso):
 *   1. Consolidación — preferir ubicaciones que YA contienen ese SKU del seller.
 *   2. Rotación ABC — clase A cerca de picking; clase C lejos (libera lo cercano).
 *   3. Capacidad     — solo caben las que tienen espacio; a igualdad, más holgura.
 *
 * La capacidad se mide cross-seller (ubicaciones compartidas), pero la
 * consolidación es por seller+SKU (nunca mezcla propiedad).
 */
import { NotFoundError, ValidationError } from './errors';
import {
  LocationRepository,
  MovementRepository,
  SellerRepository,
  SkuRepository,
} from './ports';
import {
  PutawaySuggestion,
  RotationClass,
  StockState,
  ZoneType,
} from './types';

export class PutawayAdvisor {
  constructor(
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly locations: LocationRepository,
    private readonly movements: MovementRepository,
  ) {}

  async suggest(
    sellerId: string,
    cmd: { sku: string; qty: number; limit?: number },
  ): Promise<PutawaySuggestion[]> {
    if (!(cmd.qty > 0)) throw new ValidationError(`La cantidad debe ser positiva: ${cmd.qty}`);
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    const sku = await this.skus.find(sellerId, cmd.sku);
    if (!sku) throw new NotFoundError(`SKU no encontrado para el seller ${sellerId}: ${cmd.sku}`);

    const allLocations = await this.locations.listByOperation(seller.operationId);
    const storage = allLocations.filter((l) => l.active && l.zoneType === ZoneType.STORAGE);
    if (storage.length === 0) return [];

    const occupancy = await this.movements.occupancyByLocation();

    // Ubicaciones donde este seller+SKU ya tiene stock disponible (consolidación).
    const balances = await this.movements.balances({ sellerId, sku: cmd.sku });
    const consolidateIn = new Set(
      balances.filter((b) => b.state === StockState.AVAILABLE && b.qty > 0).map((b) => b.locationId),
    );

    const ranks = storage.map((l) => l.pickRank);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);

    // G7: distancia REAL a los puntos de despacho (picking/shipping) usando la
    // geometría de las ubicaciones. Si hay coordenadas, el advisor puntúa por
    // distancia; si no, cae al pickRank estático (compatibilidad hacia atrás).
    const dispatchPoints = allLocations.filter(
      (l) => (l.zoneType === ZoneType.PICKING || l.zoneType === ZoneType.SHIPPING) && l.x != null && l.y != null,
    );
    const distanceOf = (l: typeof storage[number]): number | null => {
      if (l.x == null || l.y == null || dispatchPoints.length === 0) return null;
      let best = Number.POSITIVE_INFINITY;
      for (const d of dispatchPoints) {
        const dx = l.x - (d.x as number);
        const dy = l.y - (d.y as number);
        best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
      }
      return best;
    };
    const distances = new Map<string, number>();
    for (const l of storage) { const d = distanceOf(l); if (d != null) distances.set(l.id, d); }
    const useDistance = distances.size > 0;
    const distVals = [...distances.values()];
    const minDist = distVals.length ? Math.min(...distVals) : 0;
    const maxDist = distVals.length ? Math.max(...distVals) : 0;
    const distSpan = maxDist - minDist || 1;

    const suggestions: PutawaySuggestion[] = [];
    for (const loc of storage) {
      const used = occupancy[loc.id] ?? 0;
      const unlimited = loc.capacity <= 0;
      const remaining = unlimited ? Number.POSITIVE_INFINITY : loc.capacity - used;
      if (!unlimited && remaining < cmd.qty) continue; // no cabe

      let score = 0;
      const reasons: string[] = [];

      if (consolidateIn.has(loc.id)) {
        score += 100;
        reasons.push('Ya contiene este SKU (consolidación)');
      }

      // Rotación ABC vs. cercanía a picking. Con geometría (G7) se usa la distancia
      // REAL normalizada a 0..1 (0 = más cerca del despacho); si no, el pickRank.
      const dist = distances.get(loc.id);
      if (useDistance && dist != null) {
        const near = 1 - (dist - minDist) / distSpan; // 1 = más cerca
        if (sku.rotationClass === RotationClass.A) {
          score += near * 60;
          reasons.push(`Cerca del despacho (rotación A · distancia ${Math.round(dist)})`);
        } else if (sku.rotationClass === RotationClass.C) {
          score += (1 - near) * 60;
          reasons.push(`Lejos del despacho (rotación C · distancia ${Math.round(dist)})`);
        } else {
          score += 10;
          reasons.push(`Rotación B (posición intermedia · distancia ${Math.round(dist)})`);
        }
      } else if (sku.rotationClass === RotationClass.A) {
        score += (maxRank - loc.pickRank) * 12;
        reasons.push('Cerca de picking (rotación A)');
      } else if (sku.rotationClass === RotationClass.C) {
        score += (loc.pickRank - minRank) * 12;
        reasons.push('Lejos de picking (rotación C)');
      } else {
        score += 10;
        reasons.push('Rotación B (posición intermedia)');
      }

      // A igualdad, preferir más holgura (reparte el uso del espacio).
      if (!unlimited) {
        score += Math.min(remaining, 1000) * 0.01;
        reasons.push(`Capacidad disponible: ${remaining}`);
      } else {
        reasons.push('Capacidad no limitada');
      }

      suggestions.push({
        locationId: loc.id,
        locationCode: loc.code,
        score: Math.round(score * 100) / 100,
        remainingCapacity: unlimited ? -1 : remaining,
        reasons,
      });
    }

    suggestions.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.locationCode < b.locationCode ? -1 : 1,
    );
    return suggestions.slice(0, cmd.limit ?? 3);
  }
}
