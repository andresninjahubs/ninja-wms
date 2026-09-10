/**
 * AbcService (G7) — recalcula la clase de rotación (A/B/C) de cada SKU a partir de
 * la VELOCIDAD REAL observada en el ledger (unidades pickeadas por SKU en una ventana),
 * en vez de dejarla fija a mano.
 *
 * Método Pareto clásico sobre unidades pickeadas descendentes:
 *   - A: SKUs que acumulan hasta el 80% del volumen (los que más rotan).
 *   - B: hasta el 95%.
 *   - C: el resto (cola larga).
 *
 * Reproducible: recalcula desde el ledger; re-ejecutar con la misma ventana da la
 * misma clasificación. Idempotente sobre el SKU (sólo escribe si cambia la clase).
 */
import { Clock, MovementRepository, SellerRepository, SkuRepository } from './ports';
import { MovementType, RotationClass } from './types';

const DAY = 86400000;

export class AbcService {
  constructor(
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly movements: MovementRepository,
    private readonly clock: Clock,
  ) {}

  async recompute(operationId: string, opts?: { days?: number }): Promise<{ updated: number; considered: number; byClass: Record<string, number> }> {
    const windowDays = opts?.days ?? 90;
    const fromMs = Date.parse(this.clock.now()) - windowDays * DAY;
    const sellerIds = (await this.sellers.list(operationId)).map((s) => s.id);
    let updated = 0;
    let considered = 0;
    const byClass: Record<string, number> = { A: 0, B: 0, C: 0 };

    for (const sellerId of sellerIds) {
      const skus = await this.skus.list(sellerId);
      if (!skus.length) continue;
      // Velocidad real: unidades pickeadas por SKU en la ventana.
      const picked = new Map<string, number>();
      const movs = await this.movements.find({ sellerId });
      for (const m of movs) {
        if (m.type !== MovementType.PICK) continue;
        if (Date.parse(m.occurredAt) < fromMs) continue;
        picked.set(m.sku, (picked.get(m.sku) || 0) + Math.abs(m.qtyDelta));
      }
      const total = [...picked.values()].reduce((a, b) => a + b, 0);
      // SKUs ordenados por volumen desc; los sin movimiento van al final (clase C).
      const ranked = skus.slice().sort((a, b) => (picked.get(b.sku) || 0) - (picked.get(a.sku) || 0));

      let cumulative = 0;
      for (const sku of ranked) {
        considered += 1;
        const vol = picked.get(sku.sku) || 0;
        let cls: RotationClass;
        if (total === 0 || vol === 0) {
          cls = RotationClass.C; // sin rotación observada → cola larga
        } else {
          const beforeShare = cumulative / total;
          cumulative += vol;
          if (beforeShare < 0.8) cls = RotationClass.A;
          else if (beforeShare < 0.95) cls = RotationClass.B;
          else cls = RotationClass.C;
        }
        byClass[cls] = (byClass[cls] || 0) + 1;
        if (sku.rotationClass !== cls) {
          await this.skus.save({ ...sku, rotationClass: cls });
          updated += 1;
        }
      }
    }
    return { updated, considered, byClass };
  }
}
