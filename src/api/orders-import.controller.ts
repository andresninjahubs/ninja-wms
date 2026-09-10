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
import { OrderType, Uom, User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Carga masiva de órdenes por Excel.
 *   GET  /sellers/:sellerId/order-import/template  -> descarga la plantilla .xlsx
 *   POST /sellers/:sellerId/order-import           -> sube un .xlsx/.csv con varias órdenes
 *
 * Formato: una FILA por línea de orden. Las filas que comparten el mismo
 * "N° de orden" se agrupan en una sola orden con varias líneas. Los datos de
 * encabezado (canal, tipo, destinatario, etc.) se toman de la primera fila del grupo.
 *
 * Ruta separada ('order-import') para no chocar con las rutas dinámicas de
 * órdenes (:orderId) del controlador principal.
 */

// Columnas de la plantilla (en orden). El emparejado al leer es tolerante:
// se normaliza el encabezado (sin acentos/espacios) y se busca por palabra clave.
const TEMPLATE_HEADERS = [
  'N° de orden',
  'Canal de venta',
  'Tipo (b2c/b2b/devolucion)',
  'Prioridad (normal/alta)',
  'Destinatario',
  'Teléfono',
  'Comuna/Ciudad',
  'Dirección',
  'SKU',
  'Cantidad',
  'Lote (opcional)',
  'Tipo de documento (boleta/factura/guia_despacho/orden_compra)',
  'Courier (Chilexpress/Rapiboy/DHL…)',
];

const EXAMPLE_ROWS = [
  ['WEB-1001', 'web-propia', 'b2c', 'normal', 'María Pérez', '+56 9 1111 1111', 'Providencia', 'Av. Siempre Viva 123', 'SKU-EJEMPLO-1', 2, '', 'boleta', 'Chilexpress'],
  ['WEB-1001', 'web-propia', 'b2c', 'normal', 'María Pérez', '+56 9 1111 1111', 'Providencia', 'Av. Siempre Viva 123', 'SKU-EJEMPLO-2', 1, '', 'boleta', 'Chilexpress'],
  ['WEB-1002', 'web-propia', 'b2c', 'alta', 'Juan Soto', '+56 9 2222 2222', 'Las Condes', 'Calle Falsa 456', 'SKU-EJEMPLO-1', 5, '', 'factura', 'Rapiboy'],
];

const INSTRUCTIONS = [
  ['Cómo usar esta plantilla'],
  [''],
  ['1) Completa una FILA por cada línea (SKU) de la orden.'],
  ['2) Si una orden tiene varios productos, repite el mismo "N° de orden" en varias filas.'],
  ['   Los datos del destinatario y encabezado se toman de la primera fila de cada orden.'],
  ['3) Campos obligatorios: N° de orden, Destinatario, SKU y Cantidad.'],
  ['4) "Canal de venta" por defecto es web-propia. "Tipo" por defecto b2c. "Prioridad" por defecto normal.'],
  ['5) No cambies los nombres de las columnas de la hoja "Órdenes".'],
  ['6) Borra las filas de ejemplo antes de subir tu archivo.'],
  ['7) Guarda el archivo como Excel (.xlsx) o CSV y súbelo en el panel.'],
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
  if (n.includes('orden')) return 'orden';
  if (n.includes('canal')) return 'canal';
  // "documento" antes que "tipo": el encabezado "Tipo de documento" contiene ambas.
  if (n.includes('documento')) return 'doc';
  if (n.includes('courier') || n.includes('transporte') || n.includes('carrier')) return 'carrier';
  if (n.includes('tipo')) return 'tipo';
  if (n.includes('prioridad')) return 'prioridad';
  if (n.includes('destinatario') || n.includes('nombre')) return 'name';
  if (n.includes('telefono')) return 'phone';
  if (n.includes('comuna') || n.includes('ciudad')) return 'comuna';
  if (n.includes('direccion')) return 'address';
  if (n === 'sku' || n.includes('sku')) return 'sku';
  if (n.includes('cantidad') || n === 'qty') return 'qty';
  if (n.includes('lote') || n.includes('lot')) return 'lot';
  return null;
}

function mapOrderType(raw: unknown): OrderType | 'INVALID' | null {
  const n = norm(raw);
  if (!n) return null; // vacío -> usar defecto
  if (n === 'b2c') return OrderType.B2C;
  if (n === 'b2b') return OrderType.B2B;
  if (n === 'devolucion' || n === 'return' || n === 'devoluciones') return OrderType.RETURN;
  return 'INVALID';
}

// Tipo de documento (atributo opcional): normaliza texto libre a un código válido.
// Si viene vacío o no reconocido, devuelve null (no bloquea la orden).
function mapDocumentType(raw: unknown): string | null {
  const n = norm(raw);
  if (!n) return null;
  if (n.includes('boleta')) return 'boleta';
  if (n.includes('factura')) return 'factura';
  if (n.includes('guia')) return 'guia_despacho';
  if (n.includes('orden') || n.includes('compra') || n === 'oc') return 'orden_compra';
  return null;
}

@Controller('sellers/:sellerId/order-import')
export class OrdersImportController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Descarga la plantilla Excel con las columnas de la orden y ejemplos. */
  @Get('template')
  @RequirePermission('order:create')
  template(@Res() res: Response) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...EXAMPLE_ROWS]);
    ws['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(12, h.length + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Órdenes');
    const wsi = XLSX.utils.aoa_to_sheet(INSTRUCTIONS);
    wsi['!cols'] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsi, 'Instrucciones');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-ordenes-ninjawms.xlsx"');
    res.send(buf);
  }

  /** Sube un archivo (.xlsx o .csv) en base64 y crea las órdenes. */
  @Post()
  @RequirePermission('order:create')
  async importOrders(
    @Param('sellerId') sellerId: string,
    @Body() dto: ImportOrdersDto,
    @CurrentUser() user: User | null,
  ) {
    const actor = actorOf(user);
    let rows: unknown[][];
    try {
      const buf = Buffer.from(dto.dataBase64, 'base64');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheetName =
        wb.SheetNames.find((n) => norm(n).includes('orden')) || wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' }) as unknown[][];
    } catch (e) {
      return { ok: false, error: `No se pudo leer el archivo: ${(e as Error).message}` };
    }

    if (!rows.length) {
      return { ok: false, error: 'El archivo está vacío.' };
    }

    // Encabezados -> índice de columna por campo canónico.
    const headerRow = rows[0];
    const colOf: Record<string, number> = {};
    headerRow.forEach((h, i) => {
      const f = headerToField(h);
      if (f && colOf[f] === undefined) colOf[f] = i;
    });
    if (colOf['orden'] === undefined || colOf['sku'] === undefined || colOf['qty'] === undefined) {
      return {
        ok: false,
        error:
          'No se reconocen las columnas obligatorias. Usa la plantilla oficial (columnas N° de orden, SKU y Cantidad).',
      };
    }

    const cell = (row: unknown[], field: string): string =>
      colOf[field] === undefined ? '' : String(row[colOf[field]] ?? '').trim();

    // Agrupar filas por N° de orden, preservando el orden de aparición.
    const groups = new Map<string, { header: unknown[]; lines: { sku: string; qty: number; lot: string; rowNo: number }[] }>();
    const lineErrors: { fila: number; motivo: string }[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowNo = i + 1; // 1-indexado como en Excel
      const orden = cell(row, 'orden');
      const sku = cell(row, 'sku');
      const qtyRaw = cell(row, 'qty');
      // Fila totalmente vacía -> ignorar.
      if (!orden && !sku && !qtyRaw) continue;
      if (!orden) {
        lineErrors.push({ fila: rowNo, motivo: 'Falta el N° de orden.' });
        continue;
      }
      if (!sku) {
        lineErrors.push({ fila: rowNo, motivo: `Orden ${orden}: falta el SKU.` });
        continue;
      }
      const qty = Number(qtyRaw);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
        lineErrors.push({ fila: rowNo, motivo: `Orden ${orden}: cantidad inválida ("${qtyRaw}"). Debe ser un entero mayor que 0.` });
        continue;
      }
      if (!groups.has(orden)) groups.set(orden, { header: row, lines: [] });
      groups.get(orden)!.lines.push({ sku, qty, lot: cell(row, 'lot'), rowNo });
    }

    const created: { orden: string; id: string; lineas: number }[] = [];
    const failed: { orden: string; motivo: string }[] = [];

    for (const [orden, g] of groups) {
      const name = cell(g.header, 'name');
      if (!name) {
        failed.push({ orden, motivo: 'Falta el Destinatario.' });
        continue;
      }
      const typeMapped = mapOrderType(cell(g.header, 'tipo'));
      if (typeMapped === 'INVALID') {
        failed.push({ orden, motivo: `Tipo inválido ("${cell(g.header, 'tipo')}"). Usa b2c, b2b o devolucion.` });
        continue;
      }
      const shipTo: Record<string, string> = { name };
      const phone = cell(g.header, 'phone');
      if (phone) shipTo.phone = phone;
      const comuna = cell(g.header, 'comuna');
      if (comuna) shipTo.comuna = comuna;
      const address = cell(g.header, 'address');
      if (address) shipTo.address = address;

      const priorityRaw = cell(g.header, 'prioridad');
      const salesChannel = cell(g.header, 'canal') || 'web-propia';

      try {
        const order = await this.wms.createOrder(
          sellerId,
          {
            externalOrderId: orden,
            salesChannel,
            orderType: (typeMapped as OrderType) || OrderType.B2C,
            documentType: mapDocumentType(cell(g.header, 'doc')),
            carrier: cell(g.header, 'carrier') || null,
            priority: priorityRaw || 'normal',
            shipTo: shipTo as any,
            lines: g.lines.map((l) => ({
              sku: l.sku,
              qty: l.qty,
              uom: Uom.EACH,
              lot: l.lot || null,
            })),
          },
          actor,
        );
        created.push({ orden, id: order.id, lineas: g.lines.length });
      } catch (e) {
        failed.push({ orden, motivo: (e as Error).message });
      }
    }

    return {
      ok: true,
      resumen: {
        ordenesEnArchivo: groups.size,
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
