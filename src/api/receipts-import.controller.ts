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
import { ImportOrdersDto } from './dto';
import { Uom, User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Carga masiva de ÓRDENES DE RECEPCIÓN por Excel. Espejo de la carga de órdenes,
 * con la misma información que el formulario: proveedor, referencia, ubicación,
 * notas y líneas (SKU, cantidad esperada, lote, vencimiento).
 *
 *   GET  /sellers/:sellerId/receipt-import/template  -> descarga la plantilla .xlsx
 *   POST /sellers/:sellerId/receipt-import           -> sube un .xlsx/.csv con varias recepciones
 *
 * Una FILA por línea (SKU). Las filas que comparten el mismo "Recepción (grupo)" se
 * agrupan en UNA orden de recepción con varias líneas. Los datos de encabezado
 * (proveedor, referencia, ubicación, notas) se toman de la primera fila del grupo.
 *
 * Ruta separada ('receipt-import') para no chocar con las rutas dinámicas de
 * recepción (:orderId) del controlador principal.
 */

const TEMPLATE_HEADERS = [
  'Recepción (grupo)',
  'Proveedor',
  'Referencia (guía/factura/OC)',
  'Ubicación de recepción (código, opcional)',
  'Notas (opcional)',
  'SKU',
  'Cantidad esperada',
  'Lote (opcional)',
  'Vencimiento (AAAA-MM-DD, opcional)',
];

const EXAMPLE_ROWS = [
  ['REC-1', 'Importadora Andes', 'Guía 10442', '', 'Sin daños', 'SKU-EJEMPLO-1', 120, 'L-2026-01', '2027-01-31'],
  ['REC-1', 'Importadora Andes', 'Guía 10442', '', 'Sin daños', 'SKU-EJEMPLO-2', 60, '', ''],
  ['REC-2', 'Distribuidora Sur', 'Factura 8891', '', '', 'SKU-EJEMPLO-1', 200, 'L-2026-02', '2027-06-30'],
];

const INSTRUCTIONS = [
  ['Cómo usar esta plantilla'],
  [''],
  ['1) Completa una FILA por cada línea (SKU) de la recepción.'],
  ['2) Si una recepción tiene varios productos, repite el mismo "Recepción (grupo)" en varias filas.'],
  ['   Proveedor, referencia, ubicación y notas se toman de la primera fila de cada grupo.'],
  ['3) Campos obligatorios: Recepción (grupo), SKU y Cantidad esperada.'],
  ['4) "Ubicación de recepción": escribe el CÓDIGO de una ubicación de recepción. Si lo dejas vacío,'],
  ['   se usa la primera ubicación de recepción de la operación.'],
  ['5) "Vencimiento": formato AAAA-MM-DD (por ejemplo 2027-01-31). Opcional.'],
  ['6) La recepción se crea con cantidades ESPERADAS. El stock ingresa al recepcionar (cotejo).'],
  ['7) No cambies los nombres de las columnas de la hoja "Recepciones". Borra las filas de ejemplo.'],
];

function norm(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Mapea el encabezado normalizado a un campo canónico.
function headerToField(header: unknown): string | null {
  const n = norm(header);
  if (!n) return null;
  // "Ubicación de recepción" contiene "recepcion": la ubicación se evalúa ANTES que el grupo.
  if (n.includes('ubicacion') || n.includes('bodega')) return 'location';
  if (n.includes('grupo') || n.includes('recepcion')) return 'grupo';
  if (n.includes('proveedor')) return 'supplier';
  if (n.includes('referencia') || n.includes('guia') || n.includes('factura')) return 'reference';
  if (n.includes('nota') || n.includes('observacion')) return 'notes';
  if (n === 'sku' || n.includes('sku')) return 'sku';
  if (n.includes('cantidad') || n === 'qty') return 'qty';
  // "vencimiento" antes que "lote" no es necesario (palabras distintas), pero mantenemos claridad.
  if (n.includes('vencimiento') || n.includes('vence') || n.includes('expiry') || n.includes('caducidad')) return 'expiry';
  if (n.includes('lote') || n.includes('lot')) return 'lot';
  return null;
}

// Convierte una celda de vencimiento a texto AAAA-MM-DD (tolera Date de Excel).
function normExpiry(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s || null;
}

@Controller('sellers/:sellerId/receipt-import')
export class ReceiptsImportController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Descarga la plantilla Excel con las columnas de la recepción y ejemplos. */
  @Get('template')
  @RequirePermission('inventory:receive')
  template(@Res() res: Response) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...EXAMPLE_ROWS]);
    ws['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(14, h.length + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Recepciones');
    const wsi = XLSX.utils.aoa_to_sheet(INSTRUCTIONS);
    wsi['!cols'] = [{ wch: 92 }];
    XLSX.utils.book_append_sheet(wb, wsi, 'Instrucciones');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-recepciones-ninjawms.xlsx"');
    res.send(buf);
  }

  /** Sube un archivo (.xlsx o .csv) en base64 y crea las órdenes de recepción. */
  @Post()
  @RequirePermission('inventory:receive')
  async importReceipts(
    @Param('sellerId') sellerId: string,
    @Body() dto: ImportOrdersDto,
    @CurrentUser() user: User | null,
  ) {
    const actor = actorOf(user);
    let rows: unknown[][];
    try {
      const buf = Buffer.from(dto.dataBase64, 'base64');
      const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
      const sheetName =
        wb.SheetNames.find((n) => norm(n).includes('recepcion')) || wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' }) as unknown[][];
    } catch (e) {
      return { ok: false, error: `No se pudo leer el archivo: ${(e as Error).message}` };
    }

    if (!rows.length) return { ok: false, error: 'El archivo está vacío.' };

    const headerRow = rows[0];
    const colOf: Record<string, number> = {};
    headerRow.forEach((h, i) => {
      const f = headerToField(h);
      if (f && colOf[f] === undefined) colOf[f] = i;
    });
    if (colOf['grupo'] === undefined || colOf['sku'] === undefined || colOf['qty'] === undefined) {
      return {
        ok: false,
        error:
          'No se reconocen las columnas obligatorias. Usa la plantilla oficial (columnas Recepción (grupo), SKU y Cantidad esperada).',
      };
    }

    const cell = (row: unknown[], field: string): string =>
      colOf[field] === undefined ? '' : String(row[colOf[field]] ?? '').trim();
    const rawCell = (row: unknown[], field: string): unknown =>
      colOf[field] === undefined ? '' : row[colOf[field]];

    // Resolver códigos de ubicación -> id (una sola vez).
    const seller = await this.wms.getSeller(sellerId);
    const locByCode = new Map<string, string>();
    if (seller) {
      const locs = await this.wms.listLocations(seller.operationId);
      for (const l of locs) locByCode.set(norm(l.code), l.id);
    }

    // Agrupar filas por "Recepción (grupo)", preservando el orden de aparición.
    const groups = new Map<string, { header: unknown[]; lines: { sku: string; qty: number; lot: string; expiry: string | null; rowNo: number }[] }>();
    const lineErrors: { fila: number; motivo: string }[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowNo = i + 1;
      const grupo = cell(row, 'grupo');
      const sku = cell(row, 'sku');
      const qtyRaw = cell(row, 'qty');
      if (!grupo && !sku && !qtyRaw) continue; // fila vacía
      if (!grupo) { lineErrors.push({ fila: rowNo, motivo: 'Falta el grupo de recepción.' }); continue; }
      if (!sku) { lineErrors.push({ fila: rowNo, motivo: `Recepción ${grupo}: falta el SKU.` }); continue; }
      const qty = Number(qtyRaw);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
        lineErrors.push({ fila: rowNo, motivo: `Recepción ${grupo}: cantidad inválida ("${qtyRaw}"). Debe ser un entero mayor que 0.` });
        continue;
      }
      if (!groups.has(grupo)) groups.set(grupo, { header: row, lines: [] });
      groups.get(grupo)!.lines.push({ sku, qty, lot: cell(row, 'lot'), expiry: normExpiry(rawCell(row, 'expiry')), rowNo });
    }

    const created: { grupo: string; id: string; lineas: number }[] = [];
    const failed: { grupo: string; motivo: string }[] = [];

    for (const [grupo, g] of groups) {
      const locCode = cell(g.header, 'location');
      let locationId: string | null = null;
      if (locCode) {
        locationId = locByCode.get(norm(locCode)) ?? null;
        if (!locationId) {
          failed.push({ grupo, motivo: `Ubicación no encontrada por código: "${locCode}".` });
          continue;
        }
      }
      try {
        const rec = await this.wms.createReceipt(
          sellerId,
          {
            supplier: cell(g.header, 'supplier') || null,
            reference: cell(g.header, 'reference') || null,
            locationId,
            notes: cell(g.header, 'notes') || null,
            lines: g.lines.map((l) => ({
              sku: l.sku,
              qty: l.qty,
              uom: Uom.EACH,
              lot: l.lot || null,
              expiry: l.expiry,
            })),
          },
          actor,
        );
        created.push({ grupo, id: rec.id, lineas: g.lines.length });
      } catch (e) {
        failed.push({ grupo, motivo: (e as Error).message });
      }
    }

    return {
      ok: true,
      resumen: {
        recepcionesEnArchivo: groups.size,
        creadas: created.length,
        conError: failed.length,
        lineasIgnoradas: lineErrors.length,
      },
      created,
      failed,
      lineErrors,
    };
  }
}
