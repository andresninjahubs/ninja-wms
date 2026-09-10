/**
 * ReturnService — módulo de DEVOLUCIONES (logística reversa).
 *
 * Flujo:
 *   1. Se crea una devolución ENLAZADA a la orden de salida original (por su N°
 *      externo / etiqueta). Sus líneas se prellenan con lo que se despachó.
 *   2. Control de calidad (QA): por cada SKU recibido, el operario decide la
 *      DISPOSICIÓN de cada unidad → a stock disponible, a merma, o a cuarentena.
 *      Se admite recibir MENOS (devolución parcial) o SKUs que no venían en la
 *      orden original (producto que "no corresponde" → línea comodín).
 *   3. Al registrar, el stock entra al ledger como movimiento RETURN en el
 *      estado correspondiente (AVAILABLE / DAMAGED / QUARANTINE) y en su ubicación.
 *
 * Las ubicaciones dedicadas de merma y cuarentena de devoluciones se crean
 * automáticamente la primera vez (zona QUARANTINE, no pickeable).
 */
import { NotFoundError, ValidationError } from './errors';
import { InventoryService } from './inventory.service';
import {
  Clock,
  IdGenerator,
  LocationRepository,
  OrderRepository,
  ReturnOrderRepository,
  SellerRepository,
  SkuRepository,
} from './ports';
import {
  Location,
  OrderEvent,
  ReturnLine,
  ReturnOrder,
  ReturnStatus,
  Seller,
  StockState,
  ZoneType,
} from './types';

export interface CreateReturnInput {
  originalOrderRef: string; // N° externo o id de la orden de salida
  reason?: string | null;
}

export interface ProcessReturnLine {
  sku: string;
  toStock?: number;
  toMerma?: number;
  toQuarantine?: number;
  note?: string | null;
}

export interface ProcessReturnInput {
  lines: ProcessReturnLine[];
  close?: boolean; // true (por defecto): cierra la devolución (COMPLETED)
}

const MERMA_CODE = 'DEV-MERMA';
const CUARENTENA_CODE = 'DEV-CUARENTENA';

export class ReturnService {
  constructor(
    private readonly returns: ReturnOrderRepository,
    private readonly orders: OrderRepository,
    private readonly inventory: InventoryService,
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly locations: LocationRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private ev(type: string, actor?: string, detail?: string | null): OrderEvent {
    return { type, at: this.clock.now(), actor: actor || 'system', detail: detail ?? null };
  }

  private genCode(): string {
    const ymd = this.clock.now().slice(0, 10).replace(/-/g, '');
    const suffix = this.ids.next().replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
    return `DEV-${ymd}-${suffix}`;
  }

  private async mustGet(sellerId: string, returnId: string): Promise<ReturnOrder> {
    const r = await this.returns.findById(sellerId, returnId);
    if (!r) throw new NotFoundError(`Devolución no encontrada: ${returnId}`);
    return r;
  }

  private async assertSeller(sellerId: string): Promise<Seller> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    if (!seller.active) throw new ValidationError(`Seller inactivo: ${sellerId}`);
    return seller;
  }

  /** Busca la orden de salida original por id interno o por N° externo. */
  private async findOriginalOrder(sellerId: string, ref: string) {
    const byId = await this.orders.findById(sellerId, ref);
    if (byId) return byId;
    const all = await this.orders.list(sellerId);
    return all.find((o) => o.externalOrderId === ref) ?? null;
  }

  /** Crea una devolución enlazada a la orden original, con sus líneas prellenadas. */
  async createFromOrder(sellerId: string, input: CreateReturnInput, actor?: string): Promise<ReturnOrder> {
    await this.assertSeller(sellerId);
    const ref = (input.originalOrderRef || '').trim();
    if (!ref) throw new ValidationError('Indica el N° de la orden de salida original.');
    const original = await this.findOriginalOrder(sellerId, ref);
    if (!original) throw new NotFoundError(`No se encontró la orden de salida original: ${ref}`);

    const lines: ReturnLine[] = original.lines.map((l, i) => ({
      lineNo: i + 1,
      sku: l.sku,
      expectedQty: l.qty,
      toStock: 0,
      toMerma: 0,
      toQuarantine: 0,
      note: null,
    }));

    const ret: ReturnOrder = {
      id: this.genCode(),
      sellerId,
      originalOrderId: original.id,
      originalOrderRef: original.externalOrderId,
      reason: input.reason ?? null,
      status: ReturnStatus.PENDING,
      lines,
      createdAt: this.clock.now(),
      events: [this.ev('CREATED', actor, `Enlazada a la orden ${original.externalOrderId} · ${lines.length} línea(s)`)],
    };
    await this.returns.save(ret);
    return ret;
  }

  /** Resuelve (creando si faltan) las ubicaciones de stock, merma y cuarentena. */
  private async resolveReturnLocations(seller: Seller): Promise<{ stock: string; merma: string; cuarentena: string }> {
    const locs = await this.locations.listByOperation(seller.operationId);
    const active = locs.filter((l) => l.active !== false);
    // Stock disponible: preferimos una ubicación de almacenaje (pickeable).
    const stockLoc =
      active.find((l) => l.zoneType === ZoneType.STORAGE) ||
      active.find((l) => l.zoneType === ZoneType.RECEIVING) ||
      active[0];
    if (!stockLoc) throw new ValidationError('No hay ubicaciones en la operación para ingresar la devolución.');
    const warehouseId = stockLoc.warehouseId || 'PRINCIPAL';

    const ensure = async (code: string): Promise<string> => {
      const existing = await this.locations.findByCode(seller.operationId, code);
      if (existing) return existing.id;
      const loc: Location = {
        id: this.ids.next(),
        operationId: seller.operationId,
        warehouseId,
        code,
        zoneType: ZoneType.QUARANTINE,
        capacity: 0,
        pickRank: 99,
        active: true,
      };
      await this.locations.save(loc);
      return loc.id;
    };

    return {
      stock: stockLoc.id,
      merma: await ensure(MERMA_CODE),
      cuarentena: await ensure(CUARENTENA_CODE),
    };
  }

  /**
   * Registra el QA de la devolución: por cada SKU, dispone las unidades recibidas
   * a stock / merma / cuarentena y las ingresa al inventario. Admite parcial y
   * líneas comodín (SKU no presente en la orden original).
   */
  async process(sellerId: string, returnId: string, input: ProcessReturnInput, actor?: string): Promise<ReturnOrder> {
    const seller = await this.assertSeller(sellerId);
    const ret = await this.mustGet(sellerId, returnId);
    if (ret.status === ReturnStatus.COMPLETED || ret.status === ReturnStatus.CANCELLED) {
      throw new ValidationError(`La devolución ${returnId} ya está ${ret.status} y no se puede procesar.`);
    }
    if (!input.lines || input.lines.length === 0) {
      throw new ValidationError('Indica al menos una línea con cantidades a disponer.');
    }

    const loc = await this.resolveReturnLocations(seller);
    let anyPosted = false;
    let nextLineNo = ret.lines.reduce((m, l) => Math.max(m, l.lineNo), 0);

    for (const inLine of input.lines) {
      const sku = (inLine.sku || '').trim();
      if (!sku) continue;
      const toStock = Math.max(0, Math.floor(Number(inLine.toStock) || 0));
      const toMerma = Math.max(0, Math.floor(Number(inLine.toMerma) || 0));
      const toQuar = Math.max(0, Math.floor(Number(inLine.toQuarantine) || 0));
      if (toStock + toMerma + toQuar === 0) continue; // nada que disponer en esta línea

      const skuRec = await this.skus.find(sellerId, sku);
      if (!skuRec) throw new NotFoundError(`SKU no encontrado para el seller ${sellerId}: ${sku}`);

      // Ingreso al inventario según disposición.
      const reference = `DEV:${ret.id}`;
      if (toStock > 0) await this.inventory.postReturn(sellerId, { sku, qty: toStock, state: StockState.AVAILABLE, locationId: loc.stock, reference, actor });
      if (toMerma > 0) await this.inventory.postReturn(sellerId, { sku, qty: toMerma, state: StockState.DAMAGED, locationId: loc.merma, reference, actor });
      if (toQuar > 0) await this.inventory.postReturn(sellerId, { sku, qty: toQuar, state: StockState.QUARANTINE, locationId: loc.cuarentena, reference, actor });
      anyPosted = true;

      // Acumula en la línea existente o crea una línea comodín.
      let line = ret.lines.find((l) => l.sku === sku);
      if (!line) {
        line = { lineNo: ++nextLineNo, sku, expectedQty: 0, toStock: 0, toMerma: 0, toQuarantine: 0, note: inLine.note ?? null };
        ret.lines.push(line);
      }
      line.toStock += toStock;
      line.toMerma += toMerma;
      line.toQuarantine += toQuar;
      if (inLine.note) line.note = inLine.note;
    }

    if (!anyPosted) throw new ValidationError('No se dispuso ninguna unidad. Indica cantidades a stock, merma o cuarentena.');

    const totStock = ret.lines.reduce((s, l) => s + l.toStock, 0);
    const totMerma = ret.lines.reduce((s, l) => s + l.toMerma, 0);
    const totQuar = ret.lines.reduce((s, l) => s + l.toQuarantine, 0);
    const close = input.close !== false;
    ret.status = close ? ReturnStatus.COMPLETED : ReturnStatus.PARTIAL;
    ret.events.push(
      this.ev(close ? 'COMPLETED' : 'PROCESSED', actor, `Stock ${totStock} · Merma ${totMerma} · Cuarentena ${totQuar}`),
    );
    await this.returns.save(ret);
    return ret;
  }

  async cancel(sellerId: string, returnId: string, actor?: string): Promise<ReturnOrder> {
    const ret = await this.mustGet(sellerId, returnId);
    if (ret.status === ReturnStatus.COMPLETED) {
      throw new ValidationError('No se puede anular una devolución ya completada.');
    }
    const processed = ret.lines.some((l) => l.toStock + l.toMerma + l.toQuarantine > 0);
    if (processed) {
      throw new ValidationError('La devolución ya tiene unidades ingresadas; no se puede anular.');
    }
    ret.status = ReturnStatus.CANCELLED;
    ret.events.push(this.ev('CANCELLED', actor));
    await this.returns.save(ret);
    return ret;
  }

  async get(sellerId: string, returnId: string): Promise<ReturnOrder | null> {
    return this.returns.findById(sellerId, returnId);
  }

  async list(sellerId: string): Promise<ReturnOrder[]> {
    const rows = await this.returns.list(sellerId);
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}
