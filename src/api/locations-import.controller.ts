import { Body, Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { WmsFacade } from '../app/wms.facade';
import { actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { ImportFileDto } from './dto';
import { Location, User, ZoneType } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Carga/edición masiva de UBICACIONES por Excel, con plantilla, exportación,
 * previsualización y confirmación (mismo patrón que la carga de productos).
 *   GET  /operations/:id/location-import/export    -> descarga las ubicaciones en .xlsx
 *   GET  /operations/:id/location-import/template  -> plantilla en blanco
 *   POST /operations/:id/location-import/preview   -> NO escribe: devuelve el plan
 *   POST /operations/:id/location-import/commit    -> aplica (crea y edita)
 *
 * Las ubicaciones son de la OPERACIÓN (no del cliente). El código es la clave:
 * si existe se edita, si no se crea.
 */

const HEADERS = ['Código', 'Zona', 'Bodega', 'Capacidad (unidades)', 'Cercanía a picking', 'Activa (si/no)'];

const ZONE_LABEL: Record<ZoneType, string> = {
  [ZoneType.RECEIVING]: 'Recepción',
  [ZoneType.STORAGE]: 'Almacenaje',
  [ZoneType.PICKING]: 'Picking',
  [ZoneType.SHIPPING]: 'Despacho',
  [ZoneType.QUARANTINE]: 'Cuarentena',
};

const INSTRUCTIONS = [
  ['Cómo usar esta plantilla'],
  [''],
  ['1) Una fila por ubicación. La columna Código es la clave (es el código que se pistolea, p.ej. A-01-1-A).'],
  ['2) Si el Código NO existe en la operación, la ubicación se crea (la Zona es obligatoria para ubicaciones nuevas).'],
  ['3) Si el Código YA existe, se edita: antes de guardar verás qué atributos cambian y deberás confirmar.'],
  ['4) En ubicaciones existentes, una celda vacía significa "no cambiar ese campo".'],
  ['5) Zona: Recepción, Almacenaje, Picking, Despacho o Cuarentena (también se aceptan RECEIVING, STORAGE, PICKING, SHIPPING, QUARANTINE).'],
  ['6) Capacidad: unidades que caben (0 = sin límite). Cercanía a picking: 1 = más cerca del despacho (mejor para productos de alta rotación).'],
  ['7) Activa: si / no. Una ubicación inactiva no recibe guardado ni picking. Si la dejas vacía, las nuevas quedan activas.'],
  ['8) No cambies los nombres de las columnas de la hoja "Ubicaciones".'],
];

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}
function headerToField(h: unknown): string | null {
  const n = norm(h);
  if (!n) return null;
  if (n.includes('codigo') || n === 'code' || n.includes('ubicacion') || n === 'bin') return 'code';
  if (n.includes('zona') || n.includes('zone') || n.includes('tipo')) return 'zoneType';
  if (n.includes('bodega') || n.includes('warehouse') || n.includes('almacen')) return 'warehouseId';
  if (n.includes('capacidad') || n.includes('capacity')) return 'capacity';
  if (n.includes('cercania') || n.includes('rank') || n.includes('picking') || n.includes('prioridad')) return 'pickRank';
  if (n.includes('activ') || n.includes('estado')) return 'active';
  return null;
}
function parseZone(v: string): ZoneType | undefined | 'INVALID' {
  const n = norm(v);
  if (!n) return undefined;
  if (n.startsWith('recep') || n === 'receiving' || n === 'recv') return ZoneType.RECEIVING;
  if (n.startsWith('almacen') || n === 'storage' || n.startsWith('stock') || n.startsWith('bodega')) return ZoneType.STORAGE;
  if (n.startsWith('pick')) return ZoneType.PICKING;
  if (n.startsWith('despach') || n === 'shipping' || n.startsWith('envio')) return ZoneType.SHIPPING;
  if (n.startsWith('cuarent') || n === 'quarantine') return ZoneType.QUARANTINE;
  return 'INVALID';
}
function parseBool(v: string): boolean | undefined | 'INVALID' {
  const n = norm(v);
  if (!n) return undefined;
  if (['si', 'true', '1', 'verdadero', 'x', 'activa', 'activo', 'yes'].includes(n)) return true;
  if (['no', 'false', '0', 'falso', 'inactiva', 'inactivo'].includes(n)) return false;
  return 'INVALID';
}
function parseIntCell(v: string): number | undefined | 'INVALID' {
  const t = String(v ?? '').trim();
  if (!t) return undefined;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 'INVALID';
  return n;
}
const boolTxt = (b: boolean) => (b ? 'Sí' : 'No');

interface PlanChange { campo: string; de: string; a: string; }
interface PlanUpdate { id: string; code: string; changes: PlanChange[]; patch: Record<string, unknown>; }
interface PlanCreate { code: string; zoneType: ZoneType; warehouseId: string; capacity: number; pickRank: number; active: boolean; }
interface Plan {
  toCreate: PlanCreate[];
  toUpdate: PlanUpdate[];
  unchanged: string[];
  errors: { fila: number; motivo: string }[];
}

@Controller('operations/:operationId/location-import')
export class LocationsImportController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  private async buildPlan(operationId: string, dataBase64: string): Promise<Plan | { error: string }> {
    let rows: unknown[][];
    try {
      const buf = Buffer.from(dataBase64, 'base64');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheetName = wb.SheetNames.find((n) => norm(n).includes('ubicacion')) || wb.SheetNames[0];
      rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: '' }) as unknown[][];
    } catch (e) {
      return { error: `No se pudo leer el archivo: ${(e as Error).message}` };
    }
    if (!rows.length) return { error: 'El archivo está vacío.' };

    const colOf: Record<string, number> = {};
    (rows[0] as unknown[]).forEach((h, i) => { const f = headerToField(h); if (f && colOf[f] === undefined) colOf[f] = i; });
    if (colOf['code'] === undefined) return { error: 'No se reconoce la columna Código. Usa la plantilla oficial.' };
    const cell = (row: unknown[], f: string): string => (colOf[f] === undefined ? '' : String(row[colOf[f]] ?? '').trim());

    const existing = await this.wms.listLocations(operationId);
    const byCode = new Map<string, Location>(existing.map((l) => [l.code.toUpperCase(), l]));

    const plan: Plan = { toCreate: [], toUpdate: [], unchanged: [], errors: [] };
    const seen = new Set<string>();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const fila = i + 1;
      const code = cell(row, 'code');
      const zoneRaw = cell(row, 'zoneType');
      const whRaw = cell(row, 'warehouseId');
      const capRaw = cell(row, 'capacity');
      const rankRaw = cell(row, 'pickRank');
      const actRaw = cell(row, 'active');
      if (!code && !zoneRaw && !whRaw && !capRaw && !rankRaw && !actRaw) continue; // fila vacía
      if (!code) { plan.errors.push({ fila, motivo: 'Falta el Código de la ubicación.' }); continue; }
      if (code.length > 32) { plan.errors.push({ fila, motivo: `${code}: el código supera los 32 caracteres.` }); continue; }
      const key = code.toUpperCase();
      if (seen.has(key)) { plan.errors.push({ fila, motivo: `Código repetido en el archivo: ${code}.` }); continue; }
      seen.add(key);

      const zone = parseZone(zoneRaw);
      if (zone === 'INVALID') { plan.errors.push({ fila, motivo: `${code}: Zona inválida ("${zoneRaw}"). Usa Recepción, Almacenaje, Picking, Despacho o Cuarentena.` }); continue; }
      const cap = parseIntCell(capRaw);
      if (cap === 'INVALID') { plan.errors.push({ fila, motivo: `${code}: Capacidad inválida ("${capRaw}"). Usa un número entero ≥ 0.` }); continue; }
      const rank = parseIntCell(rankRaw);
      if (rank === 'INVALID' || rank === 0) { plan.errors.push({ fila, motivo: `${code}: Cercanía a picking inválida ("${rankRaw}"). Usa un entero ≥ 1.` }); continue; }
      const act = parseBool(actRaw);
      if (act === 'INVALID') { plan.errors.push({ fila, motivo: `${code}: "Activa" inválida ("${actRaw}"). Usa si/no.` }); continue; }

      const cur = byCode.get(key);
      if (!cur) {
        if (!zone) { plan.errors.push({ fila, motivo: `${code}: es una ubicación NUEVA y falta la Zona.` }); continue; }
        plan.toCreate.push({
          code,
          zoneType: zone,
          warehouseId: whRaw || 'W1',
          capacity: cap ?? 0,
          pickRank: rank ?? 1,
          active: act === undefined ? true : act,
        });
      } else {
        const changes: PlanChange[] = [];
        const patch: Record<string, unknown> = {};
        if (zone && zone !== cur.zoneType) { changes.push({ campo: 'Zona', de: ZONE_LABEL[cur.zoneType] || cur.zoneType, a: ZONE_LABEL[zone] }); patch.zoneType = zone; }
        if (whRaw && whRaw !== cur.warehouseId) { changes.push({ campo: 'Bodega', de: cur.warehouseId, a: whRaw }); patch.warehouseId = whRaw; }
        if (cap !== undefined && cap !== cur.capacity) { changes.push({ campo: 'Capacidad', de: String(cur.capacity), a: String(cap) }); patch.capacity = cap; }
        if (rank !== undefined && rank !== cur.pickRank) { changes.push({ campo: 'Cercanía a picking', de: String(cur.pickRank), a: String(rank) }); patch.pickRank = rank; }
        if (act !== undefined && act !== cur.active) { changes.push({ campo: 'Activa', de: boolTxt(cur.active), a: boolTxt(act) }); patch.active = act; }
        if (changes.length) plan.toUpdate.push({ id: cur.id, code: cur.code, changes, patch });
        else plan.unchanged.push(cur.code);
      }
    }
    return plan;
  }

  private sheetRows(locs: Location[]): unknown[][] {
    return [HEADERS, ...locs.map((l) => [l.code, ZONE_LABEL[l.zoneType] || l.zoneType, l.warehouseId, l.capacity, l.pickRank, l.active ? 'si' : 'no'])];
  }
  private sendXlsx(res: Response, wb: XLSX.WorkBook, filename: string) {
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  }
  private static readonly COLS = [{ wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 22 }, { wch: 20 }, { wch: 14 }];

  @Get('export')
  @RequirePermission('stock:read')
  async export(@Param('operationId') operationId: string, @CurrentUser() user: User | null, @Res() res: Response) {
    const opId = actorOperation(user, operationId);
    const locs = (await this.wms.listLocations(opId)).sort((a, b) => a.code.localeCompare(b.code));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(this.sheetRows(locs));
    ws['!cols'] = LocationsImportController.COLS;
    XLSX.utils.book_append_sheet(wb, ws, 'Ubicaciones');
    this.sendXlsx(res, wb, 'ubicaciones-ninjawms.xlsx');
  }

  @Get('template')
  @RequirePermission('master:manage')
  template(@Res() res: Response) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      HEADERS,
      ['A-01-1-A', 'Almacenaje', 'W1', 500, 1, 'si'],
      ['A-01-1-B', 'Almacenaje', 'W1', 500, 2, 'si'],
      ['PICK-01', 'Picking', 'W1', 0, 1, 'si'],
    ]);
    ws['!cols'] = LocationsImportController.COLS;
    XLSX.utils.book_append_sheet(wb, ws, 'Ubicaciones');
    const wsi = XLSX.utils.aoa_to_sheet(INSTRUCTIONS);
    wsi['!cols'] = [{ wch: 110 }];
    XLSX.utils.book_append_sheet(wb, wsi, 'Instrucciones');
    this.sendXlsx(res, wb, 'plantilla-ubicaciones-ninjawms.xlsx');
  }

  /** Previsualiza: NO escribe nada. */
  @Post('preview')
  @RequirePermission('master:manage')
  async preview(@Param('operationId') operationId: string, @Body() dto: ImportFileDto, @CurrentUser() user: User | null) {
    const plan = await this.buildPlan(actorOperation(user, operationId), dto.dataBase64);
    if ('error' in plan) return { ok: false, error: plan.error };
    return {
      ok: true,
      resumen: { nuevas: plan.toCreate.length, modificar: plan.toUpdate.length, sinCambios: plan.unchanged.length, errores: plan.errors.length },
      toCreate: plan.toCreate.map((c) => ({ code: c.code, zona: ZONE_LABEL[c.zoneType], capacidad: c.capacity, pickRank: c.pickRank })),
      toUpdate: plan.toUpdate.map((u) => ({ code: u.code, changes: u.changes })),
      errors: plan.errors,
    };
  }

  /** Confirma: crea y edita. El frontend solo lo llama tras el VB del usuario. */
  @Post('commit')
  @RequirePermission('master:manage')
  async commit(@Param('operationId') operationId: string, @Body() dto: ImportFileDto, @CurrentUser() user: User | null) {
    const opId = actorOperation(user, operationId);
    const plan = await this.buildPlan(opId, dto.dataBase64);
    if ('error' in plan) return { ok: false, error: plan.error };
    const creadas: string[] = [];
    const modificadas: string[] = [];
    const errores: { code: string; motivo: string }[] = [];
    for (const c of plan.toCreate) {
      try {
        const loc = await this.wms.createLocation({ operationId: opId, code: c.code, zoneType: c.zoneType, warehouseId: c.warehouseId, capacity: c.capacity, pickRank: c.pickRank });
        if (!c.active) await this.wms.updateLocation(loc.id, { active: false }, user);
        creadas.push(c.code);
      } catch (e) { errores.push({ code: c.code, motivo: (e as Error).message }); }
    }
    for (const u of plan.toUpdate) {
      try {
        await this.wms.updateLocation(u.id, u.patch as any, user);
        modificadas.push(u.code);
      } catch (e) { errores.push({ code: u.code, motivo: (e as Error).message }); }
    }
    return {
      ok: true,
      resumen: { creadas: creadas.length, modificadas: modificadas.length, errores: errores.length, sinCambios: plan.unchanged.length },
      creadas, modificadas, errores,
    };
  }
}
