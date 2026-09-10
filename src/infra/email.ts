/**
 * Envío de correo transaccional (verificación de email, reset de contraseña, etc.).
 *
 * Estrategia de arranque (Fase 0 de PLG):
 *  - Sin SMTP_URL configurado -> LogEmailSender: registra el correo en consola y NO
 *    entrega. Suficiente para dev/demo; el enlace también se devuelve en la respuesta
 *    de la API cuando NODE_ENV != 'production', para poder probar el flujo end-to-end.
 *  - Con SMTP_URL configurado -> SmtpEmailSender: entrega de verdad vía nodemailer
 *    (import perezoso; si el paquete no está instalado, cae a LogEmailSender).
 */
import { EmailMessage, EmailSender } from '../domain/ports';

/** No entrega: registra el correo en consola. Útil en dev/demo. */
export class LogEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<{ delivered: boolean }> {
    // eslint-disable-next-line no-console
    console.log(
      `\n[email:dev] Para: ${message.to}\n[email:dev] Asunto: ${message.subject}\n[email:dev] ${message.text}\n`,
    );
    return { delivered: false };
  }
}

/** Entrega vía SMTP con nodemailer (import perezoso para no exigir el paquete en dev). */
export class SmtpEmailSender implements EmailSender {
  private transportPromise: Promise<any> | null = null;
  constructor(
    private readonly smtpUrl: string,
    private readonly from: string,
    private readonly fallback: EmailSender,
  ) {}

  private async transport(): Promise<any | null> {
    if (!this.transportPromise) {
      this.transportPromise = (async () => {
        try {
          const nodemailer = await import('nodemailer');
          return (nodemailer as any).createTransport(this.smtpUrl);
        } catch {
          return null; // nodemailer no instalado -> usaremos el fallback
        }
      })();
    }
    return this.transportPromise;
  }

  async send(message: EmailMessage): Promise<{ delivered: boolean }> {
    const t = await this.transport();
    if (!t) return this.fallback.send(message);
    try {
      await t.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { delivered: true };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[email] fallo el envío SMTP, cae a log:', (e as Error).message);
      return this.fallback.send(message);
    }
  }
}

/** Elige el sender según el entorno (SMTP_URL + MAIL_FROM). */
export function selectEmailSender(): EmailSender {
  const smtpUrl = process.env.SMTP_URL;
  const log = new LogEmailSender();
  if (smtpUrl) {
    const from = process.env.MAIL_FROM || 'Ninja WMS <no-reply@ninjahubs.cl>';
    return new SmtpEmailSender(smtpUrl, from, log);
  }
  return log;
}
