/**
 * CycleCountService — conteo cíclico configurable por seller.
 *
 * Planificación (planCounts): según la estrategia del seller genera las tareas
 * de conteo del día:
 *   - ABC:      por clase de rotación (A seguido, C rara vez).
 *   - LOCATION: barrido por ubicaciones de almacenaje/picking.
 *   - RANDOM:   muestreo (orden pseudo-aleatorio determinista).
 * Además, cualquier bucket que quede en cero o negativo puede disparar un
 * conteo por EVENTO (opportunity counting).
 *
 * Ejecución (performCount): compara lo contado vs. lo que el sistema espera en
 * una ubicación y reconcilia el ledger con movimientos de AJUSTE (inmutables),
 * devolviendo el reporte de varianzas.
 */
import { NotFoundError, ValidationError } from './errors';
import {
  Clock,
  IdGenerator,
  CountAuditRepository,
  LocationRepository,
  MovementRepository,
  SellerRepository,
  SkuRepository,
} from './ports';
import {
  CountAudit,
  CountLine,
  CountResult,
  CountVariance,
  CycleCountStrategy,
  CycleCountTask,
  MovementType,
  RotationClass,
  StockMovement,
  StockState,
  Uom,
  ZoneType,
} from './types';

export class CycleCountService {
  constructor(
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly locations: LocationRepository,
    private readonly movements: MovementRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly countAudits?: CountAuditRepository,
  ) {}

  /** Genera las tareas de conteo del seller según su estrategia configurada. */
  async planCounts(sellerId: string, limit = 10): Promise<CycleCountTask[]> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);

    if (seller.cycleCountStrategy === CycleCountStrategy.ABC) {
      const skus = await this.skus.list(sellerId);
      const weight: Record<RotationClass, number> = {
        [RotationClass.A]: 1,
        [RotationClass.B]: 2,
        [RotationClass.C]: 3,
      };
      return skus
        .filter((s) => s.active)
        .sort((a, b) => weight[a.rotationClass] - weight[b.rotationClass])
        .slice(0, limit)
        .map((s) => ({
          kind: 'SKU' as const,
          ref: s.sku,
          label: `Contar SKU ${s.sku} (${s.description})`,
          priority: weight[s.rotationClass],
          reason: `Rotación ${s.rotationClass} (ABC)`,
        }));
    }

    if (seller.cycleCountStrategy === CycleCountStrategy.LOCATION) {
      const locs = (await this.locations.listByOperation(seller.operationId))
        .filter((l) => l.active && (l.zoneType === ZoneType.STORAGE || l.zoneType === ZoneType.PICKING))
        .sort((a, b) => (a.code < b.code ? -1 : 1));
      return locs.slice(0, limit).map((l, i) => ({
        kind: 'LOCATION' as const,
        ref: l.id,
        label: `Contar ubicación ${l.code}`,
        priority: i + 1,
        reason: 'Barrido por ubicación',
      }));
    }

    // RANDOM: orden pseudo-aleatorio determinista (hash del id), sin Math.random.
    const locs = (await this.locations.listByOperation(seller.operationId)).filter(
      (l) => l.active && l.zoneType === ZoneType.STORAGE,
    );
    return locs
      .map((l) => ({ l, h: hash(l.id) }))
      .sort((a, b) => a.h - b.h)
      .slice(0, limit)
      .map((x, i) => ({
        kind: 'LOCATION' as const,
        ref: x.l.id,
        label: `Contar ubicación ${x.l.code}`,
        priority: i + 1,
        reason: 'Muestreo aleatorio',
      }));
  }

  /**
   * Ejecuta el conteo de una ubicación: compara lo contado con lo que el sistema
   * espera (stock AVAILABLE del seller allí) y ajusta el ledger. Los buckets del
   * sistema que el operario no reporta se toman como contados en 0 (faltante).
   */
  async performCount(
    sellerId: string,
    locationId: string,
    counted: CountLine[],
    actor = 'cyclecount',
  ): Promise<CountResult> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    const loc = await this.locations.findById(locationId);
    if (!loc) throw new NotFoundError(`Ubicación no encontrada: ${locationId}`);
    for (const c of counted) {
      if (c.countedQty < 0) throw new ValidationError(`Cantidad contada inválida para ${c.sku}: ${c.countedQty}`);
    }

    const balances = await this.movements.balances({ sellerId, locationId });
    const expected = new Map<string, { sku: string; lot: string | null; qty: number }>();
    for (const b of balances) {
      if (b.state !== StockState.AVAILABLE) continue;
      expected.set(bucketKey(b.sku, b.lot), { sku: b.sku, lot: b.lot, qty: b.qty });
    }

    const countedMap = new Map<string, { sku: string; lot: string | null; qty: number }>();
    for (const c of counted) {
      const lot = c.lot ?? null;
      countedMap.set(bucketKey(c.sku, lot), { sku: c.sku, lot, qty: c.countedQty });
    }

    const keys = new Set<string>([...expected.keys(), ...countedMap.keys()]);
    const variances: CountVariance[] = [];
    const adjustments: StockMovement[] = [];
    const occurredAt = this.clock.now();
    const groupId = this.ids.next();
    let adjustedUnits = 0;
    let unitsExpected = 0;
    const linesCounted = keys.size; // buckets SKU/lote examinados

    for (const key of keys) {
      const exp = expected.get(key)?.qty ?? 0;
      const cntEntry = countedMap.get(key) ?? expected.get(key)!;
      const cnt = countedMap.has(key) ? countedMap.get(key)!.qty : 0;
      const delta = cnt - exp;
      unitsExpected += exp;
      if (delta === 0) continue;

      variances.push({ sku: cntEntry.sku, lot: cntEntry.lot, locationId, expected: exp, counted: cnt, delta });
      adjustedUnits += Math.abs(delta);
      adjustments.push({
        id: this.ids.next(),
        sellerId,
        sku: cntEntry.sku,
        locationId,
        lot: cntEntry.lot,
        state: StockState.AVAILABLE,
        type: MovementType.ADJUSTMENT,
        qtyDelta: delta, // reconcilia el sistema con lo contado
        uom: Uom.EACH,
        reference: `CYCLECOUNT:${groupId}`,
        groupId,
        actor,
        occurredAt,
      });
    }

    if (adjustments.length > 0) await this.movements.append(adjustments);

    // Persiste el conteo (tabla CountVariance) para el KPI de exactitud y su tendencia.
    if (this.countAudits) {
      const linesAccurate = linesCounted - variances.length;
      const audit: CountAudit = {
        id: groupId,
        operationId: seller.operationId,
        sellerId,
        locationId,
        at: occurredAt,
        linesCounted,
        linesAccurate,
        unitsExpected,
        absVarianceUnits: adjustedUnits,
        accuracyPct: linesCounted > 0 ? linesAccurate / linesCounted : 1,
        variances,
      };
      try { await this.countAudits.save(audit); } catch { /* auditoría best-effort */ }
    }

    return {
      sellerId,
      locationId,
      variances,
      adjustedUnits,
      accurate: variances.length === 0,
    };
  }
}

function bucketKey(sku: string, lot: string | null): string {
  return `${sku}|${lot ?? ''}`;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
