/**
 * BarcodeService — códigos de barra / QR y conversión de unidades de medida.
 *
 * Un mismo SKU tiene varios niveles de empaque, cada uno con su PROPIO código:
 * la unidad (EAN), la caja master (DUN), el pallet, etc. Cada nivel guarda un
 * `factor` = cuántas unidades base representa. Al escanear, el sistema traduce
 * el código a (SKU, unidad, múltiplos del EAN) y el inventario se lleva SIEMPRE
 * en unidades base, para que el stock cuadre sin ambigüedad.
 */
import { NotFoundError, ValidationError } from './errors';
import { PackRepository, SellerRepository, SkuRepository } from './ports';
import { PackConfig, ScanResult } from './types';

export interface RegisterPackInput {
  sku: string;
  code: string; // 'EA' | 'CASE' | 'PALLET' | ...
  barcode: string;
  factor: number; // unidades base por pack (EA = 1)
  label?: string;
}

export class BarcodeService {
  constructor(
    private readonly packs: PackRepository,
    private readonly skus: SkuRepository,
    private readonly sellers: SellerRepository,
  ) {}

  /** Registra (o actualiza) un nivel de empaque con su código de barras. */
  async registerPack(sellerId: string, input: RegisterPackInput): Promise<PackConfig> {
    await this.assertSellerSku(sellerId, input.sku);
    if (!(input.factor > 0) || !Number.isInteger(input.factor)) {
      throw new ValidationError(`El factor debe ser un entero positivo: ${input.factor}`);
    }
    const barcode = input.barcode.trim();
    if (!barcode) throw new ValidationError('El código de barras no puede estar vacío');

    // Un código de barras identifica un único (SKU, nivel) dentro del seller.
    const clash = await this.packs.findByBarcode(sellerId, barcode);
    if (clash && (clash.sku !== input.sku || clash.code !== input.code)) {
      throw new ValidationError(
        `El código ${barcode} ya está asignado a ${clash.sku}/${clash.code} en este seller`,
      );
    }

    const pack: PackConfig = {
      sellerId,
      sku: input.sku,
      code: input.code,
      label: input.label ?? input.code,
      barcode,
      factor: input.factor,
      isBase: input.factor === 1,
    };
    await this.packs.upsert(pack);
    return pack;
  }

  async listPacks(sellerId: string, sku: string): Promise<PackConfig[]> {
    await this.assertSellerSku(sellerId, sku);
    return this.packs.listBySku(sellerId, sku);
  }

  /** Resuelve un código escaneado al nivel de empaque correspondiente. */
  async resolve(sellerId: string, barcode: string): Promise<PackConfig> {
    const pack = await this.packs.findByBarcode(sellerId, barcode.trim());
    if (!pack) {
      throw new NotFoundError(`Código no reconocido para el seller ${sellerId}: ${barcode}`);
    }
    return pack;
  }

  /**
   * Traduce N packs escaneados a unidades base (múltiplos del EAN).
   * Ej: escanear 2 cajas (DUN, factor 12) -> baseQty 24.
   */
  async toBaseUnits(sellerId: string, barcode: string, packCount: number): Promise<ScanResult> {
    if (!(packCount > 0) || !Number.isInteger(packCount)) {
      throw new ValidationError(`La cantidad de packs debe ser un entero positivo: ${packCount}`);
    }
    const pack = await this.resolve(sellerId, barcode);
    return {
      sellerId,
      sku: pack.sku,
      code: pack.code,
      label: pack.label,
      factor: pack.factor,
      packCount,
      baseQty: packCount * pack.factor,
    };
  }

  private async assertSellerSku(sellerId: string, sku: string): Promise<void> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    const found = await this.skus.find(sellerId, sku);
    if (!found) throw new NotFoundError(`SKU no encontrado para el seller ${sellerId}: ${sku}`);
  }
}
