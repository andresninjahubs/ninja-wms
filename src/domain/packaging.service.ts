/**
 * PackagingService — Insumos de embalaje (packaging) a nivel OPERACIÓN.
 *
 * El embalaje (caja, bolsa, cinta…) es un "producto" con SKU/EAN pero NO se vende:
 * se CONSUME al empacar una orden y se cobra al seller cuyo pedido lo usó. El catálogo
 * es compartido por la operación; el precio por defecto admite override por seller.
 *
 * Stock propio (ledger de embalaje, independiente del ledger por-seller):
 *   - RECEIPT     ingreso de stock (+)
 *   - CONSUMPTION consumo al empacar (−), cargado a un seller/orden
 *   - ADJUSTMENT  ajuste manual (+/−)
 * El saldo de un insumo es la suma de sus deltas.
 */
import { NotFoundError, ValidationError } from './errors';
import { Clock, IdGenerator, PackagingRepository } from './ports';
import { PackagingMaterial, PackagingMovement, PackagingMovementType } from './types';

export interface CreatePackagingInput {
  sku: string;
  name: string;
  barcode?: string | null;
  unitPrice?: number;
  active?: boolean;
}

export interface PackagingConsumptionInput {
  sku: string;
  qty: number;
}

export interface PackagingMaterialView extends PackagingMaterial {
  onHand: number; // saldo actual (suma de deltas)
  avgCost: number; // costo promedio ponderado (PMP) vigente por unidad
  lastCost: number | null; // costo de la última reposición
  lastCostAt: string | null; // fecha de la última reposición con costo
  stockValue: number; // onHand × avgCost (valor del inventario de insumos)
}

/** Estado de costos de un insumo, recorriendo su ledger en orden cronológico. */
export interface PackagingCostState {
  onHand: number;
  avgCost: number;
  lastCost: number | null;
  lastCostAt: string | null;
}

export class PackagingService {
  constructor(
    private readonly repo: PackagingRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private norm(s: string): string {
    return String(s || '').trim();
  }

  /** Precio efectivo para un seller: su override, o el precio por defecto del insumo. */
  effectivePrice(m: PackagingMaterial, sellerId: string | null): number {
    if (sellerId && m.sellerPrices && m.sellerPrices[sellerId] != null) return m.sellerPrices[sellerId];
    return m.unitPrice;
  }

  async createMaterial(operationId: string, input: CreatePackagingInput): Promise<PackagingMaterial> {
    const sku = this.norm(input.sku);
    if (!sku) throw new ValidationError('El SKU del insumo de embalaje es obligatorio');
    if (!this.norm(input.name)) throw new ValidationError('El nombre del insumo es obligatorio');
    if (await this.repo.getMaterial(operationId, sku)) {
      throw new ValidationError(`Ya existe un insumo de embalaje con SKU ${sku} en esta operación`);
    }
    const price = input.unitPrice ?? 0;
    if (!(price >= 0)) throw new ValidationError('El precio no puede ser negativo');
    const material: PackagingMaterial = {
      operationId,
      sku,
      barcode: input.barcode ? this.norm(input.barcode) : null,
      name: this.norm(input.name),
      unitPrice: price,
      sellerPrices: {},
      active: input.active ?? true,
    };
    await this.repo.saveMaterial(material);
    return material;
  }

  async updateMaterial(
    operationId: string,
    sku: string,
    patch: { name?: string; barcode?: string | null; unitPrice?: number; active?: boolean },
  ): Promise<PackagingMaterial> {
    const cur = await this.mustGet(operationId, sku);
    const next: PackagingMaterial = {
      ...cur,
      name: patch.name != null && this.norm(patch.name) ? this.norm(patch.name) : cur.name,
      barcode: patch.barcode !== undefined ? (patch.barcode ? this.norm(patch.barcode) : null) : cur.barcode,
      unitPrice: patch.unitPrice != null ? patch.unitPrice : cur.unitPrice,
      active: patch.active != null ? patch.active : cur.active,
    };
    if (!(next.unitPrice >= 0)) throw new ValidationError('El precio no puede ser negativo');
    await this.repo.saveMaterial(next);
    return next;
  }

  /** Define/actualiza (o borra) el precio custom de un insumo para un seller. */
  async setSellerPrice(operationId: string, sku: string, sellerId: string, price: number | null): Promise<PackagingMaterial> {
    const cur = await this.mustGet(operationId, sku);
    const sellerPrices = { ...(cur.sellerPrices || {}) };
    if (price == null) {
      delete sellerPrices[sellerId];
    } else {
      if (!(price >= 0)) throw new ValidationError('El precio no puede ser negativo');
      sellerPrices[sellerId] = price;
    }
    const next = { ...cur, sellerPrices };
    await this.repo.saveMaterial(next);
    return next;
  }

  async mustGet(operationId: string, sku: string): Promise<PackagingMaterial> {
    const m = await this.repo.getMaterial(operationId, this.norm(sku));
    if (!m) throw new NotFoundError(`Insumo de embalaje no encontrado: ${sku}`);
    return m;
  }

  private ev(operationId: string, materialSku: string, type: PackagingMovementType, qtyDelta: number, extra: Partial<PackagingMovement>): PackagingMovement {
    return {
      id: this.ids.next(),
      operationId,
      materialSku,
      type,
      qtyDelta,
      sellerId: extra.sellerId ?? null,
      orderId: extra.orderId ?? null,
      unitPrice: extra.unitPrice ?? null,
      unitCost: extra.unitCost ?? null,
      reference: extra.reference ?? null,
      actor: extra.actor ?? 'system',
      occurredAt: this.clock.now(),
    };
  }

  /**
   * Costo promedio ponderado (PMP) a partir del ledger de un insumo:
   *   - RECEIPT con costo: nuevo PMP = (saldo×PMP + qty×costo) / (saldo + qty).
   *     Si el saldo era ≤ 0, el PMP pasa a ser el costo del ingreso.
   *   - RECEIPT sin costo (histórico) y ajustes positivos: entran al PMP vigente.
   *   - Salidas (consumo, ajuste negativo): no cambian el PMP, solo el saldo.
   */
  costStateFrom(movements: PackagingMovement[]): PackagingCostState {
    const st: PackagingCostState = { onHand: 0, avgCost: 0, lastCost: null, lastCostAt: null };
    const sorted = [...movements].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    for (const mv of sorted) {
      if (mv.qtyDelta > 0 && mv.type === PackagingMovementType.RECEIPT && mv.unitCost != null) {
        const prevQty = Math.max(0, st.onHand);
        st.avgCost = prevQty > 0 ? Math.round((prevQty * st.avgCost + mv.qtyDelta * mv.unitCost) / (prevQty + mv.qtyDelta)) : mv.unitCost;
        st.lastCost = mv.unitCost;
        st.lastCostAt = mv.occurredAt;
      }
      st.onHand += mv.qtyDelta;
    }
    return st;
  }

  async costState(operationId: string, sku: string): Promise<PackagingCostState> {
    const movs = await this.repo.listMovements(operationId, { materialSku: this.norm(sku) });
    return this.costStateFrom(movs);
  }

  /** Ingreso de stock de un insumo (+). */
  async receiveStock(
    operationId: string,
    sku: string,
    qty: number,
    actor?: string,
    reference?: string | null,
    unitCost?: number | null,
  ): Promise<PackagingMovement> {
    await this.mustGet(operationId, sku);
    if (!(qty > 0) || !Number.isInteger(qty)) throw new ValidationError(`Cantidad de ingreso inválida: ${qty}`);
    if (unitCost != null && (!(unitCost >= 0) || !Number.isFinite(unitCost))) throw new ValidationError(`Costo unitario inválido: ${unitCost}`);
    const mv = this.ev(operationId, this.norm(sku), PackagingMovementType.RECEIPT, qty, {
      actor, reference: reference ?? null, unitCost: unitCost != null ? Math.round(unitCost) : null,
    });
    await this.repo.appendMovements([mv]);
    return mv;
  }

  /** Ajuste manual (+/−). No deja el saldo negativo. */
  async adjustStock(operationId: string, sku: string, qtyDelta: number, actor?: string, reference?: string | null): Promise<PackagingMovement> {
    await this.mustGet(operationId, sku);
    if (!Number.isInteger(qtyDelta) || qtyDelta === 0) throw new ValidationError('El ajuste debe ser un entero distinto de 0');
    const st = await this.costState(operationId, sku);
    const onHand = st.onHand;
    if (onHand + qtyDelta < 0) throw new ValidationError(`El ajuste dejaría el saldo negativo (saldo ${onHand}, ajuste ${qtyDelta})`);
    const mv = this.ev(operationId, this.norm(sku), PackagingMovementType.ADJUSTMENT, qtyDelta, { actor, reference: reference ?? null, unitCost: st.avgCost });
    await this.repo.appendMovements([mv]);
    return mv;
  }

  /**
   * Valida los insumos a consumir y prepara (sin persistir) el detalle + los movimientos.
   * Se separa del commit para que el packing pueda validar TODO antes de escribir stock.
   * No bloquea si el saldo queda bajo, pero valida cantidad > 0, existencia y que esté activo.
   */
  async resolveUse(
    operationId: string,
    sellerId: string,
    orderId: string,
    items: PackagingConsumptionInput[],
    actor?: string,
  ): Promise<{ used: { sku: string; name: string; qty: number }[]; movements: PackagingMovement[] }> {
    const movements: PackagingMovement[] = [];
    const used: { sku: string; name: string; qty: number }[] = [];
    for (const it of items || []) {
      const sku = this.norm(it.sku);
      if (!sku) continue;
      if (!(it.qty > 0) || !Number.isInteger(it.qty)) {
        throw new ValidationError(`Cantidad de embalaje inválida para ${sku}: ${it.qty}`);
      }
      const m = await this.mustGet(operationId, sku);
      if (!m.active) throw new ValidationError(`El insumo de embalaje ${sku} está inactivo`);
      const price = this.effectivePrice(m, sellerId);
      const cost = (await this.costState(operationId, sku)).avgCost; // valoriza la salida al PMP vigente
      movements.push(
        this.ev(operationId, sku, PackagingMovementType.CONSUMPTION, -it.qty, {
          sellerId,
          orderId,
          unitPrice: price,
          unitCost: cost,
          reference: `PACK:${orderId}`,
          actor,
        }),
      );
      used.push({ sku, name: m.name, qty: it.qty });
    }
    return { used, movements };
  }

  /** Persiste los movimientos de consumo preparados por resolveUse. */
  async commit(movements: PackagingMovement[]): Promise<void> {
    if (movements.length) await this.repo.appendMovements(movements);
  }

  async onHand(operationId: string, sku: string): Promise<number> {
    const movs = await this.repo.listMovements(operationId, { materialSku: this.norm(sku) });
    return movs.reduce((a, m) => a + m.qtyDelta, 0);
  }

  /** Catálogo con saldo calculado. */
  async listMaterials(operationId: string): Promise<PackagingMaterialView[]> {
    const materials = await this.repo.listMaterials(operationId);
    const movs = await this.repo.listMovements(operationId);
    const bySku = new Map<string, PackagingMovement[]>();
    for (const mv of movs) { const arr = bySku.get(mv.materialSku) || []; arr.push(mv); bySku.set(mv.materialSku, arr); }
    return materials.map((m) => {
      const st = this.costStateFrom(bySku.get(m.sku) || []);
      return { ...m, onHand: st.onHand, avgCost: st.avgCost, lastCost: st.lastCost, lastCostAt: st.lastCostAt, stockValue: Math.max(0, st.onHand) * st.avgCost };
    });
  }

  /**
   * Costo real de embalaje consumido por un seller en un período (o para un set de órdenes),
   * valorizado al PMP del momento del consumo. Alimenta rentabilidad (costo vs. cobro).
   */
  async consumptionCost(operationId: string, sellerId: string, fromIso: string, toIso: string, orderIds?: Set<string> | null): Promise<{ qty: number; cost: number; billed: number }> {
    const movs = await this.repo.listMovements(operationId, { sellerId });
    let qty = 0, cost = 0, billed = 0;
    for (const mv of movs) {
      if (mv.type !== PackagingMovementType.CONSUMPTION) continue;
      if (orderIds) { if (!mv.orderId || !orderIds.has(mv.orderId)) continue; }
      else if (mv.occurredAt < fromIso || mv.occurredAt >= toIso) continue;
      const q = -mv.qtyDelta;
      qty += q; cost += q * (mv.unitCost ?? 0); billed += q * (mv.unitPrice ?? 0);
    }
    return { qty, cost: Math.round(cost), billed: Math.round(billed) };
  }

  listMovements(operationId: string, filter?: { materialSku?: string; sellerId?: string }): Promise<PackagingMovement[]> {
    return this.repo.listMovements(operationId, filter);
  }

  /**
   * Consumo de embalaje de un seller a facturar, agrupado por insumo, con el monto.
   * Alimenta la pre-facturación (una línea por tipo de embalaje).
   * Si se entrega `orderIds` (órdenes despachadas en el período), se cobran los consumos de
   * ESAS órdenes sin importar cuándo se empacaron; si no, se cobra por fecha de consumo.
   */
  async consumptionForBilling(
    operationId: string,
    sellerId: string,
    fromIso: string,
    toIso: string,
    orderIds?: Set<string> | null,
  ): Promise<{ sku: string; name: string; qty: number; unitPrice: number; amount: number }[]> {
    const movs = await this.repo.listMovements(operationId, { sellerId });
    const materials = await this.repo.listMaterials(operationId);
    const nameOf = new Map(materials.map((m) => [m.sku, m.name]));
    const agg = new Map<string, { qty: number; amount: number; unitPrice: number }>();
    for (const mv of movs) {
      if (mv.type !== PackagingMovementType.CONSUMPTION) continue;
      if (orderIds) { if (!mv.orderId || !orderIds.has(mv.orderId)) continue; }
      else if (mv.occurredAt < fromIso || mv.occurredAt >= toIso) continue;
      const qty = -mv.qtyDelta; // consumo positivo
      const price = mv.unitPrice ?? 0;
      const cur = agg.get(mv.materialSku) || { qty: 0, amount: 0, unitPrice: price };
      cur.qty += qty;
      cur.amount += qty * price;
      cur.unitPrice = price; // último precio aplicado (referencial)
      agg.set(mv.materialSku, cur);
    }
    return [...agg.entries()].map(([sku, v]) => ({
      sku,
      name: nameOf.get(sku) || sku,
      qty: v.qty,
      unitPrice: v.unitPrice,
      amount: Math.round(v.amount),
    }));
  }
}
