/**
 * BillingService — Facturación 3PL por cliente (seller).
 *
 * El 3PL cobra a cada cliente por: cuota fija, ALMACENAMIENTO (unidad-mes, integrando el
 * stock físico en zonas de almacenaje/picking a lo largo del período), RECEPCIÓN (unidades
 * recibidas), DESPACHO (pedidos despachados en el período), PICKING (unidades pickeadas de esos
 * mismos pedidos despachados), EMBALAJE (insumos de esos pedidos) y ARMADO de kits.
 * Todo se calcula desde el ledger inmutable y los registros de órdenes/armados — auditable.
 */
import { NotFoundError, ValidationError } from './errors';
import {
  BillingRepository,
  Clock,
  IdGenerator,
  InvoiceDocumentBlob,
  LocationRepository,
  MovementRepository,
  OrderRepository,
  SellerRepository,
  AssemblyLogRepository,
} from './ports';
import { BillingInvoice, BillingLine, BillingRate, InvoiceStatus, InvoiceTaxDocument, MovementType, SalesOrder, ZoneType } from './types';
import { PackagingService } from './packaging.service';

/** Datos de un documento tributario que llega para adjuntar a una factura. */
export interface AttachTaxDocInput {
  fileName: string;
  mimeType?: string;
  contentBase64: string;
  markInvoiced?: boolean; // si true, además deja la factura en estado Facturado
}

const MS_PER_DAY = 86400000;
const DAYS_PER_MONTH = 30; // convención de "unidad-mes" (mes de 30 días)

export interface RatePatch {
  currency?: string;
  fixedMonthly?: number;
  storagePerUnitMonth?: number;
  receiptPerUnit?: number;
  shipmentPerOrder?: number;
  pickPerUnit?: number;
  assemblyPerKit?: number;
  requiresApproval?: boolean;
}

export class BillingService {
  constructor(
    private readonly billing: BillingRepository,
    private readonly movements: MovementRepository,
    private readonly locations: LocationRepository,
    private readonly orders: OrderRepository,
    private readonly assemblies: AssemblyLogRepository,
    private readonly sellers: SellerRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly packaging?: PackagingService,
  ) {}

  private defaults(sellerId: string): BillingRate {
    return {
      sellerId,
      currency: 'CLP',
      fixedMonthly: 0,
      storagePerUnitMonth: 0,
      receiptPerUnit: 0,
      shipmentPerOrder: 0,
      pickPerUnit: 0,
      assemblyPerKit: 0,
      requiresApproval: false,
    };
  }

  async getRate(sellerId: string): Promise<BillingRate> {
    return (await this.billing.getRate(sellerId)) ?? this.defaults(sellerId);
  }

  async setRate(sellerId: string, patch: RatePatch): Promise<BillingRate> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    const cur = await this.getRate(sellerId);
    const num = (v: number | undefined, prev: number) => {
      if (v == null) return prev;
      if (!(v >= 0) || !Number.isFinite(v)) throw new ValidationError('Las tarifas deben ser números no negativos');
      return v;
    };
    const next: BillingRate = {
      sellerId,
      currency: patch.currency || cur.currency || 'CLP',
      fixedMonthly: num(patch.fixedMonthly, cur.fixedMonthly),
      storagePerUnitMonth: num(patch.storagePerUnitMonth, cur.storagePerUnitMonth),
      receiptPerUnit: num(patch.receiptPerUnit, cur.receiptPerUnit),
      shipmentPerOrder: num(patch.shipmentPerOrder, cur.shipmentPerOrder),
      pickPerUnit: num(patch.pickPerUnit, cur.pickPerUnit),
      assemblyPerKit: num(patch.assemblyPerKit, cur.assemblyPerKit),
      requiresApproval: patch.requiresApproval == null ? cur.requiresApproval : !!patch.requiresApproval,
    };
    await this.billing.saveRate(next);
    return next;
  }

  /** Unidad-días de stock físico en zonas de almacenaje/picking durante [from, to). */
  private async storageUnitDays(sellerId: string, operationId: string, from: number, to: number): Promise<number> {
    const locs = await this.locations.listByOperation(operationId);
    const stored = new Set(locs.filter((l) => l.zoneType === ZoneType.STORAGE || l.zoneType === ZoneType.PICKING).map((l) => l.id));
    const movs = (await this.movements.find({ sellerId }))
      .filter((m) => stored.has(m.locationId))
      .map((m) => ({ t: Date.parse(m.occurredAt), d: m.qtyDelta }))
      .sort((a, b) => a.t - b.t);
    let level = 0;
    let i = 0;
    for (; i < movs.length && movs[i].t < from; i++) level += movs[i].d;
    let unitMs = 0;
    let cursor = from;
    for (; i < movs.length && movs[i].t < to; i++) {
      unitMs += level * (movs[i].t - cursor);
      cursor = movs[i].t;
      level += movs[i].d;
    }
    unitMs += level * (to - cursor);
    return unitMs / MS_PER_DAY;
  }

  /** Calcula una factura (sin persistir) para el período [from, to). */
  async computeInvoice(sellerId: string, fromISO: string, toISO: string): Promise<Omit<BillingInvoice, 'id' | 'number' | 'createdAt' | 'createdBy' | 'sends' | 'status' | 'approval' | 'taxDocument'>> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    const rate = await this.getRate(sellerId);
    const from = Date.parse(fromISO);
    const to = Date.parse(toISO);
    if (!(to > from)) throw new ValidationError('El período de facturación es inválido');

    const movs = await this.movements.find({ sellerId });
    const inPeriod = (iso: string) => {
      const t = Date.parse(iso);
      return t >= from && t < to;
    };
    const unidadesRecibidas = movs.filter((m) => m.type === MovementType.RECEIPT && inPeriod(m.occurredAt)).reduce((a, m) => a + m.qtyDelta, 0);
    const unitDays = await this.storageUnitDays(sellerId, seller.operationId, from, to);
    const unitMonths = unitDays / DAYS_PER_MONTH;

    // REGLA DE CORTE: despacho, picking y embalaje se cobran por las órdenes cuyo evento
    // DESPACHADA (SHIPPED) cae dentro del período. Así un pedido nunca se factura a medias
    // entre dos meses (picking en uno, despacho en otro) ni se cobra si aún no salió.
    const ords = await this.orders.list(sellerId);
    const shipped = new Map<string, SalesOrder>();
    for (const o of ords) {
      // Fecha de despacho: evento SHIPPED del historial o, como respaldo (órdenes guardadas por
      // versiones que no persistían el historial), la fecha del bloque de despacho.
      const ev = (o.events || []).find((e) => e.type === 'SHIPPED');
      const shippedAt = ev ? ev.at : (o.status === 'SHIPPED' && o.shipment && o.shipment.shippedAt) ? o.shipment.shippedAt : null;
      if (shippedAt && inPeriod(shippedAt)) shipped.set(o.id, o);
    }
    const pedidosDespachados = shipped.size;
    // Unidades pickeadas: movimientos PICK del kardex ligados a cada orden despachada
    // (referencia PICK:<orderId>). Si una orden no tiene movimientos asociados (datos antiguos),
    // se usan las cantidades de sus líneas como respaldo.
    const pickedByOrder = new Map<string, number>();
    for (const m of movs) {
      if (m.type !== MovementType.PICK || !m.reference || !m.reference.startsWith('PICK:')) continue;
      const oid = m.reference.slice(5);
      pickedByOrder.set(oid, (pickedByOrder.get(oid) || 0) - m.qtyDelta);
    }
    let unidadesPickeadas = 0;
    for (const [oid, o] of shipped) {
      const picked = pickedByOrder.get(oid);
      unidadesPickeadas += picked != null && picked > 0 ? picked : (o.lines || []).reduce((a: number, l: { qty: number }) => a + (l.qty || 0), 0);
    }
    const asm = await this.assemblies.list(sellerId);
    const kitsArmados = asm.filter((a) => inPeriod(a.at)).reduce((a, r) => a + r.qty, 0);

    const round = (n: number) => Math.round(n);
    const lines: BillingLine[] = [];
    const add = (concept: string, unit: string, qty: number, ratePer: number) => {
      if (ratePer > 0) lines.push({ concept, unit, qty: Math.round(qty * 100) / 100, rate: ratePer, amount: round(qty * ratePer) });
    };
    if (rate.fixedMonthly > 0) lines.push({ concept: 'Cuota fija', unit: 'mes', qty: 1, rate: rate.fixedMonthly, amount: round(rate.fixedMonthly) });
    add('Almacenamiento', 'unidad-mes', unitMonths, rate.storagePerUnitMonth);
    add('Recepción', 'unidad', unidadesRecibidas, rate.receiptPerUnit);
    add('Despacho', 'pedido', pedidosDespachados, rate.shipmentPerOrder);
    add('Picking', 'unidad', unidadesPickeadas, rate.pickPerUnit);
    add('Armado de kits', 'kit', kitsArmados, rate.assemblyPerKit);

    // Materiales de embalaje consumidos por las órdenes DESPACHADAS en el período (misma regla
    // de corte que despacho y picking). Una línea por tipo de insumo, con el precio efectivo.
    if (this.packaging) {
      const emb = await this.packaging.consumptionForBilling(seller.operationId, sellerId, fromISO, toISO, new Set(shipped.keys()));
      for (const e of emb) {
        if (e.qty > 0 && e.amount > 0) {
          lines.push({ concept: `Embalaje · ${e.name}`, unit: 'unidad', qty: e.qty, rate: e.unitPrice, amount: e.amount });
        }
      }
    }

    const total = lines.reduce((a, l) => a + l.amount, 0);
    return { sellerId, periodFrom: fromISO, periodTo: toISO, currency: rate.currency, lines, total };
  }

  /** Genera y PERSISTE la factura de un mes (year, month 1-12). */
  async generateInvoice(sellerId: string, year: number, month: number, actor?: string): Promise<BillingInvoice> {
    if (!(year >= 2000 && year < 3000)) throw new ValidationError('Año inválido');
    if (!(month >= 1 && month <= 12)) throw new ValidationError('Mes inválido (1-12)');
    const fromISO = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const toISO = new Date(Date.UTC(year, month, 1)).toISOString();
    const draft = await this.computeInvoice(sellerId, fromISO, toISO);
    const rate = await this.getRate(sellerId);
    const yyyymm = `${year}${String(month).padStart(2, '0')}`;
    const suffix = this.ids.next().replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
    const id = `FAC-${yyyymm}-${suffix}`;
    const invoice: BillingInvoice = {
      ...draft,
      id,
      number: id,
      createdAt: this.clock.now(),
      createdBy: actor || 'system',
      sends: [],
      // Nace como PRE-FACTURA: PENDING si el cliente requiere aprobación, si no ISSUED.
      // Pasa a Facturado (INVOICED) cuando el admin adjunta el documento tributario y la marca.
      status: rate.requiresApproval ? 'PENDING' : 'ISSUED',
      approval: null,
      taxDocument: null,
    };
    await this.billing.saveInvoice(invoice);
    return invoice;
  }

  /**
   * Estado de PRE-FACTURA que corresponde a una factura si se le quita el "Facturado":
   * si el cliente ya la había aprobado, vuelve a APPROVED; si requiere aprobación, PENDING;
   * si no, ISSUED.
   */
  private async preInvoiceStatus(inv: BillingInvoice): Promise<InvoiceStatus> {
    if (inv.approval) return 'APPROVED';
    const rate = await this.getRate(inv.sellerId);
    return rate.requiresApproval ? 'PENDING' : 'ISSUED';
  }

  /**
   * Adjunta (o reemplaza) el documento tributario de una factura. Guarda los bytes en el
   * repositorio y los metadatos en la factura. Si `markInvoiced`, además pasa a Facturado.
   */
  async attachTaxDocument(sellerId: string, id: string, input: AttachTaxDocInput, actor?: string): Promise<BillingInvoice> {
    const inv = await this.billing.findInvoice(sellerId, id);
    if (!inv) throw new NotFoundError(`Factura no encontrada: ${id}`);
    const fileName = (input.fileName || '').trim();
    if (!fileName) throw new ValidationError('El documento tributario necesita un nombre de archivo');
    const b64 = (input.contentBase64 || '').replace(/^data:[^,]*,/, '').trim();
    if (!b64) throw new ValidationError('El documento tributario está vacío');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, 'base64');
    } catch {
      throw new ValidationError('El documento tributario no es un archivo válido');
    }
    if (bytes.length === 0) throw new ValidationError('El documento tributario está vacío');
    const MAX = 20 * 1024 * 1024; // 20 MB
    if (bytes.length > MAX) throw new ValidationError('El documento tributario supera el máximo permitido (20 MB)');
    const mimeType = (input.mimeType || guessMime(fileName)).trim() || 'application/octet-stream';
    const blob: InvoiceDocumentBlob = { fileName, mimeType, contentBase64: b64 };
    await this.billing.saveInvoiceDocument(sellerId, id, blob);
    const doc: InvoiceTaxDocument = {
      fileName,
      mimeType,
      size: bytes.length,
      uploadedAt: this.clock.now(),
      uploadedBy: actor || 'system',
    };
    inv.taxDocument = doc;
    if (input.markInvoiced) inv.status = 'INVOICED';
    await this.billing.saveInvoice(inv);
    return inv;
  }

  /** Marca una factura como Facturado (requiere documento tributario adjunto). */
  async markInvoiced(sellerId: string, id: string): Promise<BillingInvoice> {
    const inv = await this.billing.findInvoice(sellerId, id);
    if (!inv) throw new NotFoundError(`Factura no encontrada: ${id}`);
    if (!inv.taxDocument) throw new ValidationError('Adjunta el documento tributario antes de marcar como facturado');
    inv.status = 'INVOICED';
    await this.billing.saveInvoice(inv);
    return inv;
  }

  /**
   * Quita el documento tributario y la marca de Facturado: la factura vuelve a PRE-FACTURA
   * (APPROVED si estaba aprobada, si no PENDING/ISSUED según el tarifario).
   */
  async removeTaxDocument(sellerId: string, id: string): Promise<BillingInvoice> {
    const inv = await this.billing.findInvoice(sellerId, id);
    if (!inv) throw new NotFoundError(`Factura no encontrada: ${id}`);
    await this.billing.deleteInvoiceDocument(sellerId, id);
    inv.taxDocument = null;
    if (inv.status === 'INVOICED') inv.status = await this.preInvoiceStatus(inv);
    await this.billing.saveInvoice(inv);
    return inv;
  }

  /** Recupera los bytes del documento tributario de una factura (para descarga). */
  async getTaxDocument(sellerId: string, id: string): Promise<InvoiceDocumentBlob | null> {
    const inv = await this.billing.findInvoice(sellerId, id);
    if (!inv) throw new NotFoundError(`Factura no encontrada: ${id}`);
    return this.billing.getInvoiceDocument(sellerId, id);
  }

  /**
   * El cliente (seller) aprueba su factura desde su portal. Deja registro de quién y cuándo.
   * Solo aplica a facturas PENDING (las ISSUED no tienen flujo de aprobación).
   */
  async approveInvoice(sellerId: string, id: string, actor: string): Promise<BillingInvoice> {
    const inv = await this.billing.findInvoice(sellerId, id);
    if (!inv) throw new NotFoundError(`Factura no encontrada: ${id}`);
    if (inv.status === 'INVOICED') throw new ValidationError('La factura ya está facturada');
    if (inv.status === 'ISSUED') throw new ValidationError('Esta factura no requiere aprobación');
    if (inv.status === 'APPROVED') throw new ValidationError('La factura ya fue aprobada');
    inv.status = 'APPROVED';
    inv.approval = { by: actor || 'cliente', at: this.clock.now() };
    await this.billing.saveInvoice(inv);
    return inv;
  }

  /** ¿Ya existe una factura para ese seller y mes? (para alertar duplicados). */
  async invoicesForMonth(sellerId: string, year: number, month: number): Promise<BillingInvoice[]> {
    const fromISO = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    return (await this.billing.listInvoices(sellerId)).filter((i) => i.periodFrom === fromISO);
  }

  /** Edita una factura ya emitida: número, cantidades de líneas y/o líneas adicionales. */
  async updateInvoice(
    sellerId: string,
    id: string,
    patch: { number?: string; lines?: { concept: string; unit?: string; qty: number; rate: number }[] },
  ): Promise<BillingInvoice> {
    const inv = await this.billing.findInvoice(sellerId, id);
    if (!inv) throw new NotFoundError(`Factura no encontrada: ${id}`);
    if (inv.status === 'INVOICED') {
      throw new ValidationError('La factura está facturada. Quita el documento tributario (desmarca Facturado) antes de editar.');
    }
    if (patch.number != null) {
      const n = patch.number.trim();
      if (!n) throw new ValidationError('El número de factura no puede quedar vacío');
      inv.number = n;
    }
    if (patch.lines) {
      const lines: BillingLine[] = [];
      for (const l of patch.lines) {
        if (!l.concept || !l.concept.trim()) throw new ValidationError('Cada línea debe tener un concepto');
        if (!Number.isFinite(l.qty) || l.qty < 0) throw new ValidationError(`Cantidad inválida en "${l.concept}"`);
        if (!Number.isFinite(l.rate)) throw new ValidationError(`Tarifa inválida en "${l.concept}"`);
        lines.push({ concept: l.concept.trim(), unit: (l.unit || '—').trim() || '—', qty: l.qty, rate: l.rate, amount: Math.round(l.qty * l.rate) });
      }
      inv.lines = lines;
      inv.total = lines.reduce((a, x) => a + x.amount, 0);
    }
    // Si la factura ya estaba aprobada y se modifica, la aprobación deja de ser válida:
    // vuelve a quedar pendiente de la aprobación del cliente.
    if (inv.status === 'APPROVED') {
      inv.status = 'PENDING';
      inv.approval = null;
    }
    await this.billing.saveInvoice(inv);
    return inv;
  }

  async deleteInvoice(sellerId: string, id: string): Promise<{ ok: true; id: string }> {
    const inv = await this.billing.findInvoice(sellerId, id);
    if (!inv) throw new NotFoundError(`Factura no encontrada: ${id}`);
    await this.billing.deleteInvoice(sellerId, id);
    return { ok: true, id };
  }

  /** Registra un envío por correo de la factura (auditoría). El SMTP lo hace la capa de infra. */
  async recordSend(sellerId: string, id: string, to: string, delivered: boolean, actor?: string): Promise<BillingInvoice> {
    const inv = await this.billing.findInvoice(sellerId, id);
    if (!inv) throw new NotFoundError(`Factura no encontrada: ${id}`);
    inv.sends = (inv.sends || []).concat({ to, at: this.clock.now(), by: actor || 'system', delivered });
    await this.billing.saveInvoice(inv);
    return inv;
  }

  listInvoices(sellerId: string): Promise<BillingInvoice[]> {
    return this.billing.listInvoices(sellerId);
  }
  getInvoice(sellerId: string, id: string): Promise<BillingInvoice | null> {
    return this.billing.findInvoice(sellerId, id);
  }

  /**
   * Dashboard de facturación de una OPERACIÓN: agrega TODAS las facturas emitidas de
   * sus clientes, desglosadas por período (mes), cliente y concepto. Devuelve datos
   * "planos" (líneas agregadas + resumen por factura) para que el panel arme la vista
   * consolidada, por cliente y la apertura por concepto sin recomputar en el servidor.
   */
  async dashboard(operationId: string): Promise<BillingDashboard> {
    const sellers = await this.sellers.list(operationId);
    const conceptSet: string[] = [...CANON_CONCEPTS];
    const lineMap = new Map<string, DashboardLine>(); // clave: period|sellerId|concept
    const invoices: DashboardInvoiceRef[] = [];
    const clients: { sellerId: string; name: string }[] = [];
    let currency = 'CLP';
    for (const s of sellers) {
      const invs = await this.billing.listInvoices(s.id);
      if (invs.length) clients.push({ sellerId: s.id, name: s.name });
      for (const inv of invs) {
        currency = inv.currency || currency;
        const period = inv.periodFrom.slice(0, 7); // 'YYYY-MM'
        invoices.push({ period, sellerId: s.id, id: inv.id, number: inv.number, status: inv.status, total: inv.total });
        for (const l of inv.lines) {
          if (!conceptSet.includes(l.concept)) conceptSet.push(l.concept);
          const key = `${period}|${s.id}|${l.concept}`;
          const ex = lineMap.get(key);
          if (ex) ex.amount += l.amount;
          else lineMap.set(key, { period, sellerId: s.id, concept: l.concept, amount: l.amount });
        }
      }
    }
    return { operationId, currency, concepts: conceptSet, clients, lines: [...lineMap.values()], invoices };
  }
}

/** Deduce el mime-type desde la extensión del archivo (fallback si el cliente no lo envía). */
function guessMime(fileName: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    xml: 'application/xml',
    csv: 'text/csv',
    txt: 'text/plain',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

/** Orden canónico de conceptos (los adicionales de texto libre se agregan al final). */
export const CANON_CONCEPTS = ['Cuota fija', 'Almacenamiento', 'Recepción', 'Despacho', 'Picking', 'Armado de kits'];

export interface DashboardLine {
  period: string; // 'YYYY-MM'
  sellerId: string;
  concept: string;
  amount: number;
}
export interface DashboardInvoiceRef {
  period: string;
  sellerId: string;
  id: string;
  number: string;
  status: string;
  total: number;
}
export interface BillingDashboard {
  operationId: string;
  currency: string;
  concepts: string[]; // orden canónico + adicionales por orden de aparición
  clients: { sellerId: string; name: string }[]; // solo clientes con facturas
  lines: DashboardLine[];
  invoices: DashboardInvoiceRef[];
}
