/**
 * Envío de correo (infra). Usa nodemailer con SMTP si está configurado por entorno;
 * si no, no entrega pero devuelve un resultado claro (el envío igual queda registrado
 * en la factura para auditoría). Para activarlo en producción, define:
 *   SMTP_URL   = smtp://usuario:clave@host:587   (o smtps://... para 465)
 *   SMTP_FROM  = "Ninja Hubs WMS <facturacion@tudominio.cl>"
 */
import type { BillingInvoice } from '../domain/types';

function money(n: number, cur: string): string {
  try {
    return `${(n || 0).toLocaleString('es-CL')} ${cur || 'CLP'}`;
  } catch {
    return `${n} ${cur || 'CLP'}`;
  }
}

export function invoiceEmailHtml(invoice: BillingInvoice, sellerName: string): string {
  const rows = invoice.lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 10px;border-bottom:1px solid #e6ebe8">${l.concept}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e6ebe8;text-align:right">${l.qty} ${l.unit}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e6ebe8;text-align:right">${money(l.rate, invoice.currency)}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e6ebe8;text-align:right">${money(l.amount, invoice.currency)}</td></tr>`,
    )
    .join('');
  const period = invoice.periodFrom.slice(0, 7);
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2b22;max-width:640px">
    <h2 style="color:#1f7a44;margin:0 0 2px">Ninja Hubs · WMS</h2>
    <div style="color:#5a6b62;font-size:13px;margin-bottom:14px">Factura de servicios 3PL · ${sellerName}</div>
    <div style="font-size:14px;margin-bottom:10px"><b>${invoice.number}</b> · período ${period}</div>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr>
        <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #1f7a44">Concepto</th>
        <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #1f7a44">Cantidad</th>
        <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #1f7a44">Tarifa</th>
        <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #1f7a44">Monto</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="3" style="text-align:right;padding:8px 10px;font-weight:bold">Total</td>
      <td style="text-align:right;padding:8px 10px;font-weight:bold">${money(invoice.total, invoice.currency)}</td></tr></tfoot>
    </table>
    <p style="color:#5a6b62;font-size:12px;margin-top:14px">Documento referencial de servicios logísticos del período. No es documento tributario.</p>
  </div>`;
}

export async function sendInvoiceEmail(params: {
  to: string;
  invoice: BillingInvoice;
  sellerName: string;
}): Promise<{ delivered: boolean; reason?: string }> {
  const url = process.env.SMTP_URL;
  const from = process.env.SMTP_FROM || 'Ninja Hubs WMS <no-reply@ninjahubs.cl>';
  if (!url) {
    return { delivered: false, reason: 'SMTP no configurado (define SMTP_URL para el envío real)' };
  }
  try {
    // Import perezoso: solo se carga si hay SMTP configurado.
    const nodemailer = await import('nodemailer');
    const transport = (nodemailer as any).createTransport(url);
    await transport.sendMail({
      from,
      to: params.to,
      subject: `Factura ${params.invoice.number} · ${params.sellerName}`,
      html: invoiceEmailHtml(params.invoice, params.sellerName),
    });
    return { delivered: true };
  } catch (e) {
    return { delivered: false, reason: `Error SMTP: ${(e as Error).message}` };
  }
}
