import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WmsFacade } from '../app/wms.facade';
import { WMS_FACADE } from './tokens';
import { UserRole } from '../domain/types';
import type { ApiKeyScope } from '../domain/api-key';

/**
 * Servidor MCP del WMS.
 * ---------------------------------------------------------------------------
 * Las 75 herramientas del copiloto ya existían con su esquema JSON, su alcance
 * por tenant y su política de permisos; lo único que faltaba era exponerlas por
 * un protocolo que hablen otros agentes. Eso es esto: ninguna capacidad nueva,
 * una puerta nueva para las mismas capacidades.
 *
 * Transporte: Streamable HTTP en modo SIN SESIÓN. Cada petición arma su propio
 * servidor y su propio transporte y los bota al terminar. Suena derrochador y es
 * lo correcto acá: el WMS corre detrás de un balanceador, así que una sesión
 * guardada en memoria se perdería apenas la siguiente petición cayera en otra
 * instancia. Sin estado, cualquier instancia responde cualquier petición.
 *
 * Autenticación: llave de API (`Authorization: Bearer njw_…`), no el JWT del
 * panel — ese dura 12 horas y un cliente MCP se conecta durante meses. La llave
 * hereda los permisos de su dueño y nunca los amplía.
 *
 * Esta ruta NO pasa por el AuthGuard: se autentica ella misma, porque un cliente
 * MCP necesita un 401 con el encabezado que el protocolo espera, no la respuesta
 * del panel.
 */
@Controller()
export class McpController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  @All('mcp')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const secreto = extraerBearer(req);
    if (!secreto) {
      noAutorizado(res, 'Falta la llave de API. Envíala como "Authorization: Bearer njw_…".');
      return;
    }
    const resuelto = await this.wms.resolveApiKey(secreto).catch(() => null);
    if (!resuelto) {
      noAutorizado(res, 'Llave de API inválida, revocada o vencida.');
      return;
    }
    const { user, key } = resuelto;

    // El alcance del tenant sale del usuario, igual que en la API REST: un
    // usuario CLIENT queda encerrado en su seller y no puede pedir otro.
    const sellerScope = user.role === UserRole.CLIENT ? (user.sellerId ?? null) : null;
    const scope: ApiKeyScope = key.scope;
    const actor = { id: user.id, role: String(user.role) };

    // Se usa el servidor de BAJO nivel, no McpServer: ese último exige esquemas
    // Zod, y el catálogo del copiloto ya está escrito en JSON Schema, que es
    // justamente el formato que viaja por el protocolo. Traducirlo a Zod para
    // que el SDK lo vuelva a convertir sería perder fidelidad en el camino.
    const server = new Server(
      { name: 'ninja-wms', version: MCP_VERSION },
      { instructions: instrucciones(user.role, scope), capabilities: { tools: {} } },
    );

    const catalogo = this.wms.mcpToolCatalog(user.role, scope);
    const porNombre = new Map(catalogo.map((t) => [t.name, t]));

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: catalogo.map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: esquemaConConfirmacion(spec.parameters, ACCIONES_CONFIRMABLES.has(spec.name)),
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const nombre = req.params.name;
      if (!porNombre.has(nombre)) {
        return { content: [{ type: 'text' as const, text: `La herramienta "${nombre}" no existe o no está disponible para esta llave.` }], isError: true };
      }
      const args: any = { ...(req.params.arguments ?? {}) };
      const confirmar = !!args.confirmar;
      delete args.confirmar;
      const out = await this.wms
        .mcpCallTool(nombre, args, { actor, operationId: key.operationId, sellerScope, scope, confirmar })
        .catch((e: any) => ({ error: (e && e.message) || 'La herramienta falló' }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out ?? null, null, 2) }],
        // Un error del dominio ("falta stock") es una respuesta legítima, no una
        // falla del transporte: se marca para que el agente lo distinga.
        isError: !!(out && (out as any).error),
      };
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => undefined); server.close().catch(() => undefined); });
    try {
      await server.connect(transport);
      // El cuerpo ya viene parseado por el pipeline de Nest; se le pasa para que
      // el transporte no intente leer un stream que ya se consumió.
      await transport.handleRequest(req, res, req.body);
    } catch (e: any) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: (e && e.message) || 'Error interno' }, id: null });
      }
    }
  }
}

export const MCP_VERSION = '1.0.0';

/**
 * Herramientas que la política puede dejar PROPUESTAS. A esas se les agrega un
 * parámetro `confirmar`: es el equivalente al botón del panel, y obliga al
 * agente externo a pedir la ejecución en dos pasos cuando la operación está en
 * modo confirmación.
 */
const ACCIONES_CONFIRMABLES = new Set<string>([
  'avanzar_estado_orden', 'cancelar_orden', 'reactivar_orden', 'reservar_ordenes',
  'crear_orden', 'crear_recepcion', 'recibir_recepcion', 'cerrar_recepcion',
  'crear_devolucion', 'procesar_devolucion', 'cancelar_devolucion',
  'mensaje_a_operario', 'recibir_insumos_embalaje', 'fijar_deadline_orden',
  'activar_auto_balanceo', 'fijar_modo_asignacion',
]);

/** Agrega `confirmar` al esquema de una acción, sin tocar el original. */
function esquemaConConfirmacion(schema: any, esAccion: boolean): any {
  const base = schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
  if (!esAccion) return base;
  return {
    ...base,
    properties: {
      ...(base.properties || {}),
      confirmar: {
        type: 'boolean',
        description: 'true ejecuta la acción aunque la operación esté en modo confirmación. Sin esto, la acción queda propuesta y se devuelve el resumen para que la revises.',
      },
    },
  };
}

function extraerBearer(req: Request): string | null {
  const h = req.headers?.authorization;
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const x = req.headers?.['x-api-key'];
  return typeof x === 'string' && x ? x.trim() : null;
}

function noAutorizado(res: Response, detalle: string): void {
  // WWW-Authenticate es lo que un cliente MCP mira para saber que debe pedir
  // credenciales en vez de dar el servidor por caído.
  res.setHeader('WWW-Authenticate', 'Bearer realm="ninja-wms"');
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: detalle }, id: null });
}

/** Lo primero que lee el agente al conectarse: qué es esto y cómo se comporta. */
function instrucciones(role: string, scope: ApiKeyScope): string {
  const L: string[] = [
    'Eres un cliente del WMS de Ninja Hubs. Las herramientas leen y operan sobre una bodega REAL, con datos en vivo.',
    'Todo queda acotado al tenant de la llave: la operación del usuario y, si es un usuario cliente, su propio seller. No hay forma de pedir datos de otro.',
    'Responde SIEMPRE con lo que devolvió la herramienta. Si el resultado trae sinCambios, un contador en 0 o un error, di que el cambio NO ocurrió.',
  ];
  if (scope === 'write') {
    L.push('Esta llave puede EJECUTAR acciones. Si la operación está en modo confirmación, una acción vuelve como propuesta: revísala con la persona y recién entonces repite la llamada con confirmar=true.');
  } else {
    L.push('Esta llave es de SOLO LECTURA: no hay herramientas de escritura disponibles.');
  }
  L.push(`Rol del dueño de la llave: ${role}.`);
  return L.join(' ');
}
