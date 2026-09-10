/**
 * Semilla de demostración para pruebas rápidas (túnel / piloto interno).
 *
 * Crea DOS operaciones aisladas para mostrar el multi-administrador, cada una
 * con varios sellers, ~10 SKUs, 5 ubicaciones, ~20 órdenes y 10 usuarios de
 * diversos roles. Los valores (stock, cantidades, tipos de orden, estrategias)
 * se generan con un PRNG sembrado POR OPERACIÓN, de modo que:
 *   - las cifras son estables entre reinicios (deterministas), y
 *   - difieren visiblemente entre una operación/seller y otra.
 *
 * Usuarios de acceso conocidos (token = id):
 *   root  -> PLATFORM_ADMIN (plataforma, ve todo)
 *   ana   -> ADMIN  op-ninja
 *   pedro -> OPERATOR op-ninja
 *   carla -> CLIENT  (seller acme)
 *   nora  -> ADMIN  op-andes
 */
import { WmsFacade } from '../app/wms.facade';
import {
  CycleCountStrategy,
  OrderType,
  PickingStrategy,
  RotationClass,
  UserRole,
  ZoneType,
} from '../domain/types';

// ---- PRNG determinista sembrado por string -------------------------------
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seedStr: string) {
  const rnd = mulberry32(hashStr(seedStr));
  return {
    next: rnd,
    int: (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min,
    pick: <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)],
    chance: (p: number) => rnd() < p,
  };
}

// ---- Catálogos de nombres para variar entre cuentas ----------------------
const PRODUCTS = [
  ['CAM-AZ', 'Camisa azul'],
  ['PANT-NG', 'Pantalón negro'],
  ['ZAP-CF', 'Zapatilla café'],
  ['POL-BL', 'Polera blanca'],
  ['CHAQ-VD', 'Chaqueta verde'],
  ['GOR-RJ', 'Gorro rojo'],
  ['BUF-GR', 'Bufanda gris'],
  ['CINT-MR', 'Cinturón marrón'],
  ['MED-NG', 'Medias negras'],
  ['GUAN-AZ', 'Guantes azules'],
  ['BOT-NG', 'Botella negra'],
  ['MOCH-VD', 'Mochila verde'],
  ['TAZ-BL', 'Taza blanca'],
  ['LAP-RJ', 'Lápiz rojo'],
  ['CUAD-AM', 'Cuaderno amarillo'],
];
const SIZES = ['S', 'M', 'L', 'XL', '38', '40', '42', 'U'];
const CHANNELS = ['shopify', 'mercadolibre', 'falabella', 'web-propia', 'ripley', 'walmart'];
const FIRST_NAMES = ['Ana', 'Pedro', 'Carla', 'Nora', 'Diego', 'Sofía', 'Luis', 'Marta', 'Javier', 'Rocío', 'Tomás', 'Valentina', 'Ignacio', 'Camila', 'Felipe', 'Daniela', 'Andrés', 'Paula'];
const CITIES = ['Santiago', 'Valparaíso', 'Concepción', 'La Serena', 'Temuco', 'Antofagasta'];

interface SellerSpec {
  id: string;
  name: string;
  emailDomain: string;
}
interface OpSpec {
  id: string;
  name: string;
  sellers: SellerSpec[];
  /** usuarios "conocidos" con id fijo para poder loguear (token = id). */
  knownUsers: Array<{ id: string; name: string; email: string; role: UserRole; sellerId?: string }>;
}

const OPERATIONS: OpSpec[] = [
  {
    id: 'op-ninja',
    name: 'Bodega Ninja Hubs',
    sellers: [
      { id: 'acme', name: 'ACME Retail', emailDomain: 'acme.cl' },
      { id: 'globex', name: 'Globex Store', emailDomain: 'globex.cl' },
    ],
    knownUsers: [
      { id: 'ana', name: 'Ana', email: 'ana@ninjahubs.cl', role: UserRole.ADMIN },
      { id: 'rodrigo', name: 'Rodrigo', email: 'rodrigo@ninjahubs.cl', role: UserRole.SUPERVISOR },
      { id: 'pedro', name: 'Pedro', email: 'pedro@ninjahubs.cl', role: UserRole.OPERATOR },
      { id: 'diego', name: 'Diego', email: 'diego@ninjahubs.cl', role: UserRole.OPERATOR },
      { id: 'sofia', name: 'Sofía', email: 'sofia@ninjahubs.cl', role: UserRole.OPERATOR },
      { id: 'matias', name: 'Matías', email: 'matias@ninjahubs.cl', role: UserRole.OPERATOR },
      { id: 'valentina', name: 'Valentina', email: 'valentina@ninjahubs.cl', role: UserRole.OPERATOR },
      { id: 'carla', name: 'Carla', email: 'carla@acme.cl', role: UserRole.CLIENT, sellerId: 'acme' },
    ],
  },
  {
    id: 'op-andes',
    name: 'Bodega Andes',
    sellers: [
      { id: 'zeta', name: 'Zeta SpA', emailDomain: 'zeta.cl' },
      { id: 'kappa', name: 'Kappa Logística', emailDomain: 'kappa.cl' },
    ],
    knownUsers: [{ id: 'nora', name: 'Nora', email: 'nora@andes.cl', role: UserRole.ADMIN }],
  },
];

const STORAGE_ROLES = [UserRole.SUPERVISOR, UserRole.OPERATOR, UserRole.OPERATOR, UserRole.OPERATOR];
// Contraseña compartida para TODOS los usuarios de demostración (facilita la prueba).
// En producción cada usuario fija la suya; esto es solo para la semilla de demo.
const DEMO_PASSWORD = 'demo1234';
// Operadores con nombre de la operación de muestra (op-ninja). Se usan como "actor"
// de las acciones sembradas para que el Registro de actividad muestre trabajo real
// repartido entre varias personas. Solo aplican a op-ninja.
const NINJA_OPS = ['pedro', 'diego', 'sofia', 'matias', 'valentina'];

/** Reloj mínimo con override para retro-fechar la actividad histórica de la semilla. */
interface SeedClock {
  now(): string;
  setNow(ms: number): void;
  reset(): void;
}

export async function seedDemo(facade: WmsFacade, clock?: SeedClock): Promise<void> {
  if (await facade.getOperation('op-ninja')) return; // ya sembrado

  // Instante "ahora" real (antes de cualquier override), para retro-fechar la historia.
  const nowMs = clock ? Date.parse(clock.now()) : Date.now();
  // Volumen opcional (demo de LLM). Si está activo, NO se crean webhooks "vivos" antes
  // de generar el volumen (cada evento dispararía un POST HTTP real → miles de envíos).
  const seedVolume = parseInt(process.env.SEED_VOLUME || '0', 10);

  for (const op of OPERATIONS) {
    const rng = makeRng(op.id);
    await facade.createOperation({ id: op.id, name: op.name });

    // ---- 5 ubicaciones: 1 recepción + 4 de almacenaje/picking -------------
    const recv = await facade.createLocation({ operationId: op.id, code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const storage = [] as Array<{ id: string; code: string; capacity: number }>;
    const storageCodes = ['A-01-1-A', 'A-02-1-A', 'B-01-1-A', 'P-01-A'];
    for (let i = 0; i < storageCodes.length; i++) {
      const code = storageCodes[i];
      const capacity = rng.int(4000, 7000);
      const zone = code.startsWith('P') ? ZoneType.PICKING : ZoneType.STORAGE;
      const loc = await facade.createLocation({ operationId: op.id, code, zoneType: zone, capacity, pickRank: i + 1 });
      storage.push({ id: loc.id, code, capacity });
    }

    // ---- Sellers con estrategias variadas ---------------------------------
    // Para la demo se siembran FIFO/FEFO (ambas despachables sin exigir lote en
    // la orden). LOT_DIRECTED está soportada en el sistema y es configurable por
    // seller desde el panel; no se auto-siembra para no dejar órdenes trabadas.
    const pickStrategies = [PickingStrategy.FIFO, PickingStrategy.FEFO];
    const countStrategies = [CycleCountStrategy.ABC, CycleCountStrategy.LOCATION, CycleCountStrategy.RANDOM];

    // Reparte ~10 SKUs entre los sellers de la operación.
    const totalSkus = rng.int(9, 12);
    const perSeller = Math.ceil(totalSkus / op.sellers.length);
    let productCursor = rng.int(0, PRODUCTS.length - 1);

    const sellerSkus: Record<string, string[]> = {};

    for (let si = 0; si < op.sellers.length; si++) {
      const s = op.sellers[si];
      const srng = makeRng(op.id + ':' + s.id);
      await facade.createSeller({
        id: s.id,
        operationId: op.id,
        name: s.name,
        pickingStrategy: srng.pick(pickStrategies),
        cycleCountStrategy: srng.pick(countStrategies),
      });

      // ---- SKUs de este seller (con EAN + caja master) --------------------
      const skus: string[] = [];
      const recPlan: Array<{ sku: string; qty: number }> = [];
      const n = si === op.sellers.length - 1 ? totalSkus - Object.values(sellerSkus).flat().length : perSeller;
      for (let k = 0; k < n; k++) {
        const [base, desc] = PRODUCTS[productCursor % PRODUCTS.length];
        productCursor++;
        const size = srng.pick(SIZES);
        const sku = `${base}-${size}`;
        const ean = '78' + String(srng.int(1000000000, 1999999999));
        const rotation = srng.pick([RotationClass.A, RotationClass.B, RotationClass.C]);
        await facade.createSku(s.id, { sku, description: `${desc} ${size}`, barcode: ean, rotationClass: rotation });
        const factor = srng.pick([6, 8, 12, 24]);
        await facade.registerPack(s.id, {
          sku,
          code: 'CASE',
          barcode: '1' + ean,
          factor,
          label: `Caja master x${factor}`,
        });
        recPlan.push({ sku, qty: srng.int(40, 260) });
        skus.push(sku);
      }
      sellerSkus[s.id] = skus;

      // ---- Órdenes de recepción (inbound) con cotejo ---------------------
      // La mercadería ingresa como 1-2 órdenes de recepción (cada una con su ID y
      // varias líneas), simulando entregas de proveedores. La orden se crea con las
      // cantidades ESPERADAS; luego se coteja el físico (facade.receiveReceipt) que
      // es lo que realmente postea el stock. Para mostrar el flujo completo, en la
      // primera operación se deja una orden PARCIAL y una PENDIENTE de muestra.
      const SUPPLIERS = ['Importadora Andes', 'Textil Pacífico', 'Distribuidora Sur', 'Comercial Aconcagua'];
      const half = Math.ceil(recPlan.length / 2);
      const groups = recPlan.length > 3 ? [recPlan.slice(0, half), recPlan.slice(half)] : [recPlan];
      const receivedBySku: Record<string, number> = {};
      const showcase = op.id === 'op-ninja' && s.id === 'acme'; // una operación con muestras del flujo
      let gi = 0;
      for (const g of groups) {
        if (!g.length) continue;
        gi += 1;
        const order = await facade.createReceipt(
          s.id,
          {
            supplier: srng.pick(SUPPLIERS),
            reference: `GD-${op.id.slice(-4).toUpperCase()}-${gi}`,
            locationId: recv.id,
            lines: g.map((r) => ({ sku: r.sku, qty: r.qty })),
          },
          'system',
        );
        // modo de cotejo: 'full' (recibe todo), 'partial' (recibe ~60%), 'pending' (no recibe)
        let mode: 'full' | 'partial' | 'pending' = 'full';
        if (showcase) mode = gi === 1 ? 'partial' : 'pending';
        if (mode === 'pending') continue; // queda PENDING para demostrar el cotejo
        const counts = g.map((r, idx) => {
          const q = mode === 'partial' ? Math.max(1, Math.floor(r.qty * 0.6)) : r.qty;
          return { lineNo: idx + 1, qty: q };
        });
        await facade.receiveReceipt(s.id, order.id, counts, 'ana');
        counts.forEach((c, idx) => {
          receivedBySku[g[idx].sku] = (receivedBySku[g[idx].sku] || 0) + c.qty;
        });
      }

      // ---- Guardado (putaway) a almacenaje -------------------------------
      // Se guarda a almacenaje lo efectivamente recibido, de modo que el inventario
      // quede reservable y no quede stock "varado" en recepción. Para ~la mitad de
      // los SKUs el guardado se reparte en DOS ubicaciones, para poder demostrar
      // picking multi-ubicación (recolección dirigida desde varias posiciones).
      for (const r of recPlan) {
        const received = receivedBySku[r.sku] || 0;
        // En la operación de muestra dejamos ~la mitad de lo recibido EN recepción,
        // para que el módulo "Almacenado" tenga stock pendiente de guardar que mostrar.
        const qty = showcase ? Math.floor(received * 0.5) : received;
        if (qty <= 0) continue; // nada por guardar (pendiente, o mitad muy chica)
        const dest1 = storage[srng.int(0, storage.length - 1)];
        let dest2 = storage[srng.int(0, storage.length - 1)];
        if (dest2.id === dest1.id) {
          dest2 = storage[(storage.findIndex((x) => x.id === dest1.id) + 1) % storage.length];
        }
        const splitAcrossTwo = srng.next() < 0.5 && qty >= 4;
        const firstQty = splitAcrossTwo ? Math.floor(qty * (0.5 + srng.next() * 0.2)) : qty;
        const putawayActor = op.id === 'op-ninja' ? srng.pick(NINJA_OPS) : undefined;
        try {
          await facade.putaway(s.id, { sku: r.sku, qty: firstQty, fromLocationId: recv.id, toLocationId: dest1.id, reference: 'PUTAWAY', actor: putawayActor });
          if (splitAcrossTwo && qty - firstQty > 0) {
            await facade.putaway(s.id, { sku: r.sku, qty: qty - firstQty, fromLocationId: recv.id, toLocationId: dest2.id, reference: 'PUTAWAY', actor: op.id === 'op-ninja' ? srng.pick(NINJA_OPS) : undefined });
          }
        } catch {
          /* si algo no cuadra (p.ej. capacidad), deja el resto en recepción */
        }
      }

      // ---- Kits de ejemplo (SKU compuesto por otros SKUs) ----------------
      // En la operación de muestra se crean dos kits sobre SKUs existentes:
      // uno VIRTUAL (se explota en la orden) y uno ARMADO (con stock propio).
      if (showcase && skus.length >= 2) {
        const c1 = skus[0];
        const c2 = skus[1];
        try {
          await facade.createProduct('acme', {
            sku: 'KIT-DUO',
            description: 'Kit Dúo (virtual)',
            isKit: true,
            kitMode: (await import('../domain/types')).KitMode.VIRTUAL,
            components: [{ sku: c1, qty: 1 }, { sku: c2, qty: 1 }],
          }, 'ana');
          await facade.createProduct('acme', {
            sku: 'KIT-BOX',
            description: 'Kit Box (armado)',
            isKit: true,
            kitMode: (await import('../domain/types')).KitMode.ASSEMBLED,
            components: [{ sku: c1, qty: 2 }, { sku: c2, qty: 1 }],
          }, 'ana');
          const stgLoc = storage[0];
          const srcs = await facade.planAssemblySources('acme', 'KIT-BOX', 3);
          await facade.assembleKit('acme', { kitSku: 'KIT-BOX', qty: 3, toLocationId: stgLoc.id, sources: srcs }, 'ana');
        } catch {
          /* si no alcanza el stock de componentes, se omite el armado de muestra */
        }
      }

      // ---- Usuario CLIENT del seller (además de los conocidos) ------------
      const clientName = srng.pick(FIRST_NAMES);
      await facade.createUser({
        id: `${s.id}-cli`,
        name: clientName,
        email: `${clientName.toLowerCase()}@${s.emailDomain}`,
        role: UserRole.CLIENT,
        operationId: op.id,
        sellerId: s.id,
        password: DEMO_PASSWORD,
      });
    }

    // ---- ~20 órdenes repartidas entre los sellers -------------------------
    const totalOrders = rng.int(18, 24);
    for (let o = 0; o < totalOrders; o++) {
      const s = rng.pick(op.sellers);
      const skus = sellerSkus[s.id];
      if (!skus.length) continue;
      const nLines = rng.int(1, 3);
      const chosen = new Set<string>();
      const lines = [] as Array<{ sku: string; qty: number }>;
      for (let l = 0; l < nLines; l++) {
        const sku = rng.pick(skus);
        if (chosen.has(sku)) continue;
        chosen.add(sku);
        lines.push({ sku, qty: rng.int(1, 12) });
      }
      const orderType = rng.chance(0.7) ? OrderType.B2C : OrderType.B2B;
      const city = rng.pick(CITIES);
      let order;
      try {
        order = await facade.createOrder(s.id, {
          externalOrderId: `${s.id.toUpperCase()}-${1000 + o}`,
          salesChannel: rng.pick(CHANNELS),
          orderType,
          shipTo: { name: `${rng.pick(FIRST_NAMES)} (${city})` },
          lines,
        });
      } catch {
        continue;
      }
      // Ciclo de vida variado: algunas quedan NEW, otras ALLOCATED, otras SHIPPED.
      const roll = rng.next();
      if (roll < 0.35) continue; // queda NEW (recién ingresada por el OMS)
      const oactor = () => (op.id === 'op-ninja' ? rng.pick(NINJA_OPS) : undefined);
      try {
        await facade.allocateOrder(s.id, order.id, oactor());
      } catch {
        continue; // sin stock suficiente / falta lote (LOT_DIRECTED) -> queda RECEIVED
      }
      if (roll > 0.55) {
        // Avanza el ciclo: pick list -> confirmar picking -> (a veces) despacho.
        try {
          await facade.getPickList(s.id, order.id);
          await facade.confirmPick(s.id, order.id, oactor());
          if (roll > 0.62) {
            // Empaca (PACKED): trae tracking + etiquetas del OMS. Algunas quedan aquí.
            await facade.packOrder(s.id, order.id, { bultos: rng.int(1, 3) }, oactor() || 'seed');
            if (roll > 0.72) {
              await facade.shipOrder(s.id, order.id, {
                carrier: rng.pick(['Chilexpress', 'Starken', 'Blue Express']),
                trackingNumber: `TRK${rng.int(100000, 999999)}`,
              }, oactor());
            }
          }
        } catch {
          /* si el picking no cuadra, queda ALLOCATED */
        }
      }
    }

    // ---- 10 usuarios de diversos roles por operación ----------------------
    // Primero los conocidos (id fijo para poder loguear).
    for (const u of op.knownUsers) {
      await facade.createUser({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        operationId: op.id,
        sellerId: u.sellerId ?? null,
        password: DEMO_PASSWORD,
      });
    }
    // Completar hasta 10 (contando conocidos + 1 CLIENT por seller ya creados).
    const already = op.knownUsers.length + op.sellers.length;
    const remaining = Math.max(0, 10 - already);
    for (let u = 0; u < remaining; u++) {
      const role = rng.pick(STORAGE_ROLES);
      const name = rng.pick(FIRST_NAMES);
      const uid = `${op.id.replace('op-', '')}-u${u + 1}`;
      await facade.createUser({
        id: uid,
        name,
        email: `${uid}@${op.id.replace('op-', '')}.cl`,
        role,
        operationId: op.id,
        password: DEMO_PASSWORD,
      });
    }

    // ---- Actividad histórica (retro-fechada) para las MÉTRICAS del dashboard ----
    // Genera recepciones y pedidos con fecha en los últimos ~175 días, con una
    // tendencia levemente creciente hacia hoy, de modo que las ventanas 24h/7d/30d/90d
    // y sus comparativos (vs. período anterior) tengan datos reales. Solo para la
    // operación de muestra (op-ninja); requiere el reloj con override.
    if (clock && op.id === 'op-ninja') {
      const DAY = 86400000;
      const SUP = ['Importadora Andes', 'Textil Pacífico', 'Distribuidora Sur'];
      const CH = CHANNELS;
      // Pool de operadores con NOMBRE para que el Registro de actividad muestre
      // trabajo repartido entre varias personas a lo largo del mes.
      const OPS = ['pedro', 'diego', 'sofia', 'matias', 'valentina'];
      for (let si = 0; si < op.sellers.length; si++) {
        const s = op.sellers[si];
        const skus = sellerSkus[s.id];
        if (!skus || !skus.length) continue;
        const hrng = makeRng('hist:' + s.id);
        const rich = s.id === 'acme'; // acme con más volumen; el resto, más liviano
        const bufferSku = skus[0];
        // Buffer de stock (muy antiguo, fuera de toda ventana) para que los pickeos no falten.
        try {
          clock.setNow(nowMs - 205 * DAY);
          await facade.receive(s.id, { sku: bufferSku, qty: rich ? 12000 : 6000, locationId: storage[0].id, reference: 'BUFFER-HIST' });
        } catch { /* si falla, se omite la historia de este seller */ }

        const maxDay = rich ? 175 : 120;
        let seq = 0;
        for (let d = maxDay; d >= 0; d--) {
          // Densidad: diaria en los últimos 30 días; cada 2 días hasta 90; cada 3 más atrás.
          const act = d <= 30 ? true : d <= 90 ? d % 2 === 0 : d % 3 === 0;
          if (!act) continue;
          // Tendencia creciente hacia hoy (recencia) + ruido determinístico.
          const recency = 1 - d / (maxDay + 1); // 0 (antiguo) → ~1 (hoy)
          const baseOrders = rich ? 1 + Math.round(recency * 2) : 1; // 1..3 (acme), 1 (otros)
          const nOrders = Math.max(0, baseOrders - (hrng.chance(0.2) ? 1 : 0)) + (hrng.chance(0.25) ? 1 : 0);
          const at = nowMs - d * DAY - (8 + (seq % 9)) * 3600000; // reparte dentro del día
          // --- Recepción del día (no todos los días) + guardado a almacenaje ---
          if (hrng.chance(rich ? 0.75 : 0.5)) {
            try {
              clock.setNow(at - 1800000);
              const rqty = hrng.int(rich ? 30 : 18, rich ? 120 : 70);
              const rsku = hrng.pick(skus);
              const receiver = hrng.pick(OPS);
              const rord = await facade.createReceipt(
                s.id,
                { supplier: hrng.pick(SUP), reference: `GDH-${s.id.slice(0, 3).toUpperCase()}-${d}`, locationId: recv.id, lines: [{ sku: rsku, qty: rqty }] },
                'system',
              );
              await facade.receiveReceipt(s.id, rord.id, [{ lineNo: 1, qty: rqty }], receiver);
              // Guardado (putaway) de lo recibido, por un operador (puede ser otro).
              try {
                clock.setNow(at - 1200000);
                const dest = storage[1 + (seq % Math.max(1, storage.length - 1))]; // rota entre almacenaje (evita el buffer en [0])
                await facade.putaway(s.id, { sku: rsku, qty: rqty, fromLocationId: recv.id, toLocationId: dest.id, reference: 'PUTAWAY-HIST', actor: hrng.pick(OPS) });
              } catch { /* si no cabe por capacidad, se omite el guardado */ }
            } catch { /* omite esta recepción si algo no cuadra */ }
          }
          // --- Pedidos del día (preparados desde el buffer) ---
          for (let k = 0; k < nOrders; k++) {
            seq += 1;
            const units = hrng.int(3, rich ? 16 : 10);
            try {
              clock.setNow(at + k * 900000);
              const ord = await facade.createOrder(s.id, {
                externalOrderId: `H-${s.id.toUpperCase()}-${d}-${k}`,
                salesChannel: hrng.pick(CH),
                orderType: hrng.chance(0.7) ? OrderType.B2C : OrderType.B2B,
                shipTo: { name: `${hrng.pick(FIRST_NAMES)} (${hrng.pick(CITIES)})` },
                lines: [{ sku: bufferSku, qty: units }],
              });
              // Cada etapa la ejecuta un operador (a veces distintos, como en la vida real).
              await facade.allocateOrder(s.id, ord.id, hrng.pick(OPS));
              await facade.getPickList(s.id, ord.id);
              await facade.confirmPick(s.id, ord.id, hrng.pick(OPS)); // → PICKED (orden preparada)
              if (hrng.chance(0.82)) {
                // Empaca (trae tracking + etiquetas del OMS); la mayoría se despacha, algunas quedan EMPACADAS.
                await facade.packOrder(s.id, ord.id, { bultos: hrng.int(1, 3) }, hrng.pick(OPS));
                if (hrng.chance(0.85)) {
                  await facade.shipOrder(s.id, ord.id, { carrier: hrng.pick(['Chilexpress', 'Starken', 'Blue Express']), trackingNumber: `TRK${hrng.int(100000, 999999)}` }, hrng.pick(OPS));
                }
              }
            } catch { /* si el pickeo no cuadra, se omite este pedido */ }
          }
        }
      }
      clock.reset(); // vuelve a la hora real para el runtime
    }

    // ---- LOGINS históricos (retro-fechados) para el Panel de uso de plataforma ----
    // Siembra inicios de sesión de los últimos ~90 días para los usuarios conocidos
    // (staff conocido + el CLIENT de cada seller) de AMBAS operaciones, con densidad
    // creciente hacia hoy. op-ninja queda claramente MÁS activa que op-andes, para que
    // el panel muestre logins, usuarios activos, adopción y un comparativo ilustrativo.
    if (clock) {
      const DAY = 86400000;
      const lrng = makeRng('logins:' + op.id);
      const rich = op.id === 'op-ninja'; // op-ninja más activa que op-andes
      const loginUsers = op.knownUsers.map((u) => u.id).concat(op.sellers.map((s) => `${s.id}-cli`));
      for (let d = 90; d >= 0; d--) {
        const recency = 1 - d / 91; // 0 (antiguo) → ~1 (hoy)
        const pActive = (rich ? 0.55 : 0.28) + recency * (rich ? 0.4 : 0.2);
        if (!lrng.chance(pActive)) continue;
        // Usuarios distintos que inician sesión ese día (más en días recientes / op activa).
        const maxUsers = Math.min(loginUsers.length, rich ? 3 + Math.round(recency * 2) : 2);
        const nUsers = lrng.int(1, Math.max(1, maxUsers));
        // Barajado determinista para elegir qué usuarios entran ese día.
        const shuffled = loginUsers.slice();
        for (let k = shuffled.length - 1; k > 0; k--) {
          const j = lrng.int(0, k);
          const tmp = shuffled[k]; shuffled[k] = shuffled[j]; shuffled[j] = tmp;
        }
        for (let u = 0; u < nUsers; u++) {
          const uid = shuffled[u];
          const sessions = lrng.chance(rich ? 0.5 : 0.3) ? 2 : 1; // alguna revisita en el día
          for (let sidx = 0; sidx < sessions; sidx++) {
            const at = nowMs - d * DAY - (9 + lrng.int(0, 9)) * 3600000 - sidx * 1800000;
            try {
              clock.setNow(at);
              await facade.recordLogin(uid, op.id, clock.now());
            } catch { /* omite este login si algo no cuadra */ }
          }
        }
      }
      clock.reset();
    }
  }

  // ---- Facturación 3PL: tarifarios de muestra. ACME con aprobación del cliente
  // activada (carla aprueba desde su portal); Globex sin aprobación (emisión directa).
  // Con dos clientes tarifados, el dashboard muestra la consolidación real. ----
  try {
    await facade.setBillingRate('acme', {
      currency: 'CLP', fixedMonthly: 50000, storagePerUnitMonth: 120, receiptPerUnit: 30,
      shipmentPerOrder: 350, pickPerUnit: 20, assemblyPerKit: 800, requiresApproval: true,
    });
    await facade.setBillingRate('globex', {
      currency: 'CLP', fixedMonthly: 35000, storagePerUnitMonth: 90, receiptPerUnit: 25,
      shipmentPerOrder: 400, pickPerUnit: 18, assemblyPerKit: 700, requiresApproval: false,
    });
  } catch {
    /* si los sellers no existen en esta configuración, se omite */
  }

  // ---- Facturas de muestra: pre-factura del mes anterior por cliente.
  // ACME: aprobada por el cliente y FACTURADA (con documento tributario PDF adjunto),
  // para demostrar la visibilidad del documento por el cliente. GLOBEX: queda como pre-factura.
  try {
    const d0 = new Date(nowMs);
    const cm = d0.getUTCMonth() + 1;
    let py = d0.getUTCFullYear();
    let pmo: number;
    if (cm === 1) { pmo = 12; py -= 1; } else { pmo = cm - 1; }
    const acmeInv = await facade.generateInvoice('acme', py, pmo, 'ana');
    try { await facade.approveInvoice('acme', acmeInv.id, 'carla'); } catch { /* si no requiere aprobación */ }
    const pdf = demoTaxPdfBase64([
      'NINJA HUBS SpA  -  RUT 76.123.456-7',
      'FACTURA ELECTRONICA (documento tributario)',
      '',
      'Folio: ' + (acmeInv.number || acmeInv.id),
      'Cliente: ACME Retail SpA',
      'Periodo: ' + String(pmo).padStart(2, '0') + '/' + py,
      'Total: $' + (acmeInv.total || 0).toLocaleString('es-CL') + ' CLP',
      '',
      'Documento de demostracion adjunto a la factura del WMS.',
    ]);
    await facade.attachInvoiceTaxDocument(
      'acme',
      acmeInv.id,
      { fileName: 'factura_' + (acmeInv.number || acmeInv.id) + '.pdf', mimeType: 'application/pdf', contentBase64: pdf, markInvoiced: true },
      'ana',
    );
    await facade.generateInvoice('globex', py, pmo, 'ana');
  } catch {
    /* si la facturación no está disponible en esta configuración, se omite */
  }

  // ---- Chat interno de muestra: una conversación de ACME (carla) con operaciones (ana).
  // El último mensaje es del cliente y queda SIN leer para operaciones (badge en su bandeja).
  try {
    const carla = { id: 'carla', name: 'Carla', role: 'CLIENT' };
    const ana = { id: 'ana', name: 'Ana', role: 'ADMIN' };
    const stamp = (offMs: number) => { if (clock) clock.setNow(nowMs - offMs); };
    stamp(3 * 3600000); await facade.chatSend('acme', carla, 'Hola, ¿me confirman si llegó la recepción de ayer?');
    stamp(2 * 3600000 + 1500000); await facade.chatSend('acme', ana, 'Hola Carla, sí, la recibimos y ya quedó guardada en almacenaje.');
    stamp(30 * 60000); await facade.chatSend('acme', carla, 'Perfecto, gracias. ¿Podrían priorizar el despacho de la orden ACME-1003?');
    if (clock) clock.reset();
  } catch {
    /* si el chat no está disponible en esta configuración, se omite */
  }

  // ---- Anuncio de plataforma de muestra (barra superior activa) + algunos clics ----
  try {
    if (clock) clock.setNow(nowMs - 26 * 3600000);
    const ann = await facade.createAnnouncement(
      { title: '🚀 Nuevo: Facturación 3PL y panel de uso ya disponibles', linkUrl: 'https://ninjahubs.cl/novedades', linkLabel: 'Ver novedades', audience: 'ALL' },
      'root',
    );
    // Clics de muestra: un admin de cada operación (queda registrada su identidad).
    const anaU = { id: 'ana', name: 'Ana', email: 'ana@ninjahubs.cl', role: UserRole.ADMIN, operationId: 'op-ninja', sellerId: null, active: true };
    const noraU = { id: 'nora', name: 'Nora', email: 'nora@andes.cl', role: UserRole.ADMIN, operationId: 'op-andes', sellerId: null, active: true };
    if (clock) clock.setNow(nowMs - 20 * 3600000);
    await facade.clickAnnouncement(ann.id, anaU as any);
    if (clock) clock.setNow(nowMs - 5 * 3600000);
    await facade.clickAnnouncement(ann.id, noraU as any);
    if (clock) clock.reset();
  } catch {
    /* si los anuncios no están disponibles en esta configuración, se omite */
  }

  // ---- Webhooks de muestra ----
  // Habilita el panel de webhooks para el cliente 'acme' (el admin lo activa por cliente),
  // crea un webhook de OPERACIÓN (op-ninja) suscrito a ambos eventos, y uno de SELLER
  // para acme. Se dispara un 'test' para dejar una entrega en el historial (el POST real
  // fallará y quedará como FAILED, lo cual es correcto para la demo).
  try {
    await facade.setSellerWebhooksAccess('acme', true);
    // Con volumen activo, los webhooks se crean DESPUÉS de generar (ver seedHighVolume),
    // para no disparar miles de POST HTTP durante la carga masiva.
    if (seedVolume > 0) throw new Error('skip-live-webhooks-during-volume');
    const ana = { id: 'ana', name: 'Ana', email: 'ana@ninjahubs.cl', role: UserRole.ADMIN, operationId: 'op-ninja', sellerId: null, active: true };
    const carla = { id: 'carla', name: 'Carla', email: 'carla@acme.cl', role: UserRole.CLIENT, operationId: 'op-ninja', sellerId: 'acme', active: true };
    if (clock) clock.setNow(nowMs - 30 * 3600000);
    const opHook = await facade.createWebhook(ana as any, {
      url: 'https://webhook.site/demo-op-ninja',
      events: ['order.allocated', 'order.picking', 'order.picked', 'order.packed', 'order.shipped', 'order.cancelled', 'reception.received'],
    });
    if (clock) clock.setNow(nowMs - 28 * 3600000);
    await facade.createWebhook(carla as any, {
      url: 'https://webhook.site/demo-acme',
      events: ['order.allocated', 'order.picked', 'order.packed', 'order.shipped', 'order.cancelled'],
    });
    // Deja una entrega de prueba en el historial del webhook de operación.
    if (clock) clock.setNow(nowMs - 2 * 3600000);
    await facade.testWebhook(ana as any, opHook.id).catch(function () { /* la entrega queda registrada como FAILED */ });
    if (clock) clock.reset();
  } catch {
    /* si los webhooks no están disponibles en esta configuración, se omite */
  }

  // ---- SEMILLA DE ALTO VOLUMEN (opcional, para demo de LLM sobre miles de órdenes) ----
  // Se activa con SEED_VOLUME=<n> (p.ej. 50000). Genera N órdenes de ciclo COMPLETO
  // (ingreso → reserva → picking → empaque → despacho) en los últimos ~60 días,
  // repartidas entre 10 operarios con RENDIMIENTOS distintos, más recepciones,
  // guardados, re-slotting (transferencias) y re-alocaciones. Requiere el reloj.
  if (clock && seedVolume > 0) {
    try {
      await seedHighVolume(facade, clock, nowMs, seedVolume);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Semilla de alto volumen incompleta:', (e as Error).message);
    }
  }
}

/**
 * Genera un volumen grande de actividad realista sobre op-ninja / seller 'acme':
 *   - `volume` órdenes de ciclo completo repartidas en ~60 días,
 *   - 10 operarios con velocidad de picking distinta (unidades/hora), lo que produce
 *     una productividad claramente diferenciada en el reporte,
 *   - recepciones + guardados diarios, transferencias de re-slotting y algunas
 *     re-alocaciones (cancelaciones que liberan stock).
 * Toda la analítica (eventos, rollups, labor, ABC, auditoría IA) se deriva luego en
 * el arranque a partir de estos datos.
 */
export async function seedHighVolume(
  facade: WmsFacade,
  clock: SeedClock,
  nowMs: number,
  volume: number,
): Promise<void> {
  const DAY = 86400000;
  const H = 3600000;
  const opId = 'op-ninja';
  const sellerId = 'acme';
  const days = 60;

  // 10 operarios con velocidad de picking (u/h) y peso de carga distintos.
  // Los "extra" (no conocidos) se crean como usuarios OPERATOR.
  const OPERATORS: Array<{ id: string; name?: string; speed: number; weight: number }> = [
    { id: 'pedro', speed: 95, weight: 1.7 },
    { id: 'valentina', speed: 88, weight: 1.5 },
    { id: 'diego', speed: 80, weight: 1.3 },
    { id: 'op-camila', name: 'Camila', speed: 72, weight: 1.2 },
    { id: 'op-paula', name: 'Paula', speed: 66, weight: 1.1 },
    { id: 'sofia', speed: 60, weight: 1.0 },
    { id: 'matias', speed: 52, weight: 0.9 },
    { id: 'op-benjamin', name: 'Benjamín', speed: 46, weight: 0.8 },
    { id: 'op-ignacio', name: 'Ignacio', speed: 40, weight: 0.7 },
    { id: 'op-tomas', name: 'Tomás', speed: 34, weight: 0.6 },
  ];
  for (const o of OPERATORS) {
    if (!o.name) continue;
    await facade.createUser({ id: o.id, name: o.name, email: `${o.id.replace('op-', '')}@ninjahubs.cl`, role: UserRole.OPERATOR, operationId: opId, password: DEMO_PASSWORD }).catch(() => {});
  }
  const totalW = OPERATORS.reduce((s, o) => s + o.weight, 0);
  const rng = makeRng('vol:' + sellerId);
  const pickOperator = () => {
    let r = rng.next() * totalW;
    for (const o of OPERATORS) { r -= o.weight; if (r <= 0) return o; }
    return OPERATORS[0];
  };

  // Ubicaciones: una BULK de capacidad ilimitada para el buffer + un punto de
  // despacho con coordenadas (para la geometría G7).
  const locs = await facade.listLocations(opId);
  const recv = locs.find((l) => l.zoneType === ZoneType.RECEIVING) || locs[0];
  let bulk = locs.find((l) => l.code === 'BULK-01');
  if (!bulk) bulk = await facade.createLocation({ operationId: opId, code: 'BULK-01', zoneType: ZoneType.STORAGE, capacity: 0, pickRank: 3, x: 8, y: 8 });
  const storageLocs = locs.filter((l) => l.zoneType === ZoneType.STORAGE && l.code !== 'BULK-01');
  const reslotDest = storageLocs[0] || bulk;
  // Da coordenadas a las ubicaciones existentes que no las tengan (para G7).
  try {
    let gx = 1;
    for (const l of locs) { if (l.x == null) { await facade.setLocationGeometry(opId, l.id, { x: gx, y: (l.zoneType === ZoneType.SHIPPING || l.zoneType === ZoneType.PICKING) ? 0 : 2 + gx }); gx += 2; } }
  } catch { /* opcional */ }

  // Catálogo AMPLIO para el volumen: muchos SKUs mantienen cortas las cadenas de
  // movimientos por SKU (lecturas de stock rápidas) y dan un catálogo realista al LLM.
  const catalogSize = Math.max(80, Math.min(500, Math.round(volume / 150)));
  const existing = (await facade.listSkus(sellerId)).map((s) => s.sku);
  const CATEGORIES = ['CAM', 'PANT', 'ZAP', 'POL', 'CHAQ', 'GOR', 'BUF', 'CINT', 'MED', 'GUAN', 'BOT', 'MOCH', 'TAZ', 'LAP', 'CUAD', 'VEST', 'FALD', 'SHOR', 'TERM', 'BILL'];
  const COLORS = ['AZ', 'NG', 'BL', 'RJ', 'VD', 'GR', 'MR', 'AM', 'CF', 'NR'];
  const skus: string[] = [];
  clock.setNow(nowMs - (days + 3) * DAY);
  for (let i = 0; i < catalogSize; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    const col = COLORS[Math.floor(i / CATEGORIES.length) % COLORS.length];
    const size = SIZES[i % SIZES.length];
    const sku = `${cat}-${col}-${size}-${i}`;
    if (existing.includes(sku)) { skus.push(sku); continue; }
    const rotation = i < catalogSize * 0.2 ? RotationClass.A : i < catalogSize * 0.5 ? RotationClass.B : RotationClass.C;
    await facade.createSku(sellerId, { sku, description: `${cat} ${col} ${size}`, barcode: '78' + String(rng.int(1000000000, 1999999999)), rotationClass: rotation }).catch(() => {});
    skus.push(sku);
  }
  // Buffer de stock grande por SKU (retro-fechado antes de la ventana) → ningún picking falta.
  const perSku = Math.ceil((volume * 6) / skus.length) + 200;
  for (const sku of skus) {
    await facade.receive(sellerId, { sku, qty: perSku, locationId: bulk.id, reference: 'BUFFER-VOL' }).catch(() => {});
  }

  const CH = CHANNELS;
  const SUP = ['Importadora Andes', 'Textil Pacífico', 'Distribuidora Sur', 'Comercial Aconcagua'];
  const CARRIERS = ['Chilexpress', 'Starken', 'Blue Express', 'Correos de Chile'];
  const perDayBase = Math.ceil(volume / days);
  let made = 0;

  for (let d = days - 1; d >= 0 && made < volume; d--) {
    const dayStart = nowMs - d * DAY;
    const recency = 1 - d / days; // 0 (antiguo) → ~1 (hoy)
    const nOrders = Math.min(volume - made, Math.max(1, Math.round(perDayBase * (0.8 + 0.4 * recency))));

    // --- Recepción + guardado del día (inbound), por un operario ---
    if (rng.chance(0.85)) {
      try {
        const rsku = rng.pick(skus);
        const rqty = rng.int(200, 900);
        const receiver = pickOperator().id;
        clock.setNow(dayStart + 6 * H);
        const rord = await facade.createReceipt(sellerId, { supplier: rng.pick(SUP), reference: `GDV-${d}`, locationId: recv.id, lines: [{ sku: rsku, qty: rqty }] }, 'system');
        clock.setNow(dayStart + 6 * H + 20 * 60000);
        await facade.receiveReceipt(sellerId, rord.id, [{ lineNo: 1, qty: rqty }], receiver);
        clock.setNow(dayStart + 7 * H);
        await facade.putaway(sellerId, { sku: rsku, qty: rqty, fromLocationId: recv.id, toLocationId: reslotDest.id, reference: 'PUTAWAY-VOL', actor: pickOperator().id }).catch(() => {});
      } catch { /* omite el inbound del día si algo no cuadra */ }
    }
    // --- Re-slotting (transferencia entre ubicaciones) cada pocos días ---
    if (rng.chance(0.25) && reslotDest.id !== bulk.id) {
      try {
        clock.setNow(dayStart + 7 * H + 30 * 60000);
        await facade.putaway(sellerId, { sku: rng.pick(skus), qty: rng.int(20, 120), fromLocationId: bulk.id, toLocationId: reslotDest.id, reference: 'RESLOT-VOL', actor: pickOperator().id }).catch(() => {});
      } catch { /* omite */ }
    }

    // --- Órdenes del día (ciclo completo) ---
    for (let k = 0; k < nOrders && made < volume; k++) {
      const op = pickOperator();
      // Reparte los pedidos a lo largo de la jornada (08:00–18:00).
      const t0 = dayStart + 8 * H + Math.floor((k / Math.max(1, nOrders)) * 10 * H) + (k % 5) * 60000;
      const nLines = rng.chance(0.65) ? 1 : 2;
      const lines: Array<{ sku: string; qty: number }> = [];
      const used = new Set<string>();
      for (let l = 0; l < nLines; l++) {
        const sku = rng.pick(skus);
        if (used.has(sku)) continue;
        used.add(sku);
        lines.push({ sku, qty: rng.int(1, 10) });
      }
      const units = lines.reduce((s, l) => s + l.qty, 0);
      const idx = made;
      if (made > 0 && made % 2000 === 0) {
        // eslint-disable-next-line no-console
        console.log(`  [vol] ${made} órdenes… (+${((Date.now() - (globalThis as any).__volT0 || 0) / 1000).toFixed(1)}s)`);
      }
      if (made === 0) (globalThis as any).__volT0 = Date.now();
      try {
        clock.setNow(t0);
        const ord = await facade.createOrder(sellerId, {
          externalOrderId: `V-${sellerId.toUpperCase()}-${100000 + idx}`,
          salesChannel: rng.pick(CH),
          orderType: rng.chance(0.72) ? OrderType.B2C : OrderType.B2B,
          shipTo: { name: `${rng.pick(FIRST_NAMES)} (${rng.pick(CITIES)})` },
          lines,
        });
        clock.setNow(t0 + 60000);
        await facade.allocateOrder(sellerId, ord.id, op.id);
        // Re-alocación: ~2% se cancelan tras reservar (libera stock) y quedan así.
        if (rng.chance(0.02)) {
          clock.setNow(t0 + 90000);
          await facade.cancelOrder(sellerId, ord.id, op.id).catch(() => {});
          made++;
          continue;
        }
        // Picking: se captura la tarea con duración según la velocidad del operario
        // (unidades/velocidad), de modo que el reporte de productividad diferencie.
        const pickStart = t0 + 5 * 60000;
        const pickDurH = Math.max(0.02, units / op.speed);
        clock.setNow(pickStart);
        await facade.confirmPick(sellerId, ord.id, op.id);
        await facade.captureLaborTask({ operationId: opId, sellerId, operator: op.id, type: 'PICK', startAt: new Date(pickStart).toISOString(), endAt: new Date(pickStart + pickDurH * H).toISOString(), units, orderRef: ord.externalOrderId }).catch(() => {});
        // La mayoría se empaca y despacha; una fracción queda en PACKED.
        clock.setNow(pickStart + pickDurH * H + 2 * 60000);
        await facade.packOrder(sellerId, ord.id, { bultos: rng.int(1, 2) }, op.id);
        if (rng.chance(0.9)) {
          clock.setNow(pickStart + pickDurH * H + 7 * 60000);
          await facade.shipOrder(sellerId, ord.id, { carrier: rng.pick(CARRIERS), trackingNumber: `TRK${rng.int(1000000, 9999999)}` }, op.id);
        }
        made++;
      } catch {
        made++; // cuenta el intento aunque falle, para no colgar el bucle
      }
    }
  }
  clock.reset();
  // Ahora sí, crea el webhook de demostración (después de la carga, para no spamear).
  try {
    const ana = { id: 'ana', name: 'Ana', email: 'ana@ninjahubs.cl', role: UserRole.ADMIN, operationId: opId, sellerId: null, active: true };
    clock.setNow(nowMs - 30 * 3600000);
    const opHook = await facade.createWebhook(ana as any, { url: 'https://webhook.site/demo-op-ninja', events: ['order.allocated', 'order.picked', 'order.packed', 'order.shipped', 'order.cancelled', 'reception.received'] });
    clock.setNow(nowMs - 2 * 3600000);
    await facade.testWebhook(ana as any, opHook.id).catch(() => {});
    clock.reset();
  } catch { /* opcional */ }
  // eslint-disable-next-line no-console
  console.log(`Semilla de alto volumen: ${made} órdenes generadas en ${days} días con ${OPERATORS.length} operarios.`);
}

/**
 * Construye un PDF mínimo VÁLIDO (una página, texto) y lo devuelve en base64.
 * Se usa solo en la semilla como "documento tributario" de muestra para la demo.
 */
function demoTaxPdfBase64(lines: string[]): string {
  const escTxt = (s: string) => s.replace(/([()\\])/g, '\\$1');
  const body =
    'BT /F1 12 Tf 60 760 Td 18 TL ' + lines.map((l) => `(${escTxt(l)}) '`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}
