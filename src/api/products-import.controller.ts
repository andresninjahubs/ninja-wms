import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { ImportFileDto } from './dto';
import { RotationClass, Sku, User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Carga/edición masiva de PRODUCTOS por Excel, con exportación y confirmación.
 *   GET  /sellers/:id/product-import/export    -> descarga los productos en .xlsx
 *   GET  /sellers/:id/product-import/template  -> descarga la plantilla en blanco
 *   POST /sellers/:id/product-import/preview   -> NO escribe: devuelve el plan (nuevos + cambios)
 *   POST /sellers/:id/product-import/commit    -> aplica (crea y edita)
 *
 * Ruta separada ('product-import') para no chocar con la ruta :sku de productos.
 */

const HEADERS = [
  'SKU',
  'Descripción',
  'Código de barras (EAN)',
  'Lote controlado (si/no)',
  'Serie controlada (si/no)',
  'Vencimiento controlado (si/no)',
  'Rotación (A/B/C)',
  'Activo (si/no)',
];

const INSTRUCTIONS = [
  ['Cómo usar esta plantilla'],
  [''],
  ['1) Una fila por producto. La columna SKU es la clave.'],
  ['2) Si el SKU NO existe, se crea (la Descripción es obligatoria para productos nuevos).'],
  ['3) Si el SKU YA existe, se edita: antes de guardar verás qué atributos cambian y deberás confirmar.'],
  ['4) En productos existentes, una celda vacía significa "no cambiar ese campo" (no lo borra).'],
  ['5) "Lote controlado", "Serie controlada", "Vencimiento controlado" y "Activo": escribe si / no. "Rotación": A, B o C.'],
  ['   "Serie controlada = si" pide el N° de serie de cada unidad en la recepción; "Lote/Vencimiento controlado = si" los vuelven obligatorios al recepcionar.'],
  ['6) No cambies los nombres de las columnas de la hoja "Productos".'],
];

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}
function headerToField(h: unknown): string | null {
  const n = norm(h);
  if (!n) return null;
  if (n === 'sku' || n.includes('sku')) return 'sku';
  if (n.includes('descrip')) return 'description';
  if (n.includes('barra') || n.includes('ean') || n.includes('barcode')) return 'barcode';
  // "serie" antes que "lote": ambas empiezan por control...; se distinguen por palabra.
  if (n.includes('serie') || n.includes('serial')) return 'serialControlled';
  if (n.includes('vencimiento') || n.includes('caducidad') || n.includes('expir')) return 'expiryControlled';
  if (n.includes('lote')) return 'lotControlled';
  if (n.includes('rotacion') || n.includes('clase')) return 'rotationClass';
  if (n.includes('activo') || n.includes('estado')) return 'active';
  return null;
}
// "si/no" -> boolean; vacío -> undefined (no cambiar).
function parseBool(v: string): boolean | undefined | 'INVALID' {
  const n = norm(v);
  if (!n) return undefined;
  if (['si', 'strue', 'true', '1', 'verdadero', 'x', 'activo', 'yes'].includes(n)) return true;
  if (['no', 'false', '0', 'falso', 'inactivo'].includes(n)) return false;
  return 'INVALID';
}
function parseRotation(v: string): RotationClass | undefined | 'INVALID' {
  const n = norm(v);
  if (!n) return undefined;
  if (n === 'a') return RotationClass.A;
  if (n === 'b') return RotationClass.B;
  if (n === 'c') return RotationClass.C;
  return 'INVALID';
}
const boolTxt = (b: boolean) => (b ? 'Sí' : 'No');

interface PlanChange { campo: string; de: string; a: string; }
interface PlanUpdate { sku: string; changes: PlanChange[]; patch: Record<string, unknown>; }
interface PlanCreate { sku: string; description: string; barcode: string | null; lotControlled: boolean; serialControlled: boolean; expiryControlled: boolean; rotationClass: RotationClass; active: boolean; }
interface Plan {
  toCreate: PlanCreate[];
  toUpdate: PlanUpdate[];
  unchanged: string[];
  errors: { fila: number; motivo: string }[];
}

@Controller('sellers/:sellerId/product-import')
export class ProductsImportController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  private async buildPlan(sellerId: string, dataBase64: string): Promise<Plan | { error: string }> {
    let rows: unknown[][];
    try {
      const buf = Buffer.from(dataBase64, 'base64');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheetName = wb.SheetNames.find((n) => norm(n).includes('producto')) || wb.SheetNames[0];
      rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: '' }) as unknown[][];
    } catch (e) {
      return { error: `No se pudo leer el archivo: ${(e as Error).message}` };
    }
    if (!rows.length) return { error: 'El archivo está vacío.' };

    const colOf: Record<string, number> = {};
    (rows[0] as unknown[]).forEach((h, i) => { const f = headerToField(h); if (f && colOf[f] === undefined) colOf[f] = i; });
    if (colOf['sku'] === undefined) return { error: 'No se reconoce la columna SKU. Usa la plantilla oficial.' };
    const cell = (row: unknown[], f: string): string => (colOf[f] === undefined ? '' : String(row[colOf[f]] ?? '').trim());

    const existing = await this.wms.listSkus(sellerId);
    const bySku = new Map<string, Sku>(existing.map((s) => [s.sku, s]));

    const plan: Plan = { toCreate: [], toUpdate: [], unchanged: [], errors: [] };
    const seen = new Set<string>();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const fila = i + 1;
      const sku = cell(row, 'sku');
      const description = cell(row, 'description');
      const barcodeRaw = cell(row, 'barcode');
      const lotRaw = cell(row, 'lotControlled');
      const serRaw = cell(row, 'serialControlled');
      const expRaw = cell(row, 'expiryControlled');
      const rotRaw = cell(row, 'rotationClass');
      const actRaw = cell(row, 'active');
      if (!sku && !description && !barcodeRaw && !lotRaw && !serRaw && !expRaw && !rotRaw && !actRaw) continue; // fila vacía
      if (!sku) { plan.errors.push({ fila, motivo: 'Falta el SKU.' }); continue; }
      if (seen.has(sku)) { plan.errors.push({ fila, motivo: `SKU repetido en el archivo: ${sku}.` }); continue; }
      seen.add(sku);

      const lot = parseBool(lotRaw);
      if (lot === 'INVALID') { plan.errors.push({ fila, motivo: `Orden ${sku}: "Lote controlado" inválido ("${lotRaw}"). Usa si/no.` }); continue; }
      const ser = parseBool(serRaw);
      if (ser === 'INVALID') { plan.errors.push({ fila, motivo: `${sku}: "Serie controlada" inválida ("${serRaw}"). Usa si/no.` }); continue; }
      const exp = parseBool(expRaw);
      if (exp === 'INVALID') { plan.errors.push({ fila, motivo: `${sku}: "Vencimiento controlado" inválido ("${expRaw}"). Usa si/no.` }); continue; }
      const act = parseBool(actRaw);
      if (act === 'INVALID') { plan.errors.push({ fila, motivo: `${sku}: "Activo" inválido ("${actRaw}"). Usa si/no.` }); continue; }
      const rot = parseRotation(rotRaw);
      if (rot === 'INVALID') { plan.errors.push({ fila, motivo: `${sku}: "Rotación" inválida ("${rotRaw}"). Usa A, B o C.` }); continue; }

      const cur = bySku.get(sku);
      if (!cur) {
        if (!description) { plan.errors.push({ fila, motivo: `${sku}: es un producto NUEVO y falta la Descripción.` }); continue; }
        plan.toCreate.push({
          sku,
          description,
          barcode: barcodeRaw || null,
          lotControlled: lot === undefined ? false : lot,
          serialControlled: ser === undefined ? false : ser,
          expiryControlled: exp === undefined ? false : exp,
          rotationClass: rot ?? RotationClass.B,
          active: act === undefined ? true : act,
        });
      } else {
        const changes: PlanChange[] = [];
        const patch: Record<string, unknown> = {};
        if (description && description !== cur.description) { changes.push({ campo: 'Descripción', de: cur.description, a: description }); patch.description = description; }
        if (barcodeRaw && barcodeRaw !== (cur.barcode || '')) { changes.push({ campo: 'EAN', de: cur.barcode || '—', a: barcodeRaw }); patch.barcode = barcodeRaw; }
        if (lot !== undefined && lot !== cur.lotControlled) { changes.push({ campo: 'Lote controlado', de: boolTxt(cur.lotControlled), a: boolTxt(lot) }); patch.lotControlled = lot; }
        if (ser !== undefined && ser !== cur.serialControlled) { changes.push({ campo: 'Serie controlada', de: boolTxt(cur.serialControlled), a: boolTxt(ser) }); patch.serialControlled = ser; }
        if (exp !== undefined && exp !== cur.expiryControlled) { changes.push({ campo: 'Vencimiento controlado', de: boolTxt(cur.expiryControlled), a: boolTxt(exp) }); patch.expiryControlled = exp; }
        if (rot !== undefined && rot !== cur.rotationClass) { changes.push({ campo: 'Rotación', de: cur.rotationClass, a: rot }); patch.rotationClass = rot; }
        if (act !== undefined && act !== cur.active) { changes.push({ campo: 'Activo', de: boolTxt(cur.active), a: boolTxt(act) }); patch.active = act; }
        if (changes.length) plan.toUpdate.push({ sku, changes, patch });
        else plan.unchanged.push(sku);
      }
    }
    return plan;
  }

  @Get('export')
  @RequirePermission('stock:read')
  async export(@Param('sellerId') sellerId: string, @Res() res: Response) {
    const skus = await this.wms.listSkus(sellerId);
    const rows = [HEADERS, ...skus.map((s) => [s.sku, s.description, s.barcode || '', s.lotControlled ? 'si' : 'no', s.serialControlled ? 'si' : 'no', s.expiryControlled ? 'si' : 'no', s.rotationClass, s.active ? 'si' : 'no'])];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 16 }, { wch: 36 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Productos');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="productos-ninjawms.xlsx"');
    res.send(buf);
  }

  @Get('template')
  @RequirePermission('product:manage')
  template(@Res() res: Response) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([HEADERS, ['SKU-EJEMPLO-1', 'Producto de ejemplo', '7801234500017', 'no', 'no', 'no', 'B', 'si']]);
    ws['!cols'] = [{ wch: 16 }, { wch: 36 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Productos');
    const wsi = XLSX.utils.aoa_to_sheet(INSTRUCTIONS);
    wsi['!cols'] = [{ wch: 92 }];
    XLSX.utils.book_append_sheet(wb, wsi, 'Instrucciones');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-productos-ninjawms.xlsx"');
    res.send(buf);
  }

  /** Previsualiza: NO escribe nada. Devuelve nuevos, cambios (con diff) y errores. */
  @Post('preview')
  @RequirePermission('product:manage')
  async preview(@Param('sellerId') sellerId: string, @Body() dto: ImportFileDto) {
    const plan = await this.buildPlan(sellerId, dto.dataBase64);
    if ('error' in plan) return { ok: false, error: plan.error };
    return {
      ok: true,
      resumen: {
        nuevos: plan.toCreate.length,
        modificar: plan.toUpdate.length,
        sinCambios: plan.unchanged.length,
        errores: plan.errors.length,
      },
      toCreate: plan.toCreate.map((c) => ({ sku: c.sku, description: c.description })),
      toUpdate: plan.toUpdate.map((u) => ({ sku: u.sku, changes: u.changes })),
      errors: plan.errors,
    };
  }

  /** Confirma: aplica la creación y edición. El frontend solo lo llama tras el VB del usuario. */
  @Post('commit')
  @RequirePermission('product:manage')
  async commit(@Param('sellerId') sellerId: string, @Body() dto: ImportFileDto, @CurrentUser() user: User | null) {
    const plan = await this.buildPlan(sellerId, dto.dataBase64);
    if ('error' in plan) return { ok: false, error: plan.error };
    const actor = actorOf(user);
    const creados: string[] = [];
    const modificados: string[] = [];
    const errores: { sku: string; motivo: string }[] = [];
    for (const c of plan.toCreate) {
      try {
        await this.wms.createProduct(sellerId, { sku: c.sku, description: c.description, barcode: c.barcode, lotControlled: c.lotControlled, serialControlled: c.serialControlled, expiryControlled: c.expiryControlled, rotationClass: c.rotationClass, active: c.active }, actor);
        creados.push(c.sku);
      } catch (e) { errores.push({ sku: c.sku, motivo: (e as Error).message }); }
    }
    for (const u of plan.toUpdate) {
      try {
        await this.wms.updateProduct(sellerId, u.sku, u.patch as any, actor);
        modificados.push(u.sku);
      } catch (e) { errores.push({ sku: u.sku, motivo: (e as Error).message }); }
    }
    return {
      ok: true,
      resumen: { creados: creados.length, modificados: modificados.length, errores: errores.length, sinCambios: plan.unchanged.length },
      creados, modificados, errores,
    };
  }
}
