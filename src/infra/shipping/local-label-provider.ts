/**
 * LocalShippingLabelProvider — OMS de Ninja SIMULADO (para la demo / modo memoria).
 *
 * Implementa el puerto ShippingLabelProvider: cuando una orden se empaca, "conecta"
 * con el OMS y devuelve el número de seguimiento del transporte + una etiqueta por
 * bulto, lista para ver e imprimir dentro del proceso de packing.
 *
 * En producción se reemplaza por un gateway HTTP real al OMS de Ninja (misma interfaz);
 * aquí generamos un tracking determinista y una etiqueta SVG imprimible por bulto.
 */
import { Clock, IdGenerator, ShippingLabelProvider, ShippingLabelRequest, ShippingLabelResult } from '../../domain/ports';
import { OrderType, SalesOrder, ShippingLabel } from '../../domain/types';

/** Couriers B2C y transporte B2B que el OMS puede asignar (demo). */
const B2C_CARRIERS = ['Blue Express', 'Chilexpress', 'Starken'];
const B2B_CARRIER = 'Ninja Freight';

function escapeXml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Suma estable de los caracteres de un string (para elegir courier de forma determinista). */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export class LocalShippingLabelProvider implements ShippingLabelProvider {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async fetchLabels(req: ShippingLabelRequest): Promise<ShippingLabelResult> {
    const { order } = req;
    const bultos = Math.max(1, Math.floor(req.bultos || 1));
    const carrier =
      order.orderType === OrderType.B2B
        ? B2B_CARRIER
        : B2C_CARRIERS[hashCode(order.id) % B2C_CARRIERS.length];

    // Tracking master del transporte (determinista: deriva del generador de ids).
    const suffix = this.ids.next().replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase();
    const trackingNumber = `NJ${suffix}`;

    const labels: ShippingLabel[] = [];
    for (let n = 1; n <= bultos; n++) {
      const bultoTracking = bultos > 1 ? `${trackingNumber}-${n}` : trackingNumber;
      labels.push({
        bultoNo: n,
        trackingNumber: bultoTracking,
        carrier,
        format: 'SVG',
        dataUri: this.renderLabel(order, carrier, bultoTracking, n, bultos),
      });
    }
    return { trackingNumber, carrier, labels };
  }

  /** Dibuja una etiqueta 4x6 (400x600) como data URI SVG imprimible. */
  private renderLabel(
    order: SalesOrder,
    carrier: string,
    tracking: string,
    bultoNo: number,
    bultos: number,
  ): string {
    const st = order.shipTo || ({} as any);
    const dest = escapeXml(st.name || '—');
    const place = escapeXml([st.comuna, st.region].filter(Boolean).join(', ') || 'Chile');
    const addr = escapeXml(st.address || '');
    const ext = escapeXml(order.externalOrderId || order.id.slice(0, 8));
    const modo = order.orderType === OrderType.B2B ? 'B2B · TRANSPORTE' : 'B2C · PAQUETERÍA';

    // Código de barras "fake" derivado del tracking (barras de ancho variable).
    const bars = this.barcode(tracking, 360, 64, 20);

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600" font-family="Helvetica,Arial,sans-serif">` +
      `<rect x="0" y="0" width="400" height="600" fill="#ffffff"/>` +
      `<rect x="8" y="8" width="384" height="584" fill="none" stroke="#111111" stroke-width="2"/>` +
      // Header
      `<rect x="8" y="8" width="384" height="58" fill="#111111"/>` +
      `<text x="24" y="46" fill="#ffffff" font-size="26" font-weight="700" letter-spacing="1">NINJA HUBS</text>` +
      `<text x="376" y="34" fill="#ffffff" font-size="12" text-anchor="end" letter-spacing="1">WMS</text>` +
      `<text x="376" y="52" fill="#ffffff" font-size="12" text-anchor="end">${escapeXml(modo)}</text>` +
      // Carrier
      `<text x="24" y="104" fill="#111" font-size="14" letter-spacing="2">TRANSPORTE</text>` +
      `<text x="24" y="134" fill="#111" font-size="30" font-weight="700">${escapeXml(carrier)}</text>` +
      `<line x1="24" y1="150" x2="376" y2="150" stroke="#111" stroke-width="1"/>` +
      // Destinatario
      `<text x="24" y="180" fill="#666" font-size="12" letter-spacing="2">DESTINATARIO</text>` +
      `<text x="24" y="206" fill="#111" font-size="22" font-weight="700">${dest}</text>` +
      `<text x="24" y="230" fill="#111" font-size="15">${place}</text>` +
      (addr ? `<text x="24" y="252" fill="#333" font-size="13">${addr}</text>` : '') +
      // Orden + bulto
      `<line x1="24" y1="272" x2="376" y2="272" stroke="#111" stroke-width="1"/>` +
      `<text x="24" y="300" fill="#666" font-size="12" letter-spacing="2">ORDEN</text>` +
      `<text x="24" y="326" fill="#111" font-size="22" font-weight="700">${ext}</text>` +
      `<text x="376" y="300" fill="#666" font-size="12" letter-spacing="2" text-anchor="end">BULTO</text>` +
      `<text x="376" y="330" fill="#111" font-size="30" font-weight="800" text-anchor="end">${bultoNo}/${bultos}</text>` +
      // Barcode
      `<g transform="translate(20,430)">${bars}</g>` +
      `<text x="200" y="524" fill="#111" font-size="20" font-weight="700" text-anchor="middle" letter-spacing="2">${escapeXml(tracking)}</text>` +
      `<text x="200" y="560" fill="#666" font-size="12" text-anchor="middle">Nº de seguimiento del transporte</text>` +
      `</svg>`;

    const b64 = Buffer.from(svg, 'utf8').toString('base64');
    return `data:image/svg+xml;base64,${b64}`;
  }

  /** Genera barras verticales deterministas a partir de un texto (código de barras decorativo). */
  private barcode(text: string, width: number, height: number, y: number): string {
    let x = 0;
    let out = '';
    let i = 0;
    while (x < width) {
      const ch = text.charCodeAt(i % text.length) + i;
      const w = 1 + (ch % 4); // ancho 1..4
      const on = (ch >> 1) % 2 === 0; // barra o espacio
      if (on) out += `<rect x="${x}" y="${y}" width="${w}" height="${height}" fill="#111"/>`;
      x += w + 1;
      i++;
    }
    return out;
  }
}
