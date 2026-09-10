/**
 * ProductService — Mantenedor de productos/SKUs del seller.
 *
 * Crea, edita, activa/desactiva SKUs; gestiona niveles de empaque (EAN/DUN/pallet)
 * y KITS (SKU compuesto por otros SKUs):
 *   - VIRTUAL   → no tiene stock propio; se explota en sus componentes al reservar
 *                 una orden (lo maneja OrderService).
 *   - ASSEMBLED → tiene stock propio; se ARMA en bodega (assembleKit) consumiendo
 *                 el stock de sus componentes y produciendo stock del kit.
 *
 * Cada cambio queda en un historial auditable (ProductLog), visible para el cliente
 * y para operaciones. El acceso lo controla el permiso `product:manage` (cliente
 * acotado a su seller + staff de operación).
 */
import { InsufficientStockError, NotFoundError, ValidationError } from './errors';
import { InventoryService } from './inventory.service';
import { BarcodeService, RegisterPackInput } from './barcode.service';
import {
  AssemblyLogRepository,
  Clock,
  IdGenerator,
  ProductLogRepository,
  SellerRepository,
  SkuRepository,
} from './ports';
import {
  AssemblyRecord,
  KitComponent,
  KitMode,
  PackConfig,
  ProductLogEntry,
  RotationClass,
  Sku,
  StockState,
} from './types';

export interface ProductInput {
  sku: string;
  description: string;
  barcode?: string | null;
  lotControlled?: boolean;
  serialControlled?: boolean;
  expiryControlled?: boolean;
  rotationClass?: RotationClass;
  active?: boolean;
  isKit?: boolean;
  kitMode?: KitMode | null;
  components?: KitComponent[];
}

export interface ProductPatch {
  description?: string;
  barcode?: string | null;
  lotControlled?: boolean;
  serialControlled?: boolean;
  expiryControlled?: boolean;
  rotationClass?: RotationClass;
  active?: boolean;
  isKit?: boolean;
  kitMode?: KitMode | null;
  components?: KitComponent[];
}

export class ProductService {
  constructor(
    private readonly skus: SkuRepository,
    private readonly logs: ProductLogRepository,
    private readonly sellers: SellerRepository,
    private readonly inventory: InventoryService,
    private readonly barcodes: BarcodeService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly assemblies: AssemblyLogRepository,
  ) {}

  private async assertSeller(sellerId: string) {
    const s = await this.sellers.findById(sellerId);
    if (!s) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    if (!s.active) throw new ValidationError(`Seller inactivo: ${sellerId}`);
    return s;
  }

  private async log(sellerId: string, sku: string, actor: string | undefined, action: string, detail?: string | null) {
    await this.logs.append({
      id: this.ids.next(),
      sellerId,
      sku,
      at: this.clock.now(),
      actor: actor || 'system',
      action,
      detail: detail ?? null,
    });
  }

  /** Valida y normaliza los campos de kit. Devuelve los tres campos listos para guardar. */
  private async normalizeKit(
    sellerId: string,
    isKit: boolean,
    kitMode: KitMode | null,
    components: KitComponent[] | undefined,
    selfSku: string,
  ): Promise<{ isKit: boolean; kitMode: KitMode | null; components: KitComponent[] }> {
    if (!isKit) return { isKit: false, kitMode: null, components: [] };
    if (kitMode !== KitMode.VIRTUAL && kitMode !== KitMode.ASSEMBLED) {
      throw new ValidationError('Un kit debe declarar su modo: virtual o armado');
    }
    const list = components ?? [];
    if (list.length === 0) throw new ValidationError('Un kit debe tener al menos un componente');
    const out: KitComponent[] = [];
    for (const c of list) {
      if (!c.sku) throw new ValidationError('Hay un componente sin SKU');
      if (c.sku === selfSku) throw new ValidationError('Un kit no puede contenerse a sí mismo');
      if (!(c.qty > 0)) throw new ValidationError(`Cantidad inválida en el componente ${c.sku}`);
      const cs = await this.skus.find(sellerId, c.sku);
      if (!cs) throw new NotFoundError(`El componente no existe: ${c.sku}`);
      if (cs.isKit) throw new ValidationError(`El componente ${c.sku} es un kit; no se permiten kits dentro de kits`);
      out.push({ sku: c.sku, qty: c.qty });
    }
    return { isKit: true, kitMode, components: out };
  }

  private summary(sku: Sku): string {
    if (sku.isKit) return `${sku.description} · kit ${sku.kitMode} (${sku.components.length} comp.)`;
    return sku.description;
  }

  async create(sellerId: string, input: ProductInput, actor?: string): Promise<Sku> {
    await this.assertSeller(sellerId);
    if (!input.sku || !input.sku.trim()) throw new ValidationError('El código SKU es obligatorio');
    if (!input.description || !input.description.trim()) throw new ValidationError('La descripción es obligatoria');
    if (await this.skus.find(sellerId, input.sku)) throw new ValidationError(`Ya existe el SKU ${input.sku} en este cliente`);
    const kit = await this.normalizeKit(sellerId, !!input.isKit, input.kitMode ?? null, input.components, input.sku);
    const sku: Sku = {
      sellerId,
      sku: input.sku,
      description: input.description,
      barcode: input.barcode ?? null,
      lotControlled: input.lotControlled ?? false,
      serialControlled: input.serialControlled ?? false,
      expiryControlled: input.expiryControlled ?? false,
      rotationClass: input.rotationClass ?? RotationClass.B,
      active: input.active ?? true,
      ...kit,
    };
    await this.skus.save(sku);
    if (sku.barcode) {
      await this.barcodes.registerPack(sellerId, { sku: sku.sku, code: 'EA', barcode: sku.barcode, factor: 1, label: 'Unidad (EAN)' });
    }
    await this.log(sellerId, sku.sku, actor, 'CREADO', this.summary(sku));
    return sku;
  }

  async update(sellerId: string, skuCode: string, patch: ProductPatch, actor?: string): Promise<Sku> {
    await this.assertSeller(sellerId);
    const cur = await this.skus.find(sellerId, skuCode);
    if (!cur) throw new NotFoundError(`SKU no encontrado: ${skuCode}`);
    const isKit = patch.isKit != null ? patch.isKit : cur.isKit;
    const kitMode = patch.kitMode !== undefined ? patch.kitMode : cur.kitMode;
    const components = patch.components !== undefined ? patch.components : cur.components;
    const kit = await this.normalizeKit(sellerId, isKit, kitMode, components, skuCode);
    const next: Sku = {
      ...cur,
      description: patch.description ?? cur.description,
      barcode: patch.barcode !== undefined ? patch.barcode : cur.barcode,
      lotControlled: patch.lotControlled != null ? patch.lotControlled : cur.lotControlled,
      serialControlled: patch.serialControlled != null ? patch.serialControlled : cur.serialControlled,
      expiryControlled: patch.expiryControlled != null ? patch.expiryControlled : cur.expiryControlled,
      rotationClass: patch.rotationClass ?? cur.rotationClass,
      active: patch.active != null ? patch.active : cur.active,
      ...kit,
    };
    await this.skus.save(next);
    if (next.barcode && next.barcode !== cur.barcode) {
      await this.barcodes.registerPack(sellerId, { sku: next.sku, code: 'EA', barcode: next.barcode, factor: 1, label: 'Unidad (EAN)' });
    }
    if (patch.active != null && patch.active !== cur.active) {
      await this.log(sellerId, next.sku, actor, patch.active ? 'ACTIVADO' : 'DESACTIVADO', this.summary(next));
    } else {
      await this.log(sellerId, next.sku, actor, 'EDITADO', this.summary(next));
    }
    return next;
  }

  async setActive(sellerId: string, skuCode: string, active: boolean, actor?: string): Promise<Sku> {
    return this.update(sellerId, skuCode, { active }, actor);
  }

  /** Registra un nivel de empaque (EAN/DUN/pallet) y lo deja en el historial. */
  async registerPack(sellerId: string, input: RegisterPackInput, actor?: string): Promise<PackConfig> {
    await this.assertSeller(sellerId);
    const pack = await this.barcodes.registerPack(sellerId, input);
    await this.log(sellerId, input.sku, actor, 'PACK', `${input.code} · ${input.barcode} · x${input.factor}`);
    return pack;
  }

  /**
   * Plan sugerido (greedy) de extracción para armar `qty` de un kit: por cada componente,
   * de qué ubicaciones/lotes tomar. NO se usa para ejecutar el armado (eso lo confirma el
   * usuario eligiendo ubicaciones); sirve para poblar la demo y como referencia.
   */
  async planAssemblySources(
    sellerId: string,
    kitSku: string,
    qty: number,
  ): Promise<{ sku: string; locationId: string; lot: string | null; qty: number }[]> {
    const kit = await this.skus.find(sellerId, kitSku);
    if (!kit || !kit.isKit) throw new NotFoundError(`Kit no encontrado: ${kitSku}`);
    const sources: { sku: string; locationId: string; lot: string | null; qty: number }[] = [];
    for (const c of kit.components) {
      let remaining = c.qty * qty;
      const buckets = (await this.inventory.getStock({ sellerId, sku: c.sku }))
        .filter((b) => b.state === StockState.AVAILABLE && b.qty > 0);
      for (const b of buckets) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, b.qty);
        sources.push({ sku: c.sku, locationId: b.locationId, lot: b.lot ?? null, qty: take });
        remaining -= take;
      }
    }
    return sources;
  }

  /**
   * Arma `qty` unidades de un kit ASSEMBLED. El usuario indica EXPLÍCITAMENTE de qué
   * ubicación (y lote) sale cada componente vía `sources`; el sistema no asume el origen.
   * Consume exactamente esas extracciones y produce el stock del kit en `toLocationId`.
   */
  async assembleKit(
    sellerId: string,
    cmd: {
      kitSku: string;
      qty: number;
      toLocationId: string;
      sources: { sku: string; locationId: string; lot?: string | null; qty: number }[];
    },
    actor?: string,
  ): Promise<Sku> {
    await this.assertSeller(sellerId);
    const kit = await this.skus.find(sellerId, cmd.kitSku);
    if (!kit) throw new NotFoundError(`SKU no encontrado: ${cmd.kitSku}`);
    if (!kit.isKit) throw new ValidationError(`${cmd.kitSku} no es un kit`);
    if (kit.kitMode !== KitMode.ASSEMBLED) {
      throw new ValidationError('Solo los kits de tipo "armado" tienen stock propio; un kit virtual se explota en la orden');
    }
    if (!(cmd.qty > 0)) throw new ValidationError('La cantidad a armar debe ser positiva');
    if (!cmd.toLocationId) throw new ValidationError('Debes indicar la ubicación destino del kit');
    const sources = cmd.sources ?? [];

    // Requerido por componente y validación de que las extracciones elegidas cuadran EXACTO.
    const required: Record<string, number> = {};
    for (const c of kit.components) required[c.sku] = c.qty * cmd.qty;
    const provided: Record<string, number> = {};
    for (const s of sources) {
      if (!(s.qty > 0)) throw new ValidationError('Cantidad de extracción inválida en una ubicación');
      if (required[s.sku] == null) throw new ValidationError(`El SKU ${s.sku} no es un componente de ${cmd.kitSku}`);
      provided[s.sku] = (provided[s.sku] || 0) + s.qty;
    }
    for (const compSku of Object.keys(required)) {
      if ((provided[compSku] || 0) !== required[compSku]) {
        throw new ValidationError(
          `Debes asignar exactamente ${required[compSku]} de ${compSku} eligiendo ubicaciones (asignado ${provided[compSku] || 0})`,
        );
      }
    }
    // Cada extracción debe existir en su ubicación/lote (no se asume nada).
    for (const s of sources) {
      const avail = await this.inventory.availableAt(sellerId, s.sku, s.locationId, s.lot ?? null);
      if (avail < s.qty) {
        throw new InsufficientStockError(
          `Disponible ${avail} de ${s.sku} en la ubicación indicada; intentas tomar ${s.qty}`,
        );
      }
    }

    const ref = `ARMADO ${cmd.kitSku}`;
    // Consumir exactamente las extracciones elegidas por el usuario.
    for (const s of sources) {
      await this.inventory.adjust(sellerId, { sku: s.sku, locationId: s.locationId, lot: s.lot ?? null, qtyDelta: -s.qty, reference: ref, actor });
    }
    // Producir el kit en la ubicación destino.
    await this.inventory.adjust(sellerId, { sku: cmd.kitSku, locationId: cmd.toLocationId, qtyDelta: cmd.qty, reference: ref, actor });
    await this.log(
      sellerId,
      cmd.kitSku,
      actor,
      'ARMADO',
      `Armados ${cmd.qty} · consumió ${kit.components.map((c) => `${c.sku} x${c.qty * cmd.qty}`).join(', ')}`,
    );
    // Registro auditable del armado (con las ubicaciones de extracción y el destino).
    await this.assemblies.append({
      id: this.ids.next(),
      sellerId,
      kitSku: cmd.kitSku,
      qty: cmd.qty,
      toLocationId: cmd.toLocationId,
      sources: sources.map((s) => ({ sku: s.sku, locationId: s.locationId, lot: s.lot ?? null, qty: s.qty })),
      actor: actor || 'system',
      at: this.clock.now(),
    });
    return (await this.skus.find(sellerId, cmd.kitSku))!;
  }

  listAssemblies(sellerId: string): Promise<AssemblyRecord[]> {
    return this.assemblies.list(sellerId);
  }

  listSkus(sellerId: string): Promise<Sku[]> {
    return this.skus.list(sellerId);
  }
  getSku(sellerId: string, sku: string): Promise<Sku | null> {
    return this.skus.find(sellerId, sku);
  }
  listLog(sellerId: string, sku?: string): Promise<ProductLogEntry[]> {
    return this.logs.list(sellerId, sku);
  }
}
