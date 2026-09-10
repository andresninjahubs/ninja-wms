/**
 * AnnouncementService — anuncios de plataforma (barra superior on-demand).
 *
 * El PLATFORM_ADMIN crea/edita/activa anuncios que se muestran como una barra
 * superior a los administradores y supervisores de TODAS las operaciones. Cada
 * anuncio lleva un enlace a una landing, y cada clic queda registrado con la
 * identidad del usuario (y su operación/cliente) para medir el interés.
 */
import { NotFoundError, ValidationError } from './errors';
import { AnnouncementRepository, Clock, IdGenerator } from './ports';
import { Announcement, AnnouncementAudience, AnnouncementClick, User, UserRole } from './types';

export interface AnnouncementInput {
  title: string;
  linkUrl: string;
  linkLabel?: string;
  active?: boolean;
  audience?: AnnouncementAudience;
}
export interface AnnouncementPatch {
  title?: string;
  linkUrl?: string;
  linkLabel?: string;
  active?: boolean;
  audience?: AnnouncementAudience;
}
export interface ClickSummary {
  announcementId: string;
  total: number;
  uniqueUsers: number;
  byRole: Record<string, number>;
  byOperation: Array<{ operationId: string | null; count: number }>;
  clicks: AnnouncementClick[]; // detalle: quién, de qué operación/cliente, cuándo
}

function normalizeUrl(raw: string): string {
  const u = (raw || '').trim();
  if (!u) throw new ValidationError('El anuncio debe llevar un enlace (URL)');
  // Acepta http(s); si no trae esquema, asume https.
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return 'https://' + u;
  throw new ValidationError('El enlace debe ser una URL válida (http/https)');
}

export class AnnouncementService {
  constructor(
    private readonly repo: AnnouncementRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async create(input: AnnouncementInput, actor: string): Promise<Announcement> {
    const title = (input.title || '').trim();
    if (!title) throw new ValidationError('El anuncio debe tener un texto');
    if (title.length > 240) throw new ValidationError('El texto del anuncio es demasiado largo (máx. 240)');
    const ann: Announcement = {
      id: 'ANN-' + this.ids.next().replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase(),
      title,
      linkUrl: normalizeUrl(input.linkUrl),
      linkLabel: (input.linkLabel || 'Ver más').trim() || 'Ver más',
      active: input.active !== false, // por defecto activo al crear
      audience: input.audience === 'ALL' ? 'ALL' : 'OPS', // por defecto solo operaciones
      createdAt: this.clock.now(),
      createdBy: actor || 'system',
    };
    await this.repo.save(ann);
    return ann;
  }

  async update(id: string, patch: AnnouncementPatch): Promise<Announcement> {
    const ann = await this.repo.findById(id);
    if (!ann) throw new NotFoundError(`Anuncio no encontrado: ${id}`);
    if (patch.title != null) {
      const t = patch.title.trim();
      if (!t) throw new ValidationError('El anuncio debe tener un texto');
      ann.title = t;
    }
    if (patch.linkUrl != null) ann.linkUrl = normalizeUrl(patch.linkUrl);
    if (patch.linkLabel != null) ann.linkLabel = patch.linkLabel.trim() || 'Ver más';
    if (patch.active != null) ann.active = !!patch.active;
    if (patch.audience != null) ann.audience = patch.audience === 'ALL' ? 'ALL' : 'OPS';
    await this.repo.save(ann);
    return ann;
  }

  async remove(id: string): Promise<{ ok: true; id: string }> {
    const ann = await this.repo.findById(id);
    if (!ann) throw new NotFoundError(`Anuncio no encontrado: ${id}`);
    await this.repo.delete(id);
    return { ok: true, id };
  }

  /** Todos los anuncios (para el mantenedor de plataforma). */
  list(): Promise<Announcement[]> {
    return this.repo.list();
  }

  /**
   * El anuncio ACTIVO más reciente que corresponde al espectador (o null).
   * Un CLIENT solo ve anuncios de audiencia 'ALL'; el staff (admin/supervisor/
   * plataforma) ve todos los activos.
   */
  async activeForViewer(viewerRole?: string): Promise<Announcement | null> {
    const isClient = viewerRole === UserRole.CLIENT;
    const all = await this.repo.list(); // desc por createdAt
    return all.filter((a) => a.active && (!isClient || a.audience === 'ALL'))[0] ?? null;
  }

  /** Registra un clic de un usuario en un anuncio (con su identidad y tenant). */
  async recordClick(announcementId: string, user: User | null): Promise<{ ok: true }> {
    const ann = await this.repo.findById(announcementId);
    if (!ann) throw new NotFoundError(`Anuncio no encontrado: ${announcementId}`);
    const click: AnnouncementClick = {
      id: 'CLK-' + this.ids.next().replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase(),
      announcementId,
      userId: user?.id ?? 'system',
      userName: user?.name ?? 'Sistema',
      userRole: user?.role ?? 'OPERATOR',
      operationId: user?.operationId ?? null,
      sellerId: user?.sellerId ?? null,
      at: this.clock.now(),
    };
    await this.repo.appendClick(click);
    return { ok: true };
  }

  /** Reporte de clics de un anuncio: total, únicos y detalle por usuario/operación. */
  async clicks(announcementId: string): Promise<ClickSummary> {
    const ann = await this.repo.findById(announcementId);
    if (!ann) throw new NotFoundError(`Anuncio no encontrado: ${announcementId}`);
    const clicks = (await this.repo.listClicks(announcementId)).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
    const users = new Set(clicks.map((c) => c.userId));
    const byRole: Record<string, number> = {};
    const opMap = new Map<string | null, number>();
    for (const c of clicks) {
      byRole[c.userRole] = (byRole[c.userRole] || 0) + 1;
      opMap.set(c.operationId, (opMap.get(c.operationId) || 0) + 1);
    }
    return {
      announcementId,
      total: clicks.length,
      uniqueUsers: users.size,
      byRole,
      byOperation: [...opMap.entries()].map(([operationId, count]) => ({ operationId, count })),
      clicks,
    };
  }
}
