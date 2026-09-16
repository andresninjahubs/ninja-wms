/**
 * Tests del núcleo de dominio. Corren SIN base de datos ni framework.
 * Ejecutar:  npx tsx test/inventory.domain.test.ts
 *
 * Verifican los invariantes críticos del WMS:
 *  - stock = suma de movimientos
 *  - imposible dejar stock en negativo
 *  - aislamiento total entre sellers (incluida colisión de SKU)
 */
import assert from 'node:assert/strict';
import { InventoryService } from '../src/domain/inventory.service';
import { OrderService } from '../src/domain/order.service';
import { ReceiptOrderService } from '../src/domain/receipt.service';
import { ReturnService } from '../src/domain/return.service';
import { ProductService } from '../src/domain/product.service';
import { BillingService } from '../src/domain/billing.service';
import { PackagingService } from '../src/domain/packaging.service';
import { OpsChannelService, classifyHeuristic, insightsHeuristic } from '../src/domain/ops-channel.service';
import { parseCopilotIntent, buildInsights } from '../src/domain/copilot';
import { COPILOT_TOOLS, COPILOT_ACTION_TOOLS } from '../src/domain/copilot-tools';
import { deadlineBoost, deadlineState, nextCutoff, resolveDueAt } from '../src/domain/deadline';
import { PLANTILLAS, aplicarPatch, opsDePlantilla, primerHueco, transformar, validarWidget } from '../src/domain/ai-dashboard';
import { SCHEDULE_DEFAULT, estadoVentana, localEn, normalizarSchedule, resumenSchedule } from '../src/domain/agent-schedule';
import { InMemoryOpsChannelRepository } from '../src/infra/memory/in-memory.repositories';
import { MetricsService } from '../src/domain/metrics.service';
import { RollupService } from '../src/domain/rollup.service';
import { LaborService } from '../src/domain/labor.service';
import { AbcService } from '../src/domain/abc.service';
import { CostingService } from '../src/domain/costing.service';
import { PlatformUsageService } from '../src/domain/platform-usage.service';
import { AnnouncementService } from '../src/domain/announcement.service';
import { WebhookService } from '../src/domain/webhook.service';
import { LocalShippingLabelProvider } from '../src/infra/shipping/local-label-provider';
import { ChatService } from '../src/domain/chat.service';
import {
  ForbiddenError,
  InsufficientStockError,
  StockShortageError,
  NotFoundError,
  PlanLimitError,
  TenantViolationError,
  ValidationError,
} from '../src/domain/errors';
import { CycleCountStrategy, KitMode, MovementType, OrderStatus, OrderType, PickingStrategy, RotationClass, StockState, Uom, UserRole, ZoneType } from '../src/domain/types';
import { PutawayAdvisor } from '../src/domain/putaway.advisor';
import { CycleCountService } from '../src/domain/cyclecount.service';
import { UserService } from '../src/domain/user.service';
import { BarcodeService } from '../src/domain/barcode.service';
import { OperationService } from '../src/domain/operation.service';
import { WmsFacade } from '../src/app/wms.facade';
import {
  FixedClock,
  InMemoryLocationRepository,
  InMemoryLoginEventRepository,
  InMemoryAnnouncementRepository,
  InMemoryLotRepository,
  InMemorySerialRepository,
  InMemoryPackagingRepository,
  InMemoryMovementRepository,
  InMemoryOperationRepository,
  InMemoryOrderRepository,
  InMemoryReceiptOrderRepository,
  InMemoryReturnOrderRepository,
  InMemoryProductLogRepository,
  InMemoryAssemblyLogRepository,
  InMemoryBillingRepository,
  InMemoryChatRepository,
  InMemoryPackRepository,
  InMemorySellerRepository,
  InMemorySkuRepository,
  InMemoryUserRepository,
  InMemoryWebhookRepository,
  InMemoryAuthTokenRepository,
  InMemoryPlanConfigRepository,
  InMemoryCountAuditRepository,
  InMemoryEventRepository,
  InMemoryRollupRepository,
  InMemoryLaborTaskRepository,
  InMemoryCostRepository,
  InMemoryAiAuditRepository,
  InMemoryWorkAssignmentRepository,
  InMemoryWorkTaskRepository,
  InMemoryAgentRuleConfigRepository,
  InMemoryAgentAlertRepository,
  InMemoryAgentJournalRepository,
  InMemoryCopilotSettingsRepository,
  SequentialIdGenerator,
} from '../src/infra/memory/in-memory.repositories';
import { decidePolicy, effectiveAgentSettings } from '../src/domain/agent-policy';
import { LogEmailSender } from '../src/infra/email';
import { WebhookSender } from '../src/domain/ports';

/** Sender de webhooks NO-OP para buildFacade (no registra nada). */
class NoopWebhookSender implements WebhookSender {
  async send(): Promise<{ ok: boolean; status: number | null }> {
    return { ok: true, status: 200 };
  }
}

/** Sender FAKE que registra cada llamada (url, body, headers) para las aserciones. */
class FakeWebhookSender implements WebhookSender {
  calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  constructor(private readonly result: { ok: boolean; status: number | null; error?: string } = { ok: true, status: 200 }) {}
  async send(url: string, body: string, headers: Record<string, string>) {
    this.calls.push({ url, body, headers });
    return this.result;
  }
}

// ---- Mini harness (sin dependencias externas) -------------------------------
let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${(err as Error).message}`);
  }
}

async function expectThrows(fn: () => Promise<unknown>, ctor: new (...a: any[]) => Error) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ctor, `esperaba ${ctor.name}, vino ${(err as Error).constructor.name}`);
    return;
  }
  assert.fail(`esperaba que lanzara ${ctor.name}, no lanzó`);
}

// ---- Fixture ----------------------------------------------------------------
function buildFixture() {
  const movements = new InMemoryMovementRepository();
  const sellers = new InMemorySellerRepository();
  const skus = new InMemorySkuRepository();
  const locations = new InMemoryLocationRepository();
  const lots = new InMemoryLotRepository();
  const clock = new FixedClock();
  const service = new InventoryService(
    sellers,
    skus,
    locations,
    movements,
    new SequentialIdGenerator('mv'),
    clock,
    lots,
  );
  return { movements, sellers, skus, locations, lots, clock, service };
}

async function seedSellerA(f: ReturnType<typeof buildFixture>) {
  await f.sellers.save({ id: 'acme', operationId: 'op1', name: 'ACME', pickingStrategy: PickingStrategy.FIFO, cycleCountStrategy: CycleCountStrategy.ABC, active: true, webhooksClientEnabled: false, consolidateByLocation: false, courierPriority: [], autoAllocateOnIngest: false });
  await f.skus.save({
    sellerId: 'acme', sku: 'CAM-AZ-M', description: 'Camisa azul M',
    barcode: '7801234567890', lotControlled: false, serialControlled: false, expiryControlled: false, rotationClass: RotationClass.B, active: true, isKit: false, kitMode: null, components: [],
  });
  await f.locations.save({ id: 'RECV', operationId: 'op1', warehouseId: 'W1', code: 'RECV-01', zoneType: ZoneType.RECEIVING, capacity: 0, pickRank: 1, active: true });
  await f.locations.save({ id: 'A-03-2-B', operationId: 'op1', warehouseId: 'W1', code: 'A-03-2-B', zoneType: ZoneType.STORAGE, capacity: 100, pickRank: 1, active: true });
}

function buildOrderFixture() {
  const f = buildFixture();
  const orders = new InMemoryOrderRepository();
  const orderService = new OrderService(
    orders,
    f.service,
    f.sellers,
    f.skus,
    new SequentialIdGenerator('ord'),
    new FixedClock(),
  );
  return { ...f, orders, orderService };
}

const SHIP_TO = { name: 'Cliente Demo' };

async function qtyByState(f: ReturnType<typeof buildFixture>, sellerId: string, state: StockState) {
  const stock = await f.service.getStock({ sellerId });
  return stock.filter((b) => b.state === state).reduce((s, b) => s + b.qty, 0);
}

// ---- Tests ------------------------------------------------------------------
async function run() {
  console.log('\nInventoryService — invariantes del dominio\n');

  await test('recepción incrementa el stock disponible', async () => {
    const f = buildFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'RECV' });
    const stock = await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M' });
    const total = stock.reduce((s, b) => s + b.qty, 0);
    assert.equal(total, 10);
    assert.equal(stock[0].state, StockState.AVAILABLE);
  });

  await test('el stock es exactamente la suma de los movimientos', async () => {
    const f = buildFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'RECV' });
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 5, locationId: 'RECV' });
    const stock = await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M', locationId: 'RECV' });
    const ledgerSum = f.movements
      .all()
      .filter((m) => m.locationId === 'RECV')
      .reduce((s, m) => s + m.qtyDelta, 0);
    assert.equal(stock.reduce((s, b) => s + b.qty, 0), ledgerSum);
    assert.equal(ledgerSum, 15);
  });

  await test('el guardado traslada stock y conserva el total', async () => {
    const f = buildFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'RECV' });
    await f.service.putaway('acme', { sku: 'CAM-AZ-M', qty: 7, fromLocationId: 'RECV', toLocationId: 'A-03-2-B' });

    const atRecv = await f.service.getStock({ sellerId: 'acme', locationId: 'RECV' });
    const atStorage = await f.service.getStock({ sellerId: 'acme', locationId: 'A-03-2-B' });
    assert.equal(atRecv.reduce((s, b) => s + b.qty, 0), 3);
    assert.equal(atStorage.reduce((s, b) => s + b.qty, 0), 7);

    const grandTotal = (await f.service.getStock({ sellerId: 'acme' })).reduce((s, b) => s + b.qty, 0);
    assert.equal(grandTotal, 10); // nada se creó ni se perdió
  });

  await test('imposible guardar más de lo disponible (no-negativo)', async () => {
    const f = buildFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 4, locationId: 'RECV' });
    await expectThrows(
      () => f.service.putaway('acme', { sku: 'CAM-AZ-M', qty: 9, fromLocationId: 'RECV', toLocationId: 'A-03-2-B' }),
      InsufficientStockError,
    );
    // el stock quedó intacto
    const total = (await f.service.getStock({ sellerId: 'acme' })).reduce((s, b) => s + b.qty, 0);
    assert.equal(total, 4);
  });

  await test('aislamiento entre sellers: B no ve el stock de A', async () => {
    const f = buildFixture();
    await seedSellerA(f);
    await f.sellers.save({ id: 'globex', operationId: 'op1', name: 'Globex', pickingStrategy: PickingStrategy.FIFO, cycleCountStrategy: CycleCountStrategy.ABC, active: true, webhooksClientEnabled: false, consolidateByLocation: false, courierPriority: [], autoAllocateOnIngest: false });
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'RECV' });

    const seenByGlobex = await f.service.getStock({ sellerId: 'globex' });
    assert.equal(seenByGlobex.length, 0);
  });

  await test('mismo código de SKU en dos sellers no colisiona', async () => {
    const f = buildFixture();
    await seedSellerA(f);
    // Globex usa EXACTAMENTE el mismo código de SKU y la MISMA ubicación física (compartida)
    await f.sellers.save({ id: 'globex', operationId: 'op1', name: 'Globex', pickingStrategy: PickingStrategy.FIFO, cycleCountStrategy: CycleCountStrategy.ABC, active: true, webhooksClientEnabled: false, consolidateByLocation: false, courierPriority: [], autoAllocateOnIngest: false });
    await f.skus.save({
      sellerId: 'globex', sku: 'CAM-AZ-M', description: 'Otro producto distinto',
      barcode: '0000000000000', lotControlled: false, serialControlled: false, expiryControlled: false, rotationClass: RotationClass.B, active: true, isKit: false, kitMode: null, components: [],
    });

    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'RECV' });
    await f.service.receive('globex', { sku: 'CAM-AZ-M', qty: 3, locationId: 'RECV' });

    const acme = (await f.service.getStock({ sellerId: 'acme' })).reduce((s, b) => s + b.qty, 0);
    const globex = (await f.service.getStock({ sellerId: 'globex' })).reduce((s, b) => s + b.qty, 0);
    assert.equal(acme, 10); // cada uno ve solo lo suyo
    assert.equal(globex, 3);
  });

  await test('rechaza cantidades no positivas', async () => {
    const f = buildFixture();
    await seedSellerA(f);
    await expectThrows(() => f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 0, locationId: 'RECV' }), ValidationError);
    await expectThrows(() => f.service.receive('acme', { sku: 'CAM-AZ-M', qty: -5, locationId: 'RECV' }), ValidationError);
  });

  await test('rechaza seller, SKU o ubicación inexistentes', async () => {
    const f = buildFixture();
    await seedSellerA(f);
    await expectThrows(() => f.service.receive('fantasma', { sku: 'CAM-AZ-M', qty: 1, locationId: 'RECV' }), NotFoundError);
    await expectThrows(() => f.service.receive('acme', { sku: 'NO-EXISTE', qty: 1, locationId: 'RECV' }), NotFoundError);
    await expectThrows(() => f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 1, locationId: 'NO-EXISTE' }), NotFoundError);
  });

  // ---- Órdenes y reserva (allocation) ---------------------------------------
  console.log('\nOrderService — órdenes y reserva de stock\n');

  await test('ingreso de orden desde el OMS queda en estado RECEIVED', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-1', salesChannel: 'mercadolibre', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 3 }],
    });
    assert.equal(order.status, OrderStatus.RECEIVED);
    assert.equal(order.salesChannel, 'mercadolibre');
    assert.equal(order.orderType, OrderType.B2C);
    assert.equal(order.lines[0].allocations.length, 0); // aún no reserva
  });

  await test('reservar mueve stock de disponible a reservado (físico se conserva)', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });

    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-2', salesChannel: 'shopify', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 4 }],
    });
    const allocated = await f.orderService.allocate('acme', order.id);

    assert.equal(allocated.status, OrderStatus.ALLOCATED);
    assert.equal(await qtyByState(f, 'acme', StockState.AVAILABLE), 6); // 10 - 4
    assert.equal(await qtyByState(f, 'acme', StockState.RESERVED), 4);
    // físico total (disponible + reservado) sigue siendo 10
    const physical =
      (await qtyByState(f, 'acme', StockState.AVAILABLE)) +
      (await qtyByState(f, 'acme', StockState.RESERVED));
    assert.equal(physical, 10);
    // la reserva quedó anclada a una ubicación (guía el picking futuro)
    assert.equal(allocated.lines[0].allocations.reduce((s, a) => s + a.qty, 0), 4);
  });

  await test('no se puede reservar más de lo disponible (anti-sobreventa)', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 5, locationId: 'RECV' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-3', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 9 }],
    });
    await expectThrows(() => f.orderService.allocate('acme', order.id), InsufficientStockError);
    // nada quedó reservado y la orden sigue RECEIVED
    assert.equal(await qtyByState(f, 'acme', StockState.RESERVED), 0);
    assert.equal(await qtyByState(f, 'acme', StockState.AVAILABLE), 5);
    const reloaded = await f.orderService.getOrder('acme', order.id);
    assert.equal(reloaded!.status, OrderStatus.RECEIVED);
  });

  await test('orden multi-línea es full-or-nothing: si una línea falla, se revierte todo', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.skus.save({ sellerId: 'acme', sku: 'PANT-NG-42', description: 'Pantalón', barcode: null, lotControlled: false, serialControlled: false, expiryControlled: false, rotationClass: RotationClass.B, active: true, isKit: false, kitMode: null, components: [] });
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'RECV' });
    await f.service.receive('acme', { sku: 'PANT-NG-42', qty: 1, locationId: 'RECV' });

    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-4', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 5 }, { sku: 'PANT-NG-42', qty: 3 }], // 2da línea no alcanza
    });
    await expectThrows(() => f.orderService.allocate('acme', order.id), InsufficientStockError);
    // la 1ra línea NO debe quedar reservada (rollback)
    assert.equal(await qtyByState(f, 'acme', StockState.RESERVED), 0);
    assert.equal(await qtyByState(f, 'acme', StockState.AVAILABLE), 11);
  });

  await test('cancelar una orden libera el stock reservado', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-5', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 4 }],
    });
    await f.orderService.allocate('acme', order.id);
    assert.equal(await qtyByState(f, 'acme', StockState.RESERVED), 4);

    const cancelled = await f.orderService.cancel('acme', order.id);
    assert.equal(cancelled.status, OrderStatus.CANCELLED);
    assert.equal(await qtyByState(f, 'acme', StockState.RESERVED), 0);
    assert.equal(await qtyByState(f, 'acme', StockState.AVAILABLE), 10); // vuelve todo
  });

  await test('una orden con varios SKUs y distintas cantidades reserva cada línea', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.skus.save({ sellerId: 'acme', sku: 'PANT-NG-42', description: 'Pantalón', barcode: null, lotControlled: false, serialControlled: false, expiryControlled: false, rotationClass: RotationClass.B, active: true, isKit: false, kitMode: null, components: [] });
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    await f.service.receive('acme', { sku: 'PANT-NG-42', qty: 8, locationId: 'A-03-2-B' });

    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-M', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 3 }, { sku: 'PANT-NG-42', qty: 5 }],
    });
    const a = await f.orderService.allocate('acme', order.id);
    assert.equal(a.status, OrderStatus.ALLOCATED);
    assert.equal(a.lines.length, 2);
    assert.equal(await qtyByState(f, 'acme', StockState.RESERVED), 8); // 3 + 5
  });

  await test('una línea puede exigir un lote específico y reserva solo de ese lote', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B', lot: 'L1' });
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B', lot: 'L2' });

    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-L', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 6, lot: 'L2' }],
    });
    const allocated = await f.orderService.allocate('acme', order.id);
    const alloc = allocated.lines[0].allocations;
    assert.equal(alloc.reduce((s, x) => s + x.qty, 0), 6);
    assert.ok(alloc.every((x) => x.lot === 'L2'), 'todas las reservas deben ser del lote L2');

    const stock = await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M' });
    const availL1 = stock.filter((b) => b.state === StockState.AVAILABLE && b.lot === 'L1').reduce((s, b) => s + b.qty, 0);
    const availL2 = stock.filter((b) => b.state === StockState.AVAILABLE && b.lot === 'L2').reduce((s, b) => s + b.qty, 0);
    assert.equal(availL1, 10); // L1 intacto
    assert.equal(availL2, 4); // L2: 10 - 6
  });

  await test('si el lote pedido no alcanza, falla aunque otro lote tenga stock', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'RECV', lot: 'L1' });
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 2, locationId: 'RECV', lot: 'L2' });

    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-L2', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 5, lot: 'L2' }], // L2 solo tiene 2, aunque L1 tenga 10
    });
    await expectThrows(() => f.orderService.allocate('acme', order.id), InsufficientStockError);
    assert.equal(await qtyByState(f, 'acme', StockState.RESERVED), 0);
  });

  await test('ciclo completo B2C: reservar → pick list → pickear → despachar', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 20, locationId: 'A-03-2-B' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-C', salesChannel: 'shopify', orderType: OrderType.B2C, shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 8 }],
    });
    await f.orderService.allocate('acme', order.id);

    // pick list refleja las reservas (ubicación + cantidad)
    const tasks = await f.orderService.pickList('acme', order.id);
    assert.equal(tasks.reduce((s, t) => s + t.qty, 0), 8);
    assert.equal(tasks[0].locationId, 'A-03-2-B');

    // confirmar picking: el stock reservado sale de la bodega
    const picked = await f.orderService.confirmPick('acme', order.id);
    assert.equal(picked.status, OrderStatus.PICKED);
    assert.equal(await qtyByState(f, 'acme', StockState.RESERVED), 0); // ya no hay reservado
    const physical =
      (await qtyByState(f, 'acme', StockState.AVAILABLE)) + (await qtyByState(f, 'acme', StockState.RESERVED));
    assert.equal(physical, 12); // 20 − 8 despachados salieron del inventario

    // despacho: modo paquetería para B2C
    const shipped = await f.orderService.ship('acme', order.id, { carrier: 'chilexpress', trackingNumber: 'CX123' });
    assert.equal(shipped.status, OrderStatus.SHIPPED);
    assert.equal(shipped.shipment!.mode, 'parcel');
    assert.equal(shipped.shipment!.trackingNumber, 'CX123');
  });

  await test('despacho B2B usa modo transporte (freight)', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'B2B-1', salesChannel: 'b2b', orderType: OrderType.B2B, shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 5 }],
    });
    await f.orderService.allocate('acme', order.id);
    await f.orderService.confirmPick('acme', order.id);
    const shipped = await f.orderService.ship('acme', order.id, {});
    assert.equal(shipped.shipment!.mode, 'freight');
  });

  await test('no se puede despachar una orden que no está pickeada', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-D', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 3 }],
    });
    await f.orderService.allocate('acme', order.id);
    await expectThrows(() => f.orderService.ship('acme', order.id, {}), ValidationError);
  });

  await test('cancelar una orden PICKEADA devuelve el stock a su ubicación de origen', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-E', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 3 }],
    });
    await f.orderService.allocate('acme', order.id);
    await f.orderService.confirmPick('acme', order.id);
    // Tras el picking la mercadería salió de la ubicación: quedan 7 disponibles.
    const medio = await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M', locationId: 'A-03-2-B' });
    assert.equal(medio.filter((b) => b.state === 'AVAILABLE').reduce((a, b) => a + b.qty, 0), 7);
    const cancelada = await f.orderService.cancel('acme', order.id, 'pamela');
    assert.equal(cancelada.status, 'CANCELLED');
    // La mercadería NO vuelve sola al estante: está en un carro. Queda en la ubicación
    // de reposición, contada pero NO reservable, hasta que alguien la reponga.
    const enEstante = await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M', locationId: 'A-03-2-B' });
    assert.equal(enEstante.filter((b) => b.state === 'AVAILABLE').reduce((a, b) => a + b.qty, 0), 7, 'el estante sigue con 7: nadie la repuso todavía');
    assert.equal(enEstante.filter((b) => b.state === 'RESERVED').reduce((a, b) => a + b.qty, 0), 0, 'sin reservas colgando');
    const total = (await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M' })).reduce((a, b) => a + b.qty, 0);
    assert.equal(total, 10, 'el total del ledger sí vuelve a 10: la mercadería existe');
    const ev = (cancelada.events || []).filter((e) => e.type === 'CANCELLED').pop();
    assert.ok(String(ev?.detail || '').includes('pendientes de reposición'), 'el evento avisa que queda por reponer');
  });

  await test('cancelar una orden EMPACADA también devuelve el stock a su ubicación', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-P1', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 4 }],
    });
    await f.orderService.allocate('acme', order.id);
    await f.orderService.confirmPick('acme', order.id);
    await f.orderService.packOrder('acme', order.id, { bultos: 1 });
    const cancelada = await f.orderService.cancel('acme', order.id, 'pamela');
    assert.equal(cancelada.status, 'CANCELLED');
    const total = (await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M' })).reduce((a, b) => a + b.qty, 0);
    assert.equal(total, 10, 'las 4 volvieron al inventario, pendientes de reposición');
    const ev = (cancelada.events || []).filter((e) => e.type === 'CANCELLED').pop();
    assert.ok(String(ev?.detail || '').includes('embalaje'), 'avisa que los insumos de embalaje no se reponen');
  });

  await test('cancelar con picking PARCIAL: libera lo reservado y devuelve solo lo recolectado', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-P2', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 5 }],
    });
    await f.orderService.allocate('acme', order.id);
    const pl = await f.orderService.pickList('acme', order.id);
    await f.orderService.pickTask('acme', order.id, { sku: 'CAM-AZ-M', locationId: pl[0].locationId, qty: 2 });
    const cancelada = await f.orderService.cancel('acme', order.id, 'pamela');
    const estante = await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M', locationId: 'A-03-2-B' });
    assert.equal(estante.filter((b) => b.state === 'AVAILABLE').reduce((a, b) => a + b.qty, 0), 8, 'las 3 reservadas vuelven al estante de inmediato');
    assert.equal(estante.filter((b) => b.state === 'RESERVED').reduce((a, b) => a + b.qty, 0), 0);
    const total = (await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M' })).reduce((a, b) => a + b.qty, 0);
    assert.equal(total, 10, 'el total vuelve a 10 sin inventar stock');
    const ev = (cancelada.events || []).filter((e) => e.type === 'CANCELLED').pop();
    assert.ok(String(ev?.detail || '').includes('3 un liberadas'), 'las 3 no recolectadas se liberan');
    assert.ok(String(ev?.detail || '').includes('2 un recolectadas quedan pendientes'), 'las 2 recolectadas quedan por reponer');
  });

  await test('las órdenes NO se eliminan en ningún estado: se cancelan', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-D1', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 1 }],
    });
    await expectThrows(() => f.orderService.delete('acme', order.id), ValidationError);
    await f.orderService.cancel('acme', order.id);
    await expectThrows(() => f.orderService.delete('acme', order.id), ValidationError);
    assert.ok(await f.orderService.getOrder('acme', order.id), 'la orden sigue existiendo');
  });

  await test('reposición: cancelar deja una tarea asignable que devuelve el stock a su sitio', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 5000, pickRank: 1 });
    await f.facade.createUser({ id: 'opa', name: 'Op A', email: 'opa@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 20, locationId: stg.id });
    const o = await f.facade.createOrder('acme', {
      externalOrderId: 'WEB-REP-1', salesChannel: 'web', shipTo: { name: 'x' } as any,
      lines: [{ sku: 'CAM', qty: 6 }],
    });
    await f.facade.allocateOrder('acme', o.id);
    await f.facade.confirmPick('acme', o.id, 'opa');
    await f.facade.cancelOrder('acme', o.id, 'pamela');

    // 1) Aparece una tarea de reposición, con el destino sugerido = de donde salió.
    const pool = await f.facade.getTaskPool('op1', 'RESTOCK');
    assert.equal(pool.length, 1, 'hay una tarea de reposición pendiente');
    assert.equal(pool[0].unidades, 6);
    assert.equal(pool[0].note, stg.id, 'sugiere devolver a la ubicación de origen');
    assert.ok(String(pool[0].entityRef).includes('A-01-1-A'), 'la referencia muestra el destino sugerido');

    // 2) Ese stock NO es reservable mientras espera: otra orden no lo puede comprometer.
    const o2 = await f.facade.createOrder('acme', {
      externalOrderId: 'WEB-REP-2', salesChannel: 'web', shipTo: { name: 'x' } as any,
      lines: [{ sku: 'CAM', qty: 20 }],
    });
    await expectThrows(() => f.facade.allocateOrder('acme', o2.id), InsufficientStockError);

    // 3) Es asignable a un operario como cualquier otra tarea.
    await f.facade.assignTask('op1', { type: 'RESTOCK', entityId: pool[0].entityId, entityRef: pool[0].entityRef, sellerId: 'acme', operator: 'opa', unitsEstimate: 6, by: 'sup' });
    const mias = await f.facade.getOperatorTasks('op1', 'opa');
    assert.ok(mias.some((t: any) => t.type === 'RESTOCK'), 'la ve en su bandeja');

    // 4) Al ejecutarla, el stock vuelve al estante y la tarea se cierra.
    const repoLoc = (await f.facade.listLocations('op1')).find((l) => l.code === 'DEV-REPOSICION')!;
    await f.facade.putaway('acme', { sku: 'CAM', qty: 6, fromLocationId: repoLoc.id, toLocationId: stg.id, actor: 'opa' });
    const enEstante = (await f.facade.getStock({ sellerId: 'acme', sku: 'CAM', locationId: stg.id }))
      .filter((b: any) => b.state === 'AVAILABLE').reduce((a: number, b: any) => a + b.qty, 0);
    assert.equal(enEstante, 20, 'las 6 volvieron a su ubicación');
    assert.equal((await f.facade.getTaskPool('op1', 'RESTOCK')).length, 0, 'la tarea ya no está pendiente');
    assert.ok(!(await f.facade.getOperatorTasks('op1', 'opa')).some((t: any) => t.type === 'RESTOCK'), 'salió de la bandeja');
  });

  await test('una orden DESPACHADA no se cancela: corresponde una devolución', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-E2', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 3 }],
    });
    await f.orderService.allocate('acme', order.id);
    await f.orderService.confirmPick('acme', order.id);
    await f.orderService.ship('acme', order.id, { carrier: 'Chilexpress' });
    await expectThrows(() => f.orderService.cancel('acme', order.id), ValidationError);
  });

  await test('aislamiento: un seller no ve las órdenes de otro', async () => {
    const f = buildOrderFixture();
    await seedSellerA(f);
    await f.sellers.save({ id: 'globex', operationId: 'op1', name: 'Globex', pickingStrategy: PickingStrategy.FIFO, cycleCountStrategy: CycleCountStrategy.ABC, active: true, webhooksClientEnabled: false, consolidateByLocation: false, courierPriority: [], autoAllocateOnIngest: false });
    const order = await f.orderService.createOrder('acme', {
      externalOrderId: 'SHOP-6', salesChannel: 'web', shipTo: SHIP_TO,
      lines: [{ sku: 'CAM-AZ-M', qty: 1 }],
    });
    // Globex no puede leer la orden de ACME
    assert.equal(await f.orderService.getOrder('globex', order.id), null);
    assert.equal((await f.orderService.listOrders('globex')).length, 0);
  });

  console.log('\nPutawayAdvisor — guardado caótico dirigido\n');

  async function seedWarehouse(f: ReturnType<typeof buildFixture>, rotation: RotationClass) {
    await f.sellers.save({ id: 'acme', operationId: 'op1', name: 'ACME', pickingStrategy: PickingStrategy.FIFO, cycleCountStrategy: CycleCountStrategy.ABC, active: true, webhooksClientEnabled: false, consolidateByLocation: false, courierPriority: [], autoAllocateOnIngest: false });
    await f.skus.save({
      sellerId: 'acme', sku: 'SKU1', description: 'Producto', barcode: null,
      lotControlled: false, serialControlled: false, expiryControlled: false, rotationClass: rotation, active: true, isKit: false, kitMode: null, components: [],
    });
    await f.locations.save({ id: 'RECV', operationId: 'op1', warehouseId: 'W1', code: 'RECV-01', zoneType: ZoneType.RECEIVING, capacity: 0, pickRank: 1, active: true });
    await f.locations.save({ id: 'S1', operationId: 'op1', warehouseId: 'W1', code: 'S1', zoneType: ZoneType.STORAGE, capacity: 100, pickRank: 1, active: true });
    await f.locations.save({ id: 'S2', operationId: 'op1', warehouseId: 'W1', code: 'S2', zoneType: ZoneType.STORAGE, capacity: 100, pickRank: 2, active: true });
    await f.locations.save({ id: 'S3', operationId: 'op1', warehouseId: 'W1', code: 'S3', zoneType: ZoneType.STORAGE, capacity: 100, pickRank: 3, active: true });
  }

  await test('clase A sugiere la ubicación más cercana a picking', async () => {
    const f = buildFixture();
    await seedWarehouse(f, RotationClass.A);
    const advisor = new PutawayAdvisor(f.sellers, f.skus, f.locations, f.movements);
    const sug = await advisor.suggest('acme', { sku: 'SKU1', qty: 10 });
    assert.equal(sug[0].locationCode, 'S1'); // pickRank 1
  });

  await test('clase C sugiere la ubicación más lejana (libera zona rápida)', async () => {
    const f = buildFixture();
    await seedWarehouse(f, RotationClass.C);
    const advisor = new PutawayAdvisor(f.sellers, f.skus, f.locations, f.movements);
    const sug = await advisor.suggest('acme', { sku: 'SKU1', qty: 10 });
    assert.equal(sug[0].locationCode, 'S3'); // pickRank 3
  });

  await test('la consolidación gana: sugiere donde el SKU ya está', async () => {
    const f = buildFixture();
    await seedWarehouse(f, RotationClass.A); // A preferiría S1...
    // ...pero ya hay stock del SKU en S2 (consolidación debe ganar)
    await f.service.receive('acme', { sku: 'SKU1', qty: 5, locationId: 'RECV' });
    await f.service.putaway('acme', { sku: 'SKU1', qty: 5, fromLocationId: 'RECV', toLocationId: 'S2' });
    const advisor = new PutawayAdvisor(f.sellers, f.skus, f.locations, f.movements);
    const sug = await advisor.suggest('acme', { sku: 'SKU1', qty: 3 });
    assert.equal(sug[0].locationCode, 'S2');
    assert.ok(sug[0].reasons.some((r) => r.includes('consolidación')));
  });

  await test('respeta la capacidad: excluye ubicaciones que no caben', async () => {
    const f = buildFixture();
    await f.sellers.save({ id: 'acme', operationId: 'op1', name: 'ACME', pickingStrategy: PickingStrategy.FIFO, cycleCountStrategy: CycleCountStrategy.ABC, active: true, webhooksClientEnabled: false, consolidateByLocation: false, courierPriority: [], autoAllocateOnIngest: false });
    await f.skus.save({ sellerId: 'acme', sku: 'SKU1', description: 'P', barcode: null, lotControlled: false, serialControlled: false, expiryControlled: false, rotationClass: RotationClass.A, active: true, isKit: false, kitMode: null, components: [] });
    await f.locations.save({ id: 'RECV', operationId: 'op1', warehouseId: 'W1', code: 'RECV-01', zoneType: ZoneType.RECEIVING, capacity: 0, pickRank: 1, active: true });
    await f.locations.save({ id: 'SMALL', operationId: 'op1', warehouseId: 'W1', code: 'SMALL', zoneType: ZoneType.STORAGE, capacity: 10, pickRank: 1, active: true });
    await f.locations.save({ id: 'BIG', operationId: 'op1', warehouseId: 'W1', code: 'BIG', zoneType: ZoneType.STORAGE, capacity: 100, pickRank: 3, active: true });
    // Llenar SMALL a tope
    await f.service.receive('acme', { sku: 'SKU1', qty: 10, locationId: 'RECV' });
    await f.service.putaway('acme', { sku: 'SKU1', qty: 10, fromLocationId: 'RECV', toLocationId: 'SMALL' });
    const advisor = new PutawayAdvisor(f.sellers, f.skus, f.locations, f.movements);
    // Necesito 5 más: SMALL no tiene espacio, aunque esté consolidado y sea clase A
    const sug = await advisor.suggest('acme', { sku: 'SKU1', qty: 5 });
    assert.ok(!sug.some((s) => s.locationCode === 'SMALL'), 'SMALL no debe sugerirse (lleno)');
    assert.equal(sug[0].locationCode, 'BIG');
  });

  console.log('\nEstrategia de picking configurable por seller\n');

  async function seedStrategySeller(f: ReturnType<typeof buildFixture>, strategy: PickingStrategy) {
    await f.sellers.save({ id: 'acme', operationId: 'op1', name: 'ACME', pickingStrategy: strategy, cycleCountStrategy: CycleCountStrategy.ABC, active: true, webhooksClientEnabled: false, consolidateByLocation: false, courierPriority: [], autoAllocateOnIngest: false });
    await f.skus.save({ sellerId: 'acme', sku: 'MED-1', description: 'Medicamento', barcode: null, lotControlled: true, serialControlled: false, expiryControlled: false, rotationClass: RotationClass.A, active: true, isKit: false, kitMode: null, components: [] });
    await f.locations.save({ id: 'RECV', operationId: 'op1', warehouseId: 'W1', code: 'RECV-01', zoneType: ZoneType.RECEIVING, capacity: 0, pickRank: 1, active: true });
    await f.locations.save({ id: 'STG', operationId: 'op1', warehouseId: 'W1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1, active: true });
  }

  await test('FIFO: reserva primero el lote recibido antes', async () => {
    const f = buildFixture();
    await seedStrategySeller(f, PickingStrategy.FIFO);
    f.clock.set('2026-01-01T00:00:00.000Z');
    await f.service.receive('acme', { sku: 'MED-1', qty: 10, locationId: 'STG', lot: 'L1' });
    f.clock.set('2026-03-01T00:00:00.000Z');
    await f.service.receive('acme', { sku: 'MED-1', qty: 10, locationId: 'STG', lot: 'L2' });
    const allocs = await f.service.reserve('acme', { sku: 'MED-1', qty: 6 });
    assert.ok(allocs.every((a) => a.lot === 'L1'), 'FIFO debe tomar del lote más antiguo (L1)');
  });

  await test('FEFO: reserva primero el lote que vence antes', async () => {
    const f = buildFixture();
    await seedStrategySeller(f, PickingStrategy.FEFO);
    // L1 llega antes pero vence después; L2 llega después pero vence antes
    f.clock.set('2026-01-01T00:00:00.000Z');
    await f.service.receive('acme', { sku: 'MED-1', qty: 10, locationId: 'STG', lot: 'L1', expiry: '2027-12-31T00:00:00.000Z' });
    f.clock.set('2026-02-01T00:00:00.000Z');
    await f.service.receive('acme', { sku: 'MED-1', qty: 10, locationId: 'STG', lot: 'L2', expiry: '2026-06-30T00:00:00.000Z' });
    const allocs = await f.service.reserve('acme', { sku: 'MED-1', qty: 6 });
    assert.ok(allocs.every((a) => a.lot === 'L2'), 'FEFO debe tomar del que vence antes (L2)');
  });

  await test('LOT_DIRECTED: exige que la orden indique el lote', async () => {
    const f = buildFixture();
    await seedStrategySeller(f, PickingStrategy.LOT_DIRECTED);
    await f.service.receive('acme', { sku: 'MED-1', qty: 10, locationId: 'STG', lot: 'L1' });
    // Sin lote -> rechaza
    await expectThrows(() => f.service.reserve('acme', { sku: 'MED-1', qty: 3 }), ValidationError);
    // Con lote -> ok
    const allocs = await f.service.reserve('acme', { sku: 'MED-1', qty: 3, lot: 'L1' });
    assert.equal(allocs.reduce((s, a) => s + a.qty, 0), 3);
  });

  console.log('\nCycleCountService — conteo cíclico configurable\n');

  function buildCountFixture() {
    const f = buildFixture();
    const cc = new CycleCountService(f.sellers, f.skus, f.locations, f.movements, new SequentialIdGenerator('cc'), f.clock);
    return { ...f, cc };
  }

  await test('conteo con faltante ajusta el ledger y reporta varianza', async () => {
    const f = buildCountFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 10, locationId: 'A-03-2-B' });
    // El operario cuenta solo 8 (faltan 2)
    const res = await f.cc.performCount('acme', 'A-03-2-B', [{ sku: 'CAM-AZ-M', lot: null, countedQty: 8 }]);
    assert.equal(res.accurate, false);
    assert.equal(res.variances[0].delta, -2);
    assert.equal(res.adjustedUnits, 2);
    // El stock del sistema quedó reconciliado a 8
    const stock = await f.service.getStock({ sellerId: 'acme', locationId: 'A-03-2-B' });
    assert.equal(stock.reduce((s, b) => s + b.qty, 0), 8);
  });

  await test('conteo exacto no genera ajustes', async () => {
    const f = buildCountFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 5, locationId: 'A-03-2-B' });
    const res = await f.cc.performCount('acme', 'A-03-2-B', [{ sku: 'CAM-AZ-M', lot: null, countedQty: 5 }]);
    assert.equal(res.accurate, true);
    assert.equal(res.variances.length, 0);
  });

  await test('planificador ABC prioriza los SKU de clase A', async () => {
    const f = buildCountFixture();
    await f.sellers.save({ id: 'acme', operationId: 'op1', name: 'ACME', pickingStrategy: PickingStrategy.FIFO, cycleCountStrategy: CycleCountStrategy.ABC, active: true, webhooksClientEnabled: false, consolidateByLocation: false, courierPriority: [], autoAllocateOnIngest: false });
    await f.skus.save({ sellerId: 'acme', sku: 'C-ITEM', description: 'C', barcode: null, lotControlled: false, serialControlled: false, expiryControlled: false, rotationClass: RotationClass.C, active: true, isKit: false, kitMode: null, components: [] });
    await f.skus.save({ sellerId: 'acme', sku: 'A-ITEM', description: 'A', barcode: null, lotControlled: false, serialControlled: false, expiryControlled: false, rotationClass: RotationClass.A, active: true, isKit: false, kitMode: null, components: [] });
    const tasks = await f.cc.planCounts('acme');
    assert.equal(tasks[0].ref, 'A-ITEM'); // la clase A va primero
  });

  console.log('\nUserService — usuarios, roles y permisos\n');

  function buildUsers() {
    return new UserService(new InMemoryUserRepository(), new SequentialIdGenerator('usr'));
  }

  await test('crear usuario y autenticar por id o email', async () => {
    const svc = buildUsers();
    const u = await svc.createUser({ name: 'Ana', email: 'Ana@NH.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    assert.equal(u.email, 'ana@nh.cl'); // normalizado
    assert.equal((await svc.authenticate(u.id))?.id, u.id);
    assert.equal((await svc.authenticate('ana@nh.cl'))?.id, u.id);
  });

  await test('no permite dos usuarios con el mismo email', async () => {
    const svc = buildUsers();
    await svc.createUser({ name: 'Ana', email: 'a@nh.cl', role: UserRole.ADMIN, operationId: 'op1' });
    await expectThrows(() => svc.createUser({ name: 'Otro', email: 'a@nh.cl', role: UserRole.OPERATOR, operationId: 'op1' }), ValidationError);
  });

  await test('un usuario CLIENT exige sellerId', async () => {
    const svc = buildUsers();
    await expectThrows(() => svc.createUser({ name: 'Cli', email: 'c@nh.cl', role: UserRole.CLIENT, operationId: 'op1' }), ValidationError);
    const ok = await svc.createUser({ name: 'Cli', email: 'c2@nh.cl', role: UserRole.CLIENT, operationId: 'op1', sellerId: 'acme' });
    assert.equal(ok.sellerId, 'acme');
  });

  await test('OPERATOR puede recibir pero no cancelar órdenes', async () => {
    const svc = buildUsers();
    const op = await svc.createUser({ name: 'Op', email: 'op@nh.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    svc.authorize(op, 'inventory:receive'); // no lanza
    await expectThrows(async () => svc.authorize(op, 'order:cancel'), ForbiddenError);
  });

  await test('CLIENT solo ve su propio seller (frontera multi-tenant)', async () => {
    const svc = buildUsers();
    const cli = await svc.createUser({ name: 'Cli', email: 'cli@nh.cl', role: UserRole.CLIENT, operationId: 'op1', sellerId: 'acme' });
    svc.authorize(cli, 'stock:read', { sellerId: 'acme' }); // su seller: ok
    await expectThrows(async () => svc.authorize(cli, 'stock:read', { sellerId: 'globex' }), ForbiddenError); // otro seller: prohibido
    // El CLIENT (seller) puede registrar recepciones de SU propia mercadería…
    svc.authorize(cli, 'inventory:receive', { sellerId: 'acme' }); // su seller: ok
    // …pero no de otro seller (frontera), ni acciones de bodega (sin permiso).
    await expectThrows(async () => svc.authorize(cli, 'inventory:receive', { sellerId: 'globex' }), ForbiddenError);
    await expectThrows(async () => svc.authorize(cli, 'inventory:putaway', { sellerId: 'acme' }), ForbiddenError);
  });

  await test('solo ADMIN gestiona usuarios; SUPERVISOR no', async () => {
    const svc = buildUsers();
    const admin = await svc.createUser({ name: 'Adm', email: 'adm@nh.cl', role: UserRole.ADMIN, operationId: 'op1' });
    const sup = await svc.createUser({ name: 'Sup', email: 'sup@nh.cl', role: UserRole.SUPERVISOR, operationId: 'op1' });
    svc.authorize(admin, 'user:manage'); // ok
    await expectThrows(async () => svc.authorize(sup, 'user:manage'), ForbiddenError);
  });

  await test('el usuario queda como actor en el movimiento del ledger', async () => {
    const f = buildFixture();
    await seedSellerA(f);
    await f.service.receive('acme', { sku: 'CAM-AZ-M', qty: 5, locationId: 'RECV', actor: 'usr-ana' });
    const mv = f.movements.all().find((m) => m.type === 'RECEIPT');
    assert.equal(mv?.actor, 'usr-ana');
  });

  await test('usuario inactivo no pasa autorización', async () => {
    const svc = buildUsers();
    const u = await svc.createUser({ name: 'X', email: 'x@nh.cl', role: UserRole.ADMIN, operationId: 'op1' });
    await svc.deactivateUser(u.id);
    const off = await svc.getUser(u.id);
    await expectThrows(async () => svc.authorize(off!, 'stock:read'), ForbiddenError);
    assert.equal(await svc.authenticate(u.id), null); // tampoco autentica
  });

  console.log('\nBarcodeService — códigos de barra y unidades de medida\n');

  async function buildBarcodes() {
    const f = buildFixture();
    await seedSellerA(f); // seller acme + sku CAM-AZ-M
    const packs = new InMemoryPackRepository();
    const bc = new BarcodeService(packs, f.skus, f.sellers);
    return { ...f, packs, bc };
  }

  await test('registrar EAN (unidad) y DUN (caja) y resolver cada código', async () => {
    const f = await buildBarcodes();
    await f.bc.registerPack('acme', { sku: 'CAM-AZ-M', code: 'EA', barcode: '7801234567890', factor: 1 });
    await f.bc.registerPack('acme', { sku: 'CAM-AZ-M', code: 'CASE', barcode: '17801234567897', factor: 12, label: 'Caja x12' });
    assert.equal((await f.bc.resolve('acme', '7801234567890')).code, 'EA');
    const caja = await f.bc.resolve('acme', '17801234567897');
    assert.equal(caja.code, 'CASE');
    assert.equal(caja.factor, 12);
  });

  await test('escanear una caja se traduce a múltiplos del EAN', async () => {
    const f = await buildBarcodes();
    await f.bc.registerPack('acme', { sku: 'CAM-AZ-M', code: 'CASE', barcode: 'DUN-1', factor: 12 });
    const r = await f.bc.toBaseUnits('acme', 'DUN-1', 2); // 2 cajas
    assert.equal(r.sku, 'CAM-AZ-M');
    assert.equal(r.baseQty, 24); // 2 * 12
  });

  await test('recepción por escaneo deja el stock en unidades base', async () => {
    const f = await buildBarcodes();
    await f.bc.registerPack('acme', { sku: 'CAM-AZ-M', code: 'CASE', barcode: 'DUN-2', factor: 12 });
    const r = await f.bc.toBaseUnits('acme', 'DUN-2', 3); // 3 cajas = 36 un
    await f.service.receive('acme', { sku: r.sku, qty: r.baseQty, locationId: 'RECV' });
    const total = (await f.service.getStock({ sellerId: 'acme', sku: 'CAM-AZ-M' })).reduce((s, b) => s + b.qty, 0);
    assert.equal(total, 36);
  });

  await test('código desconocido no resuelve', async () => {
    const f = await buildBarcodes();
    await expectThrows(() => f.bc.resolve('acme', 'NO-EXISTE'), NotFoundError);
  });

  await test('un mismo código no puede apuntar a dos SKU/niveles distintos', async () => {
    const f = await buildBarcodes();
    await f.skus.save({ sellerId: 'acme', sku: 'OTRO', description: 'Otro', barcode: null, lotControlled: false, serialControlled: false, expiryControlled: false, rotationClass: RotationClass.B, active: true, isKit: false, kitMode: null, components: [] });
    await f.bc.registerPack('acme', { sku: 'CAM-AZ-M', code: 'EA', barcode: 'DUP-1', factor: 1 });
    await expectThrows(() => f.bc.registerPack('acme', { sku: 'OTRO', code: 'EA', barcode: 'DUP-1', factor: 1 }), ValidationError);
  });

  console.log('\nEscaneo en guardado y picking (integración vía fachada)\n');

  function buildFacade() {
    const movements = new InMemoryMovementRepository();
    const sellers = new InMemorySellerRepository();
    const skus = new InMemorySkuRepository();
    const locations = new InMemoryLocationRepository();
    const events = new InMemoryEventRepository();
    const orders = new InMemoryOrderRepository(events);
    const lots = new InMemoryLotRepository();
    const users = new InMemoryUserRepository();
    const packs = new InMemoryPackRepository();
    const ids = new SequentialIdGenerator('id');
    const clock = new FixedClock();
    const inventory = new InventoryService(sellers, skus, locations, movements, ids, clock, lots);
    const receipts = new InMemoryReceiptOrderRepository(events);
    const orderService = new OrderService(orders, inventory, sellers, skus, ids, clock, receipts);
    const serials = new InMemorySerialRepository();
    const packagingRepo = new InMemoryPackagingRepository();
    const packagingService = new PackagingService(packagingRepo, ids, clock);
    const receiptService = new ReceiptOrderService(receipts, inventory, sellers, skus, locations, ids, clock, serials);
    const advisor = new PutawayAdvisor(sellers, skus, locations, movements);
    const countAudits = new InMemoryCountAuditRepository();
    const cyc = new CycleCountService(sellers, skus, locations, movements, ids, clock, countAudits);
    const userSvc = new UserService(users, ids);
    const bc = new BarcodeService(packs, skus, sellers);
    const productLogs = new InMemoryProductLogRepository();
    const assemblyLogs = new InMemoryAssemblyLogRepository();
    const productService = new ProductService(skus, productLogs, sellers, inventory, bc, ids, clock, assemblyLogs);
    const billingRepo = new InMemoryBillingRepository();
    const billingService = new BillingService(billingRepo, movements, locations, orders, assemblyLogs, sellers, ids, clock, packagingService);
    const rollups = new InMemoryRollupRepository();
    const laborTasks = new InMemoryLaborTaskRepository();
    const metricsService = new MetricsService(movements, orders, receipts, clock, events, rollups);
    const rollupService = new RollupService(movements, sellers, rollups, clock, events, orders);
    const laborService = new LaborService(movements, sellers, laborTasks, ids, clock);
    const aiAudit = new InMemoryAiAuditRepository();
    const abcService = new AbcService(sellers, skus, movements, clock);
    const assignments = new InMemoryWorkAssignmentRepository();
    const taskLedger = new InMemoryWorkTaskRepository();
    const agentRuleConfig = new InMemoryAgentRuleConfigRepository();
    const agentAlertRepo = new InMemoryAgentAlertRepository();
    const agentJournal = new InMemoryAgentJournalRepository();
    const copilotSettings = new InMemoryCopilotSettingsRepository();
    const costs = new InMemoryCostRepository();
    const costingService = new CostingService(costs, sellers, users, billingService, movements, laborTasks, clock, rollups, packagingService);
    const chatService = new ChatService(new InMemoryChatRepository(), sellers, clock);
    const ops = new InMemoryOperationRepository();
    const opSvc = new OperationService(ops, ids);
    const logins = new InMemoryLoginEventRepository();
    const platformUsageService = new PlatformUsageService(ops, sellers, users, movements, orders, receipts, billingRepo, logins, ids, clock);
    const announcementService = new AnnouncementService(new InMemoryAnnouncementRepository(), ids, clock);
    const webhookRepo = new InMemoryWebhookRepository();
    const webhookService = new WebhookService(webhookRepo, sellers, new NoopWebhookSender(), ids, clock);
    const shippingLabels = new LocalShippingLabelProvider(ids, clock);
    const returnsRepo = new InMemoryReturnOrderRepository(events);
    const returnService = new ReturnService(returnsRepo, orders, inventory, sellers, skus, locations, ids, clock);
    const authTokens = new InMemoryAuthTokenRepository();
    const emailSender = new LogEmailSender();
    const planConfig = new InMemoryPlanConfigRepository();
    const facade = new WmsFacade(inventory, orderService, receiptService, productService, billingService, sellers, skus, locations, ids, advisor, cyc, userSvc, bc, opSvc, metricsService, chatService, platformUsageService, announcementService, webhookService, shippingLabels, returnService, serials, packagingService,
      undefined, undefined, clock, undefined, undefined, copilotSettings, authTokens, emailSender, planConfig, countAudits, events, rollupService, laborService, aiAudit, abcService, assignments, costingService, taskLedger, agentRuleConfig, agentAlertRepo, agentJournal);
    return { facade, inventory, clock, webhookService, webhookRepo, serials, packagingService, billingService, authTokens, orders, countAudits, events, rollups, laborTasks, rollupService, laborService, metricsService, movements, aiAudit, abcService, skus, assignments, users, costingService, taskLedger, agentRuleConfig, agentAlertRepo, agentJournal, copilotSettings };
  }

  async function seedScan(facade: WmsFacade) {
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa', barcode: 'EAN-1' }); // base auto
    await facade.registerPack('acme', { sku: 'CAM', code: 'CASE', barcode: 'DUN-1', factor: 12 });
    return { recv, stg };
  }

  await test('escaneo: recepción → guardado mueve unidades base entre ubicaciones', async () => {
    const { facade } = buildFacade();
    const { recv, stg } = await seedScan(facade);
    await facade.scanInbound('acme', { barcode: 'DUN-1', packCount: 2, locationId: recv.id }); // 24 en RECV
    const r = await facade.scanPutaway('acme', {
      productBarcode: 'DUN-1', packCount: 2, fromLocationCode: 'RECV-01', toLocationCode: 'A-01-1-A',
    });
    assert.equal(r.scan.baseQty, 24);
    const atStg = (await facade.getStock({ sellerId: 'acme', locationId: stg.id })).reduce((s, b) => s + b.qty, 0);
    assert.equal(atStg, 24);
  });

  await test('escaneo: picking retira del reservado las unidades base del código', async () => {
    const { facade } = buildFacade();
    const { recv } = await seedScan(facade);
    await facade.scanInbound('acme', { barcode: 'DUN-1', packCount: 2, locationId: recv.id }); // 24 disponibles en recepción
    // Guardar en almacenaje: solo desde ahí se puede reservar/pickear.
    await facade.scanPutaway('acme', { productBarcode: 'DUN-1', packCount: 2, fromLocationCode: 'RECV-01', toLocationCode: 'A-01-1-A' });
    // Orden por 12 unidades base -> reserva 12 (desde almacenaje)
    const order = await facade.createOrder('acme', {
      externalOrderId: 'O-1', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 12 }],
    });
    await facade.allocateOrder('acme', order.id);
    // Pistolear 1 caja (12) en la ubicación de almacenaje confirma la toma
    const p = await facade.scanPick('acme', { productBarcode: 'DUN-1', packCount: 1, locationCode: 'A-01-1-A' });
    assert.equal(p.scan.baseQty, 12);
    const reserved = (await facade.getStock({ sellerId: 'acme' }))
      .filter((b) => b.state === StockState.RESERVED).reduce((s, b) => s + b.qty, 0);
    assert.equal(reserved, 0); // se pickeó todo lo reservado
  });

  await test('escaneo: ubicación no reconocida falla', async () => {
    const { facade } = buildFacade();
    await seedScan(facade);
    await expectThrows(
      () => facade.scanPutaway('acme', { productBarcode: 'DUN-1', packCount: 1, fromLocationCode: 'RECV-01', toLocationCode: 'NO-EXISTE' }),
      NotFoundError,
    );
  });

  console.log('\nMulti-operación — aislamiento entre administradores\n');

  async function seedTwoOps() {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op-a', name: 'Operación A' });
    await facade.createOperation({ id: 'op-b', name: 'Operación B' });
    await facade.createLocation({ operationId: 'op-a', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await facade.createLocation({ operationId: 'op-b', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await facade.createSeller({ id: 'sa', operationId: 'op-a', name: 'Seller A' });
    await facade.createSeller({ id: 'sb', operationId: 'op-b', name: 'Seller B' });
    const adminA = await facade.createUser({ id: 'aa', name: 'AdminA', email: 'aa@a.cl', role: UserRole.ADMIN, operationId: 'op-a' });
    const adminB = await facade.createUser({ id: 'ab', name: 'AdminB', email: 'ab@b.cl', role: UserRole.ADMIN, operationId: 'op-b' });
    const root = await facade.createUser({ id: 'root', name: 'Root', email: 'root@nh.cl', role: UserRole.PLATFORM_ADMIN });
    return { facade, adminA, adminB, root };
  }

  await test('el seller pertenece a su operación; los listados están acotados', async () => {
    const { facade } = await seedTwoOps();
    const sellersA = await facade.listSellers('op-a');
    assert.equal(sellersA.length, 1);
    assert.equal(sellersA[0].id, 'sa');
    assert.equal((await facade.listSellers('op-b')).length, 1);
  });

  await test('un admin de una operación NO puede actuar sobre un seller de otra', async () => {
    const { facade, adminA } = await seedTwoOps();
    // sobre su propio seller: ok
    await facade.authorize(adminA, 'inventory:receive', { sellerId: 'sa' });
    // sobre seller de otra operación: prohibido (frontera de operación)
    await expectThrows(() => facade.authorize(adminA, 'inventory:receive', { sellerId: 'sb' }), ForbiddenError);
    // y no puede administrar la otra operación
    await expectThrows(() => facade.authorize(adminA, 'master:manage', { operationId: 'op-b' }), ForbiddenError);
  });

  await test('el PLATFORM_ADMIN atraviesa todas las operaciones', async () => {
    const { facade, root } = await seedTwoOps();
    await facade.authorize(root, 'operation:manage');
    await facade.authorize(root, 'inventory:receive', { sellerId: 'sa' });
    await facade.authorize(root, 'inventory:receive', { sellerId: 'sb' });
  });

  await test('no se puede usar una ubicación de otra operación (invariante)', async () => {
    const { facade } = await seedTwoOps();
    await facade.createSku('sa', { sku: 'X1', description: 'X' });
    const locB = (await facade.listLocations('op-b'))[0];
    // Seller de op-a intentando recibir en una ubicación de op-b
    await expectThrows(
      () => facade.receive('sa', { sku: 'X1', qty: 5, locationId: locB.id }),
      TenantViolationError,
    );
  });

  await test('un admin de operación solo ve los usuarios de su operación', async () => {
    const { facade } = await seedTwoOps();
    assert.equal((await facade.listUsers('op-a')).length, 1); // adminA
    assert.equal((await facade.listUsers('op-b')).length, 1); // adminB
    assert.ok((await facade.listUsers(null)).length >= 3); // plataforma ve todos
  });

  console.log('\nÓrdenes de recepción (inbound multi-SKU)\n');

  async function seedRecepcion() {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'AAA', description: 'Prod A' });
    await facade.createSku('acme', { sku: 'BBB', description: 'Prod B' });
    return { facade, recv, stg };
  }

  await test('recepción: crear NO postea stock; la orden queda PENDING con esperadas', async () => {
    const { facade, recv } = await seedRecepcion();
    const o = await facade.createReceipt('acme', { supplier: 'Prov', reference: 'G-1', locationId: recv.id, lines: [{ sku: 'AAA', qty: 10 }, { sku: 'BBB', qty: 5 }] }, 'ana');
    assert.ok(/^OR-/.test(o.id));
    assert.equal(o.status, 'PENDING');
    assert.equal(o.lines[0].expectedQty, 10);
    assert.equal(o.lines[0].receivedQty, 0);
    const bal = await facade.getStock({ sellerId: 'acme', locationId: recv.id });
    assert.equal(bal.reduce((a, b) => a + b.qty, 0), 0); // sin stock hasta el cotejo
  });

  await test('recepción: cotejo completo postea el stock y cierra en RECEIVED', async () => {
    const { facade, recv } = await seedRecepcion();
    const o = await facade.createReceipt('acme', { locationId: recv.id, lines: [{ sku: 'AAA', qty: 10 }, { sku: 'BBB', qty: 5 }] }, 'ana');
    const done = await facade.receiveReceipt('acme', o.id, [{ lineNo: 1, qty: 10 }, { lineNo: 2, qty: 5 }], 'ana');
    assert.equal(done.status, 'RECEIVED');
    const bal = await facade.getStock({ sellerId: 'acme', locationId: recv.id });
    assert.equal(bal.reduce((a, b) => a + b.qty, 0), 15);
  });

  await test('recepción: cotejo parcial deja PARTIAL y acumula en varios eventos', async () => {
    const { facade, recv } = await seedRecepcion();
    const o = await facade.createReceipt('acme', { locationId: recv.id, lines: [{ sku: 'AAA', qty: 10 }] }, 'ana');
    const p1 = await facade.receiveReceipt('acme', o.id, [{ lineNo: 1, qty: 6 }], 'ana');
    assert.equal(p1.status, 'PARTIAL');
    assert.equal(p1.lines[0].receivedQty, 6);
    const p2 = await facade.receiveReceipt('acme', o.id, [{ lineNo: 1, qty: 4 }], 'ana'); // completa
    assert.equal(p2.status, 'RECEIVED');
    const bal = await facade.getStock({ sellerId: 'acme', sku: 'AAA', locationId: recv.id });
    assert.equal(bal.reduce((a, b) => a + b.qty, 0), 10);
  });

  await test('recepción: cerrar deja RECEIVED con faltante registrado', async () => {
    const { facade, recv } = await seedRecepcion();
    const o = await facade.createReceipt('acme', { locationId: recv.id, lines: [{ sku: 'AAA', qty: 10 }] }, 'ana');
    await facade.receiveReceipt('acme', o.id, [{ lineNo: 1, qty: 6 }], 'ana');
    const closed = await facade.closeReceipt('acme', o.id, 'ana');
    assert.equal(closed.status, 'RECEIVED');
    assert.equal(closed.lines[0].receivedQty, 6); // 4 quedan como faltante
    const bal = await facade.getStock({ sellerId: 'acme', sku: 'AAA', locationId: recv.id });
    assert.equal(bal.reduce((a, b) => a + b.qty, 0), 6);
  });

  await test('recepción: editar solo permitido en PENDING', async () => {
    const { facade, recv } = await seedRecepcion();
    const o = await facade.createReceipt('acme', { locationId: recv.id, lines: [{ sku: 'AAA', qty: 10 }] }, 'ana');
    await facade.updateReceipt('acme', o.id, { locationId: recv.id, lines: [{ sku: 'AAA', qty: 25 }] }, 'ana');
    await facade.receiveReceipt('acme', o.id, [{ lineNo: 1, qty: 5 }], 'ana'); // ahora PARTIAL
    await expectThrows(
      () => facade.updateReceipt('acme', o.id, { locationId: recv.id, lines: [{ sku: 'AAA', qty: 3 }] }, 'ana'),
      ValidationError,
    );
  });

  await test('recepción: eliminar revierte lo recibido y borra la orden', async () => {
    const { facade, recv } = await seedRecepcion();
    const o = await facade.createReceipt('acme', { locationId: recv.id, lines: [{ sku: 'AAA', qty: 10 }] }, 'ana');
    await facade.receiveReceipt('acme', o.id, [{ lineNo: 1, qty: 10 }], 'ana');
    await facade.deleteReceipt('acme', o.id, 'ana');
    const bal = await facade.getStock({ sellerId: 'acme', sku: 'AAA', locationId: recv.id });
    assert.equal(bal.reduce((a, b) => a + b.qty, 0), 0);
    assert.equal(await facade.getReceipt('acme', o.id), null);
  });

  await test('recepción: no se puede eliminar si lo recibido ya fue guardado', async () => {
    const { facade, recv, stg } = await seedRecepcion();
    const o = await facade.createReceipt('acme', { locationId: recv.id, lines: [{ sku: 'AAA', qty: 10 }] }, 'ana');
    await facade.receiveReceipt('acme', o.id, [{ lineNo: 1, qty: 10 }], 'ana');
    await facade.putaway('acme', { sku: 'AAA', qty: 10, fromLocationId: recv.id, toLocationId: stg.id });
    await expectThrows(() => facade.deleteReceipt('acme', o.id, 'ana'), ForbiddenError);
  });

  console.log('\nMantenedor de productos y kits\n');

  async function seedProducts() {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 1 });
    await facade.createSku('acme', { sku: 'COMP-A', description: 'Componente A' });
    await facade.createSku('acme', { sku: 'COMP-B', description: 'Componente B' });
    return { facade, stg };
  }

  await test('productos: crear, editar y activar/desactivar con historial', async () => {
    const { facade } = await seedProducts();
    const p = await facade.createProduct('acme', { sku: 'PROD-1', description: 'Producto 1', barcode: '7790000000017' }, 'carla');
    assert.equal(p.active, true);
    assert.equal(p.isKit, false);
    await facade.updateProduct('acme', 'PROD-1', { description: 'Producto 1 v2' }, 'carla');
    await facade.setProductActive('acme', 'PROD-1', false, 'ana');
    const p2 = await facade.getProduct('acme', 'PROD-1');
    assert.equal(p2!.active, false);
    const log = await facade.listProductLog('acme', 'PROD-1');
    assert.ok(log.length >= 3);
    const actions = log.map((e) => e.action);
    assert.ok(actions.includes('CREADO') && actions.includes('EDITADO') && actions.includes('DESACTIVADO'));
  });

  await test('productos: no se puede crear un SKU duplicado', async () => {
    const { facade } = await seedProducts();
    await expectThrows(() => facade.createProduct('acme', { sku: 'COMP-A', description: 'dup' }), ValidationError);
  });

  await test('kit ARMADO: consume componentes y produce stock del kit', async () => {
    const { facade, stg } = await seedProducts();
    await facade.receive('acme', { sku: 'COMP-A', qty: 20, locationId: stg.id });
    await facade.receive('acme', { sku: 'COMP-B', qty: 20, locationId: stg.id });
    await facade.createProduct('acme', { sku: 'KIT-AS', description: 'Kit armado', isKit: true, kitMode: KitMode.ASSEMBLED, components: [{ sku: 'COMP-A', qty: 2 }, { sku: 'COMP-B', qty: 1 }] }, 'ana');
    const srcs = await facade.planAssemblySources('acme', 'KIT-AS', 5);
    await facade.assembleKit('acme', { kitSku: 'KIT-AS', qty: 5, toLocationId: stg.id, sources: srcs }, 'ana'); // consume 10 A + 5 B
    const a = (await facade.getStock({ sellerId: 'acme', sku: 'COMP-A' })).reduce((s, b) => s + b.qty, 0);
    const b = (await facade.getStock({ sellerId: 'acme', sku: 'COMP-B' })).reduce((s, b) => s + b.qty, 0);
    const k = (await facade.getStock({ sellerId: 'acme', sku: 'KIT-AS' })).reduce((s, b) => s + b.qty, 0);
    assert.equal(a, 10);
    assert.equal(b, 15);
    assert.equal(k, 5);
  });

  await test('kit ARMADO: exige ubicaciones exactas y registra el armado auditable', async () => {
    const { facade, stg } = await seedProducts();
    await facade.receive('acme', { sku: 'COMP-A', qty: 20, locationId: stg.id });
    await facade.receive('acme', { sku: 'COMP-B', qty: 20, locationId: stg.id });
    await facade.createProduct('acme', { sku: 'KIT-AS', description: 'Kit', isKit: true, kitMode: KitMode.ASSEMBLED, components: [{ sku: 'COMP-A', qty: 2 }, { sku: 'COMP-B', qty: 1 }] }, 'ana');
    // total asignado incorrecto (requiere 4 de A para 2 kits, se dan 3) -> rechazado
    await expectThrows(() => facade.assembleKit('acme', { kitSku: 'KIT-AS', qty: 2, toLocationId: stg.id, sources: [{ sku: 'COMP-A', locationId: stg.id, qty: 3 }, { sku: 'COMP-B', locationId: stg.id, qty: 2 }] }), ValidationError);
    // correcto
    await facade.assembleKit('acme', { kitSku: 'KIT-AS', qty: 2, toLocationId: stg.id, sources: [{ sku: 'COMP-A', locationId: stg.id, qty: 4 }, { sku: 'COMP-B', locationId: stg.id, qty: 2 }] }, 'pedro');
    const asm = await facade.listAssemblies('acme');
    assert.equal(asm.length, 1);
    assert.equal(asm[0].actor, 'pedro');
    assert.equal(asm[0].qty, 2);
    assert.ok(asm[0].sources.some((x) => x.sku === 'COMP-A' && x.qty === 4 && x.locationId === stg.id));
  });

  await test('kit VIRTUAL: la orden explota en componentes al reservar y pickear', async () => {
    const { facade, stg } = await seedProducts();
    await facade.receive('acme', { sku: 'COMP-A', qty: 20, locationId: stg.id });
    await facade.receive('acme', { sku: 'COMP-B', qty: 20, locationId: stg.id });
    await facade.createProduct('acme', { sku: 'KIT-V', description: 'Kit virtual', isKit: true, kitMode: KitMode.VIRTUAL, components: [{ sku: 'COMP-A', qty: 2 }, { sku: 'COMP-B', qty: 1 }] }, 'ana');
    const o = await facade.createOrder('acme', { externalOrderId: 'K1', salesChannel: 'web', shipTo: SHIP_TO, lines: [{ sku: 'KIT-V', qty: 3 }] });
    await facade.allocateOrder('acme', o.id); // reserva 6 A + 3 B
    const aRes = (await facade.getStock({ sellerId: 'acme', sku: 'COMP-A' })).filter((x) => x.state === StockState.RESERVED).reduce((s, b) => s + b.qty, 0);
    assert.equal(aRes, 6);
    const pl = await facade.getPickList('acme', o.id);
    const skusInPick = new Set(pl.map((t) => t.sku));
    assert.ok(skusInPick.has('COMP-A') && skusInPick.has('COMP-B') && !skusInPick.has('KIT-V'));
    await facade.confirmPick('acme', o.id);
    const aAvail = (await facade.getStock({ sellerId: 'acme', sku: 'COMP-A' })).reduce((s, b) => s + b.qty, 0);
    assert.equal(aAvail, 14); // 20 - 6 recolectados
  });

  await test('kit: validaciones (componente inexistente, kit dentro de kit, armar un virtual)', async () => {
    const { facade, stg } = await seedProducts();
    await expectThrows(() => facade.createProduct('acme', { sku: 'K', description: 'k', isKit: true, kitMode: KitMode.VIRTUAL, components: [{ sku: 'NOPE', qty: 1 }] }), NotFoundError);
    await facade.createProduct('acme', { sku: 'KV', description: 'kv', isKit: true, kitMode: KitMode.VIRTUAL, components: [{ sku: 'COMP-A', qty: 1 }] });
    await expectThrows(() => facade.createProduct('acme', { sku: 'K2', description: 'k2', isKit: true, kitMode: KitMode.ASSEMBLED, components: [{ sku: 'KV', qty: 1 }] }), ValidationError);
    await expectThrows(() => facade.assembleKit('acme', { kitSku: 'KV', qty: 1, toLocationId: stg.id, sources: [] }), ValidationError);
  });

  console.log('\nFacturación 3PL\n');

  await test('facturación: calcula almacenamiento, recepción, despacho y picking', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P1', description: 'P1' });
    await facade.setBillingRate('acme', { storagePerUnitMonth: 100, receiptPerUnit: 10, shipmentPerOrder: 500, pickPerUnit: 5 });
    await facade.receive('acme', { sku: 'P1', qty: 100, locationId: stg.id });
    const o = await facade.createOrder('acme', { externalOrderId: 'O1', salesChannel: 'web', shipTo: SHIP_TO, lines: [{ sku: 'P1', qty: 20 }] });
    await facade.allocateOrder('acme', o.id);
    await facade.confirmPick('acme', o.id);
    await facade.shipOrder('acme', o.id, { carrier: 'X' });
    const inv = await facade.generateInvoice('acme', 2026, 1, 'ana');
    const by: Record<string, any> = {};
    inv.lines.forEach((l) => (by[l.concept] = l));
    assert.equal(by['Recepción'].amount, 1000); // 100 un × 10
    assert.equal(by['Picking'].amount, 100); // 20 un × 5
    assert.equal(by['Despacho'].amount, 500); // 1 pedido × 500
    assert.equal(by['Almacenamiento'].amount, 8267); // 80 un físicas × 31 días / 30 × 100
    assert.equal(inv.total, 9867);
    assert.ok(/^FAC-202601-/.test(inv.id));
    assert.equal((await facade.listInvoices('acme')).length, 1);
  });

  await test('facturación: picking, despacho y embalaje se cobran en el mes del DESPACHO de la orden', async () => {
    const { facade, billingService, clock } = buildFacade();
    clock.set('2026-05-20T12:00:00.000Z');
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P1', description: 'P1' });
    await facade.setBillingRate('acme', { shipmentPerOrder: 500, pickPerUnit: 5 });
    await facade.createPackaging('op1', { sku: 'CAJA-M', name: 'Caja M', unitPrice: 300 });
    await facade.receivePackagingStock('op1', 'CAJA-M', 100);
    await facade.receive('acme', { sku: 'P1', qty: 100, locationId: stg.id });
    // O1: pickeada y empacada en mayo, despachada en junio → todo se cobra en JUNIO.
    const o1 = await facade.createOrder('acme', { externalOrderId: 'O1', salesChannel: 'web', shipTo: SHIP_TO, lines: [{ sku: 'P1', qty: 20 }] });
    await facade.allocateOrder('acme', o1.id);
    await facade.confirmPick('acme', o1.id);
    await facade.packOrder('acme', o1.id, { bultos: 1, materials: [{ sku: 'CAJA-M', qty: 2 }] });
    // O2: pickeada en mayo y NUNCA despachada → no se cobra en ningún mes.
    const o2 = await facade.createOrder('acme', { externalOrderId: 'O2', salesChannel: 'web', shipTo: SHIP_TO, lines: [{ sku: 'P1', qty: 7 }] });
    await facade.allocateOrder('acme', o2.id);
    await facade.confirmPick('acme', o2.id);
    const mayo = await billingService.computeInvoice('acme', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    const qtyOf = (inv: any, c: string) => (inv.lines.find((l: any) => l.concept === c || l.concept.startsWith(c)) || { qty: 0 }).qty;
    assert.equal(qtyOf(mayo, 'Picking'), 0, 'mayo: sin picking (nada despachado)');
    assert.equal(qtyOf(mayo, 'Despacho'), 0, 'mayo: sin despacho');
    assert.equal(qtyOf(mayo, 'Embalaje'), 0, 'mayo: sin embalaje');
    clock.set('2026-06-02T10:00:00.000Z');
    await facade.shipOrder('acme', o1.id, { carrier: 'X' });
    const junio = await billingService.computeInvoice('acme', '2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    const by: Record<string, any> = {};
    junio.lines.forEach((l) => (by[l.concept] = l));
    assert.equal(by['Despacho'].qty, 1);
    assert.equal(by['Picking'].qty, 20, 'solo las unidades de la orden despachada (no las 7 de O2)');
    assert.equal(by['Picking'].amount, 100);
    assert.equal(by['Embalaje · Caja M'].qty, 2);
    assert.equal(by['Embalaje · Caja M'].amount, 600);
  });

  await test('facturación: editar número/cantidades/concepto, detectar duplicado, enviar y eliminar', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A', zoneType: ZoneType.STORAGE, capacity: 100, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P', description: 'P' });
    await facade.setBillingRate('acme', { receiptPerUnit: 10 });
    await facade.receive('acme', { sku: 'P', qty: 5, locationId: stg.id }); // recepción 5 × 10 = 50
    const inv = await facade.generateInvoice('acme', 2026, 1, 'ana');
    assert.equal(inv.number, inv.id);
    assert.equal(inv.total, 50);
    assert.equal((await facade.invoicesForMonth('acme', 2026, 1)).length, 1); // duplicado detectable
    const edited = await facade.updateInvoice('acme', inv.id, {
      number: '0001-A',
      lines: [{ concept: 'Recepción', unit: 'unidad', qty: 5, rate: 10 }, { concept: 'Seguro de carga', unit: '—', qty: 1, rate: 8000 }],
    });
    assert.equal(edited.number, '0001-A');
    assert.equal(edited.total, 8050);
    const sent = await facade.recordInvoiceSend('acme', inv.id, 'cliente@correo.cl', false, 'ana');
    assert.equal(sent.sends.length, 1);
    assert.equal(sent.sends[0].to, 'cliente@correo.cl');
    await facade.deleteInvoice('acme', inv.id);
    assert.equal(await facade.getInvoice('acme', inv.id), null);
    assert.equal((await facade.listInvoices('acme')).length, 0);
  });

  await test('facturación: flujo de aprobación configurable por cliente', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A', zoneType: ZoneType.STORAGE, capacity: 100, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P', description: 'P' });
    // Cliente SIN aprobación: la factura nace ISSUED y no se puede aprobar.
    await facade.setBillingRate('acme', { receiptPerUnit: 10, requiresApproval: false });
    await facade.receive('acme', { sku: 'P', qty: 5, locationId: stg.id });
    const issued = await facade.generateInvoice('acme', 2026, 1, 'ana');
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.approval, null);
    await assert.rejects(() => facade.approveInvoice('acme', issued.id, 'carla'));
    await facade.deleteInvoice('acme', issued.id);
    // Cliente CON aprobación: nace PENDING; el cliente aprueba (queda quién y cuándo).
    await facade.setBillingRate('acme', { requiresApproval: true });
    const pend = await facade.generateInvoice('acme', 2026, 1, 'ana');
    assert.equal(pend.status, 'PENDING');
    const approved = await facade.approveInvoice('acme', pend.id, 'carla');
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.approval!.by, 'carla');
    assert.ok(approved.approval!.at); // fecha/hora registrada
    await assert.rejects(() => facade.approveInvoice('acme', pend.id, 'carla')); // no doble aprobación
    // Editar una factura aprobada la devuelve a PENDING (la aprobación deja de ser válida).
    const reedited = await facade.updateInvoice('acme', pend.id, { number: 'X-1' });
    assert.equal(reedited.status, 'PENDING');
    assert.equal(reedited.approval, null);
  });

  await test('facturación: documento tributario adjunto → Facturado, visible y reversible', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A', zoneType: ZoneType.STORAGE, capacity: 100, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P', description: 'P' });
    await facade.setBillingRate('acme', { receiptPerUnit: 10, requiresApproval: true });
    await facade.receive('acme', { sku: 'P', qty: 5, locationId: stg.id });
    const inv = await facade.generateInvoice('acme', 2026, 1, 'ana');
    assert.equal(inv.status, 'PENDING'); // nace como PRE-FACTURA
    assert.equal(inv.taxDocument, null);
    // El administrador adjunta el documento tributario y marca Facturado.
    const b64 = Buffer.from('%PDF-1.4 demo', 'utf8').toString('base64');
    const facturada = await facade.attachInvoiceTaxDocument('acme', inv.id, { fileName: 'factura-123.pdf', mimeType: 'application/pdf', contentBase64: b64, markInvoiced: true }, 'ana');
    assert.equal(facturada.status, 'INVOICED'); // pasa a FACTURADO
    assert.ok(facturada.taxDocument);
    assert.equal(facturada.taxDocument!.fileName, 'factura-123.pdf');
    assert.equal(facturada.taxDocument!.mimeType, 'application/pdf');
    assert.ok(facturada.taxDocument!.size > 0);
    // El documento (bytes) se puede recuperar para descarga (lo ve también el cliente).
    const blob = await facade.getInvoiceTaxDocument('acme', inv.id);
    assert.ok(blob);
    assert.equal(blob!.contentBase64, b64);
    // No se puede editar una factura facturada.
    await assert.rejects(() => facade.updateInvoice('acme', inv.id, { number: 'Z-9' }));
    // Deshacer: quita el documento y vuelve a PRE-FACTURA (aprobada, si la había, o pendiente).
    const revert = await facade.removeInvoiceTaxDocument('acme', inv.id);
    assert.equal(revert.status, 'PENDING');
    assert.equal(revert.taxDocument, null);
    assert.equal(await facade.getInvoiceTaxDocument('acme', inv.id), null);
    // Marcar Facturado sin documento adjunto debe fallar.
    await assert.rejects(() => facade.markInvoiceInvoiced('acme', inv.id));
  });

  await test('facturación: dashboard agrega por período, cliente y concepto', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createSeller({ id: 'globex', operationId: 'op1', name: 'Globex' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P', description: 'P' });
    await facade.createSku('globex', { sku: 'Q', description: 'Q' });
    await facade.setBillingRate('acme', { receiptPerUnit: 10 });
    await facade.setBillingRate('globex', { receiptPerUnit: 20 });
    await facade.receive('acme', { sku: 'P', qty: 5, locationId: stg.id }); // 5×10 = 50
    await facade.receive('globex', { sku: 'Q', qty: 3, locationId: stg.id }); // 3×20 = 60
    await facade.generateInvoice('acme', 2026, 1, 'ana');
    await facade.generateInvoice('globex', 2026, 1, 'ana');
    const d = await facade.billingDashboard('op1');
    assert.equal(d.clients.length, 2); // ambos clientes facturados
    assert.equal(d.invoices.length, 2);
    // consolidado del período por concepto Recepción = 50 + 60 = 110
    const rec = d.lines.filter((l: any) => l.period === '2026-01' && l.concept === 'Recepción').reduce((a: number, l: any) => a + l.amount, 0);
    assert.equal(rec, 110);
    // apertura por cliente
    const acmeTotal = d.lines.filter((l: any) => l.sellerId === 'acme').reduce((a: number, l: any) => a + l.amount, 0);
    assert.equal(acmeTotal, 50);
    assert.ok(d.concepts.includes('Recepción'));
  });

  await test('métricas: ventanas 24h/7d con comparativo vs período anterior', async () => {
    const { facade, clock } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A', zoneType: ZoneType.STORAGE, capacity: 5000, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P', description: 'P' });
    // Buffer de stock ~30 días atrás para que los pickeos no falten.
    clock.set('2026-05-16T12:00:00.000Z');
    await facade.receive('acme', { sku: 'P', qty: 1000, locationId: stg.id });
    async function pick(iso: string, qty: number) {
      clock.set(iso);
      const o = await facade.createOrder('acme', { externalOrderId: `X-${iso}-${qty}`, salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'P', qty }] });
      await facade.allocateOrder('acme', o.id);
      await facade.getPickList('acme', o.id);
      await facade.confirmPick('acme', o.id); // → PICKED
    }
    await pick('2026-06-15T00:00:00.000Z', 4); // hace ~12 h (dentro de últimas 24 h)
    await pick('2026-06-14T00:00:00.000Z', 6); // hace ~36 h (24 h previas)
    // Recepción dentro de las últimas 24 h.
    clock.set('2026-06-15T00:00:00.000Z');
    const r = await facade.createReceipt('acme', { locationId: stg.id, lines: [{ sku: 'P', qty: 20 }] }, 'system');
    await facade.receiveReceipt('acme', r.id, [{ lineNo: 1, qty: 20 }], 'op');
    // "Ahora" = 2026-06-15T12:00.
    clock.set('2026-06-15T12:00:00.000Z');
    const m = await facade.dashboardMetrics('acme');
    const w24 = m.windows.find((w: any) => w.window === '24h')!;
    const w7 = m.windows.find((w: any) => w.window === '7d')!;
    // 24 h: 1 orden preparada ahora vs 1 en las 24 h previas → 0 %.
    assert.equal(w24.ordersPrepared.current, 1);
    assert.equal(w24.ordersPrepared.previous, 1);
    assert.equal(w24.ordersPrepared.pct, 0);
    assert.equal(w24.unitsPrepared.current, 4);
    assert.equal(w24.ordersReceived.current, 1);
    assert.equal(w24.unitsReceived.current, 20);
    assert.ok(w24.movements.current >= 2);
    // 7 d: ambas órdenes caen dentro → 2 preparadas; período previo sin base → pct null.
    assert.equal(w7.ordersPrepared.current, 2);
    assert.equal(w7.ordersPrepared.previous, 0);
    assert.equal(w7.ordersPrepared.pct, null);
  });

  console.log('\nPanel de uso de la plataforma (PlatformUsageService)\n');

  await test('panel de uso: métricas por operación, ventanas y consolidado', async () => {
    const { facade, clock } = buildFacade();
    await facade.createOperation({ id: 'op-a', name: 'Operación A' });
    await facade.createOperation({ id: 'op-b', name: 'Operación B' });
    const recvA = await facade.createLocation({ operationId: 'op-a', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stgA = await facade.createLocation({ operationId: 'op-a', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSeller({ id: 'sa', operationId: 'op-a', name: 'Seller A' });
    await facade.createSeller({ id: 'sb', operationId: 'op-b', name: 'Seller B' });
    await facade.createSku('sa', { sku: 'P', description: 'Producto P' });
    // Usuarios: 2 en op-a, 1 en op-b.
    await facade.createUser({ id: 'ua1', name: 'UA1', email: 'ua1@a.cl', role: UserRole.ADMIN, operationId: 'op-a' });
    await facade.createUser({ id: 'ua2', name: 'UA2', email: 'ua2@a.cl', role: UserRole.OPERATOR, operationId: 'op-a' });
    await facade.createUser({ id: 'ub1', name: 'UB1', email: 'ub1@b.cl', role: UserRole.ADMIN, operationId: 'op-b' });

    // Período ANTERIOR de 7 d (~2026-06-01..08): 2 logins de op-a (para el comparativo).
    clock.set('2026-06-04T09:00:00.000Z'); await facade.recordLogin('ua1', 'op-a');
    clock.set('2026-06-05T09:00:00.000Z'); await facade.recordLogin('ua2', 'op-a');
    // Logins de op-a DENTRO de la ventana de 7 d: 3 logins, 2 usuarios distintos.
    clock.set('2026-06-13T09:00:00.000Z'); await facade.recordLogin('ua1', 'op-a');
    clock.set('2026-06-14T09:00:00.000Z'); await facade.recordLogin('ua1', 'op-a');
    clock.set('2026-06-14T10:00:00.000Z'); await facade.recordLogin('ua2', 'op-a');
    // Login de op-b hace ~20 días: fuera de 7 d, dentro de 30 d.
    clock.set('2026-05-26T09:00:00.000Z'); await facade.recordLogin('ub1', 'op-b');
    // Movimientos de op-a dentro de la ventana (recepción + guardado).
    clock.set('2026-06-13T12:00:00.000Z'); await facade.receive('sa', { sku: 'P', qty: 50, locationId: recvA.id });
    clock.set('2026-06-13T12:30:00.000Z'); await facade.putaway('sa', { sku: 'P', qty: 50, fromLocationId: recvA.id, toLocationId: stgA.id });

    // "Ahora" = 2026-06-15T12:00.
    clock.set('2026-06-15T12:00:00.000Z');
    const u7 = await facade.platformUsage(7);
    assert.equal(u7.spanDays, 7);
    const a7 = u7.operations.find((o) => o.operationId === 'op-a')!;
    const b7 = u7.operations.find((o) => o.operationId === 'op-b')!;
    assert.equal(a7.logins.current, 3);
    assert.equal(a7.logins.previous, 2); // 2 logins en el período anterior
    assert.equal(a7.logins.pct, 50); // (3-2)/2 = +50 %
    assert.equal(a7.activeUsers.current, 2);
    assert.equal(a7.totalUsers, 2);
    assert.equal(a7.adoptionRate.current, 100);
    assert.ok(a7.movements.current >= 2, 'op-a debe tener movimientos en la ventana');
    assert.equal(a7.movements.previous, 0);
    assert.equal(a7.movements.pct, null); // sin base de comparación
    assert.equal(a7.totalSellers, 1);
    assert.equal(a7.dormant, false);
    assert.ok(a7.lastActivity, 'op-a debe reportar última actividad');
    // op-b sin actividad en 7 d → dormida.
    assert.equal(b7.logins.current, 0);
    assert.equal(b7.activeUsers.current, 0);
    assert.equal(b7.dormant, true);
    // Orden: la más activa (op-a) primero.
    assert.equal(u7.operations[0].operationId, 'op-a');
    // Consolidado de plataforma (con comparativo).
    assert.equal(u7.totals.operations, 2);
    assert.equal(u7.totals.activeOperations, 1);
    assert.equal(u7.totals.logins.current, 3);
    assert.equal(u7.totals.logins.previous, 2);
    assert.equal(u7.totals.logins.pct, 50);
    assert.equal(u7.totals.activeUsers.current, 2);
    assert.equal(u7.totals.totalUsers, 3);

    // Ventana de 30 d: ahora entra el login de op-b (op-b deja de estar dormida).
    const u30 = await facade.platformUsage(30);
    const b30 = u30.operations.find((o) => o.operationId === 'op-b')!;
    assert.equal(b30.logins.current, 1);
    assert.equal(b30.activeUsers.current, 1);
    assert.equal(b30.dormant, false);
    assert.equal(u30.totals.logins.current, 6); // 5 de op-a (incl. 06-04/05) + 1 de op-b
    assert.equal(u30.totals.activeOperations, 2);
  });

  await test('chat: cliente ↔ operaciones, no leídos y bandeja por operación', async () => {
    const { facade, clock } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const carla = { id: 'carla', name: 'Carla', role: 'CLIENT' };
    const ana = { id: 'ana', name: 'Ana', role: 'ADMIN' };
    clock.set('2026-06-01T10:00:00.000Z');
    await facade.chatSend('acme', carla, 'Hola, ¿llegó mi mercadería?');
    clock.set('2026-06-01T10:05:00.000Z');
    await facade.chatSend('acme', ana, 'Hola Carla, sí, la recibimos ayer.'); // ops lee hasta aquí
    clock.set('2026-06-01T10:10:00.000Z');
    await facade.chatSend('acme', carla, '¡Gracias! Otra consulta...');
    // Vista de operaciones: 3 mensajes, 1 no leído (el último del cliente).
    const opsThread = await facade.chatThread('acme', 'ADMIN');
    assert.equal(opsThread.messages.length, 3);
    assert.equal(opsThread.unread, 1);
    assert.equal(opsThread.messages[0].senderName, 'Carla');
    assert.equal(opsThread.messages[0].side, 'CLIENT');
    assert.equal(opsThread.messages[1].side, 'OPS');
    // Bandeja de la operación: 1 conversación, con el cliente y el último que habló.
    const inbox = await facade.chatSummary('op1');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].sellerName, 'ACME');
    assert.equal(inbox[0].unread, 1);
    assert.ok(inbox[0].last);
    assert.equal(inbox[0].last!.senderName, 'Carla');
    assert.equal(inbox[0].last!.side, 'CLIENT');
    // Operaciones marca leído → sin no leídos.
    clock.set('2026-06-01T10:15:00.000Z');
    await facade.chatMarkRead('acme', 'ADMIN');
    const after = await facade.chatThread('acme', 'ADMIN');
    assert.equal(after.unread, 0);
    // El cliente no tiene no leídos porque su marcador se actualiza al enviar.
    const cliThread = await facade.chatThread('acme', 'CLIENT');
    assert.equal(cliThread.unread, 0);
    // Mensaje vacío se rechaza.
    await assert.rejects(() => facade.chatSend('acme', carla, '   '));
  });

  await test('anuncios: mantenedor, barra activa y tracking de clics con atribución', async () => {
    const { facade, clock } = buildFacade();
    const mkUser = (o: any) => ({ email: o.id + '@x.cl', active: true, ...o });
    clock.set('2026-07-01T09:00:00.000Z');
    const a1 = await facade.createAnnouncement({ title: 'Nuevo módulo de facturación', linkUrl: 'ninjahubs.cl/lanzamiento' }, 'root');
    // La URL sin esquema se normaliza a https.
    assert.equal(a1.linkUrl, 'https://ninjahubs.cl/lanzamiento');
    assert.equal(a1.active, true);
    clock.set('2026-07-02T09:00:00.000Z');
    const a2 = await facade.createAnnouncement({ title: 'Webinar de kits', linkUrl: 'https://ninjahubs.cl/webinar', linkLabel: 'Inscríbete' }, 'root');
    // La barra muestra el ACTIVO más reciente.
    assert.equal((await facade.activeAnnouncement())!.id, a2.id);
    // Clic de un admin (op-ninja) y de un cliente (seller acme) sobre a2.
    await facade.clickAnnouncement(a2.id, mkUser({ id: 'ana', name: 'Ana', role: 'ADMIN', operationId: 'op-ninja', sellerId: null }) as any);
    await facade.clickAnnouncement(a2.id, mkUser({ id: 'carla', name: 'Carla', role: 'CLIENT', operationId: 'op-ninja', sellerId: 'acme' }) as any);
    await facade.clickAnnouncement(a2.id, mkUser({ id: 'ana', name: 'Ana', role: 'ADMIN', operationId: 'op-ninja', sellerId: null }) as any); // Ana repite
    const rep = await facade.announcementClicks(a2.id);
    assert.equal(rep.total, 3);
    assert.equal(rep.uniqueUsers, 2);
    assert.equal(rep.byRole['ADMIN'], 2);
    assert.equal(rep.byRole['CLIENT'], 1);
    // El detalle identifica usuario, operación y cliente.
    const carlaClick = rep.clicks.find((c: any) => c.userId === 'carla');
    assert.ok(carlaClick);
    assert.equal(carlaClick!.operationId, 'op-ninja');
    assert.equal(carlaClick!.sellerId, 'acme');
    assert.equal(carlaClick!.userRole, 'CLIENT');
    // Desactivar a2 → la barra cae al otro activo (a1).
    await facade.updateAnnouncement(a2.id, { active: false });
    assert.equal((await facade.activeAnnouncement())!.id, a1.id);
    // Si no hay ninguno activo, la barra queda vacía.
    await facade.updateAnnouncement(a1.id, { active: false });
    assert.equal(await facade.activeAnnouncement(), null);
    // Un anuncio sin enlace se rechaza.
    await assert.rejects(() => facade.createAnnouncement({ title: 'x', linkUrl: '' }, 'root'));
  });

  await test('anuncios: audiencia OPS (solo admin/supervisor) vs. ALL (incluye clientes)', async () => {
    const { facade, clock } = buildFacade();
    clock.set('2026-07-10T09:00:00.000Z');
    const ops = await facade.createAnnouncement({ title: 'Solo operaciones', linkUrl: 'ninjahubs.cl/a' }, 'root');
    assert.equal(ops.audience, 'OPS'); // por defecto
    clock.set('2026-07-10T10:00:00.000Z');
    const all = await facade.createAnnouncement({ title: 'Para todos', linkUrl: 'ninjahubs.cl/b', audience: 'ALL' }, 'root');
    assert.equal(all.audience, 'ALL');
    // Admin/supervisor ven el activo más reciente (cualquier audiencia).
    assert.equal((await facade.activeAnnouncement('ADMIN'))!.id, all.id);
    assert.equal((await facade.activeAnnouncement('SUPERVISOR'))!.id, all.id);
    // El cliente solo ve los de audiencia ALL.
    assert.equal((await facade.activeAnnouncement('CLIENT'))!.id, all.id);
    // Si se desactiva el ALL: el cliente no ve nada; el admin sí ve el OPS.
    await facade.updateAnnouncement(all.id, { active: false });
    assert.equal(await facade.activeAnnouncement('CLIENT'), null);
    assert.equal((await facade.activeAnnouncement('ADMIN'))!.id, ops.id);
    // Cambiar la audiencia del OPS a ALL → ahora el cliente sí lo ve.
    await facade.updateAnnouncement(ops.id, { audience: 'ALL' });
    assert.equal((await facade.activeAnnouncement('CLIENT'))!.id, ops.id);
  });

  await test('facturación: sin tarifas configuradas, la factura queda en cero', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const inv = await facade.generateInvoice('acme', 2026, 1, 'ana');
    assert.equal(inv.total, 0);
    assert.equal(inv.lines.length, 0);
  });

  console.log('\nWebhookService — suscripciones configurables por evento\n');

  function mkSeller(id: string, operationId: string, enabled: boolean) {
    return { id, operationId, name: id.toUpperCase(), pickingStrategy: PickingStrategy.FIFO, cycleCountStrategy: CycleCountStrategy.ABC, active: true, webhooksClientEnabled: enabled };
  }
  function mkU(role: UserRole, operationId: string | null, sellerId: string | null, id: string) {
    return { id, name: id, email: id + '@nh.cl', role, operationId, sellerId, active: true } as any;
  }
  async function buildWebhookFixture() {
    const sellers = new InMemorySellerRepository();
    await sellers.save(mkSeller('acme', 'op-ninja', true) as any);
    await sellers.save(mkSeller('globex', 'op-ninja', true) as any);
    await sellers.save(mkSeller('zeta', 'op-andes', true) as any);
    const fake = new FakeWebhookSender({ ok: true, status: 200 });
    const svc = new WebhookService(new InMemoryWebhookRepository(), sellers, fake, new SequentialIdGenerator('wh'), new FixedClock());
    const users = {
      cliAcme: mkU(UserRole.CLIENT, 'op-ninja', 'acme', 'cli-acme'),
      cliGlobex: mkU(UserRole.CLIENT, 'op-ninja', 'globex', 'cli-globex'),
      admin: mkU(UserRole.ADMIN, 'op-ninja', null, 'admin-ninja'),
      adminAndes: mkU(UserRole.ADMIN, 'op-andes', null, 'admin-andes'),
      platform: mkU(UserRole.PLATFORM_ADMIN, null, null, 'root'),
    };
    return { sellers, fake, svc, users };
  }

  await test('scopeOf resuelve SELLER/OPERATION/PLATFORM según el rol', async () => {
    const f = await buildWebhookFixture();
    assert.deepEqual(f.svc.scopeOf(f.users.cliAcme), { scope: 'SELLER', scopeId: 'acme' });
    assert.deepEqual(f.svc.scopeOf(f.users.admin), { scope: 'OPERATION', scopeId: 'op-ninja' });
    assert.deepEqual(f.svc.scopeOf(f.users.platform), { scope: 'PLATFORM', scopeId: null });
  });

  await test('dispatch entrega a SELLER, OPERATION y PLATFORM que matchean (con firma)', async () => {
    const f = await buildWebhookFixture();
    // 3 suscripciones que DEBEN recibir el evento de acme/op-ninja
    await f.svc.create(f.users.cliAcme, { url: 'https://h/seller-acme', events: ['order.shipped'] });
    await f.svc.create(f.users.admin, { url: 'https://h/op-ninja', events: ['order.shipped', 'reception.received'] });
    await f.svc.create(f.users.platform, { url: 'https://h/platform', events: ['order.shipped'] });
    // 4 que NO deben recibir: otro seller, otra operación, inactivo, no-suscrito
    await f.svc.create(f.users.cliGlobex, { url: 'https://h/seller-globex', events: ['order.shipped'] });
    await f.svc.create(f.users.adminAndes, { url: 'https://h/op-andes', events: ['order.shipped'] });
    const inactivo = await f.svc.create(f.users.admin, { url: 'https://h/inactivo', events: ['order.shipped'] });
    await f.svc.update(f.users.admin, inactivo.id, { active: false });
    await f.svc.create(f.users.cliAcme, { url: 'https://h/solo-recepcion', events: ['reception.received'] });

    const n = await f.svc.dispatch('order.shipped', 'acme', 'op-ninja', { orderId: 'O-1' });
    assert.equal(n, 3, 'deben entregarse exactamente 3');
    assert.equal(f.fake.calls.length, 3);
    // Las 3 urls correctas, y NINGUNA de las que no matchean
    const urls = f.fake.calls.map((c) => c.url).sort();
    assert.deepEqual(urls, ['https://h/op-ninja', 'https://h/platform', 'https://h/seller-acme']);
    assert.ok(!urls.includes('https://h/seller-globex'));
    assert.ok(!urls.includes('https://h/op-andes'));
    assert.ok(!urls.includes('https://h/inactivo'));
    assert.ok(!urls.includes('https://h/solo-recepcion'));
    // Cada entrega va firmada (HMAC-SHA256) y trae el evento correcto en el body
    f.fake.calls.forEach((c) => {
      assert.ok(/^sha256=[0-9a-f]{64}$/.test(c.headers['X-Ninja-Signature'] || ''), 'firma X-Ninja-Signature presente');
      const parsed = JSON.parse(c.body);
      assert.equal(parsed.event, 'order.shipped');
      assert.equal(parsed.sellerId, 'acme');
      assert.equal(parsed.data.orderId, 'O-1');
    });
  });

  await test('dispatch por operación distinta no cruza suscripciones', async () => {
    const f = await buildWebhookFixture();
    await f.svc.create(f.users.admin, { url: 'https://h/op-ninja', events: ['reception.received'] });
    await f.svc.create(f.users.adminAndes, { url: 'https://h/op-andes', events: ['reception.received'] });
    // Evento de zeta (op-andes): solo la suscripción de op-andes debe recibir
    const n = await f.svc.dispatch('reception.received', 'zeta', 'op-andes', { orderId: 'R-9' });
    assert.equal(n, 1);
    assert.equal(f.fake.calls[0].url, 'https://h/op-andes');
  });

  await test('un webhook registra la entrega en su historial (deliveries)', async () => {
    const f = await buildWebhookFixture();
    const w = await f.svc.create(f.users.admin, { url: 'https://h/op-ninja', events: ['order.shipped'] });
    await f.svc.dispatch('order.shipped', 'acme', 'op-ninja', { orderId: 'O-2' });
    const dels = await f.svc.deliveries(f.users.admin, w.id);
    assert.equal(dels.length, 1);
    assert.equal(dels[0].status, 'DELIVERED');
    assert.equal(dels[0].httpStatus, 200);
    assert.equal(dels[0].event, 'order.shipped');
  });

  await test('entrega fallida (sender error) queda como FAILED con su detalle', async () => {
    const sellers = new InMemorySellerRepository();
    await sellers.save(mkSeller('acme', 'op-ninja', true) as any);
    const fake = new FakeWebhookSender({ ok: false, status: null, error: 'Timeout tras 5000ms' });
    const svc = new WebhookService(new InMemoryWebhookRepository(), sellers, fake, new SequentialIdGenerator('wh'), new FixedClock());
    const admin = mkU(UserRole.ADMIN, 'op-ninja', null, 'admin');
    const w = await svc.create(admin, { url: 'https://h/down', events: ['order.shipped'] });
    await svc.dispatch('order.shipped', 'acme', 'op-ninja', { orderId: 'O-3' });
    const dels = await svc.deliveries(admin, w.id);
    assert.equal(dels[0].status, 'FAILED');
    assert.equal(dels[0].httpStatus, null);
    assert.ok((dels[0].error || '').includes('Timeout'));
  });

  await test('assertClientAccess bloquea al CLIENT cuando el flag está en false', async () => {
    const f = await buildWebhookFixture();
    // 'kappa' arranca deshabilitado
    await f.sellers.save(mkSeller('kappa', 'op-andes', false) as any);
    const cliKappa = mkU(UserRole.CLIENT, 'op-andes', 'kappa', 'cli-kappa');
    await expectThrows(() => f.svc.create(cliKappa, { url: 'https://h/k', events: ['order.shipped'] }), ForbiddenError);
    await expectThrows(() => f.svc.list(cliKappa), ForbiddenError);
    // El admin habilita el acceso → ahora el cliente sí puede configurar
    await f.svc.setClientAccess('kappa', true);
    const w = await f.svc.create(cliKappa, { url: 'https://h/k', events: ['order.shipped'] });
    assert.equal(w.scope, 'SELLER');
    assert.equal(w.scopeId, 'kappa');
    assert.ok(w.secret.indexOf('whsec_') === 0, 'genera un secreto whsec_');
  });

  await test('listClientsAccess devuelve los clientes de la operación con su flag', async () => {
    const f = await buildWebhookFixture();
    const rows = await f.svc.listClientsAccess('op-ninja');
    const acme = rows.find((r) => r.id === 'acme');
    const globex = rows.find((r) => r.id === 'globex');
    assert.ok(acme && acme.webhooksClientEnabled === true);
    assert.ok(globex && globex.webhooksClientEnabled === true);
    assert.ok(!rows.some((r) => r.id === 'zeta'), 'no incluye clientes de otra operación');
  });

  await test('un CLIENT no puede tocar webhooks de otro alcance (403)', async () => {
    const f = await buildWebhookFixture();
    const wAdmin = await f.svc.create(f.users.admin, { url: 'https://h/op', events: ['order.shipped'] });
    // El cliente de acme no es dueño del webhook de operación
    await expectThrows(() => f.svc.update(f.users.cliAcme, wAdmin.id, { active: false }), ForbiddenError);
    await expectThrows(() => f.svc.remove(f.users.cliAcme, wAdmin.id), ForbiddenError);
    // El PLATFORM_ADMIN sí puede sobre cualquiera
    const upd = await f.svc.update(f.users.platform, wAdmin.id, { active: false });
    assert.equal(upd.active, false);
  });

  await test('create valida URL http/https y eventos no vacíos/soportados', async () => {
    const f = await buildWebhookFixture();
    await expectThrows(() => f.svc.create(f.users.admin, { url: 'ftp://x', events: ['order.shipped'] }), ValidationError);
    await expectThrows(() => f.svc.create(f.users.admin, { url: 'https://h', events: [] as any }), ValidationError);
    await expectThrows(() => f.svc.create(f.users.admin, { url: 'https://h', events: ['nope' as any] }), ValidationError);
  });

  await test('webhooks: la fachada dispara los eventos del ciclo de la orden', async () => {
    const { facade, webhookRepo } = buildFacade();
    const flush = () => new Promise((r) => setTimeout(r, 40));
    await facade.createOperation({ id: 'op1', name: 'Op' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await facade.createLocation({ operationId: 'op1', code: 'RECV', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P', description: 'P' });
    await facade.receive('acme', { sku: 'P', qty: 100, locationId: recv.id });
    await facade.putaway('acme', { sku: 'P', qty: 100, fromLocationId: recv.id, toLocationId: stg.id });
    const platform = { id: 'root', name: 'Root', email: 'r@x.cl', role: 'PLATFORM_ADMIN', operationId: null, sellerId: null, active: true };
    const hook = await facade.createWebhook(platform as any, {
      url: 'https://example.test/hook',
      events: ['order.allocated', 'order.picking', 'order.picked', 'order.packed', 'order.shipped', 'order.cancelled'],
    });
    // A: reservar → pickear completo → empacar → despachar
    const A = await facade.createOrder('acme', { externalOrderId: 'A1', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'P', qty: 10 }] });
    await facade.allocateOrder('acme', A.id);
    await facade.confirmPick('acme', A.id);
    const packedA = await facade.packOrder('acme', A.id, { bultos: 2 });
    assert.equal(packedA.status, 'PACKED', 'quedó empacada');
    assert.ok(packedA.packing, 'tiene info de empaque');
    assert.equal(packedA.packing!.labelStatus, 'READY', 'el OMS entregó etiquetas');
    assert.equal(packedA.packing!.labels.length, 2, 'una etiqueta por bulto');
    assert.ok(packedA.packing!.trackingNumber, 'trae tracking del transporte');
    await facade.shipOrder('acme', A.id, { carrier: 'Chilexpress' });
    // B: reservar → cancelar
    const B = await facade.createOrder('acme', { externalOrderId: 'B1', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'P', qty: 5 }] });
    await facade.allocateOrder('acme', B.id);
    await facade.cancelOrder('acme', B.id);
    // C: reservar → pick parcial (queda en picking)
    const C = await facade.createOrder('acme', { externalOrderId: 'C1', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'P', qty: 8 }] });
    await facade.allocateOrder('acme', C.id);
    await facade.pickTask('acme', C.id, { sku: 'P', locationId: stg.id, qty: 3 }); // parcial → PICKING
    await flush();
    const evs = new Set((await webhookRepo.listDeliveries(hook.id)).map((d: any) => d.event));
    assert.ok(evs.has('order.allocated'), 'reservada');
    assert.ok(evs.has('order.picked'), 'pickeada');
    assert.ok(evs.has('order.packed'), 'empacada');
    assert.ok(evs.has('order.shipped'), 'despachada');
    assert.ok(evs.has('order.cancelled'), 'cancelada');
    assert.ok(evs.has('order.picking'), 'en picking');
  });

  console.log('\nCaptura de lote/vencimiento/serie y reserva masiva\n');

  async function seedSerialSeller(facade: WmsFacade) {
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await facade.createSku('acme', { sku: 'SER-1', description: 'Equipo serializado', serialControlled: true });
    await facade.createSku('acme', { sku: 'LOT-1', description: 'Producto por lote', lotControlled: true });
  }

  await test('recepción: SKU serializado registra las series con su lote y vencimiento', async () => {
    const { facade, serials } = buildFacade();
    await seedSerialSeller(facade);
    const rec = await facade.createReceipt('acme', { supplier: 'Prov', lines: [{ sku: 'SER-1', qty: 3 }] });
    await facade.receiveReceipt('acme', rec.id, [
      { lineNo: 1, qty: 3, lot: 'L-2026', expiry: '2027-01-31', serials: ['SN-A', 'SN-B', 'SN-C'] },
    ]);
    const all = await serials.list('acme', 'SER-1');
    assert.equal(all.length, 3);
    assert.ok(all.every((s) => s.lot === 'L-2026'), 'todas con el lote');
    assert.ok(all.every((s) => s.status === 'IN_STOCK'), 'todas en stock');
    const one = await facade.getSerial('acme', 'SER-1', 'SN-B');
    assert.ok(one && one.expiry && one.expiry.slice(0, 10) === '2027-01-31', 'serie trae su vencimiento');
  });

  await test('recepción: SKU controlado por lote exige lote al recepcionar', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await facade.createSku('acme', { sku: 'LOT-X', description: 'Por lote', lotControlled: true });
    const rec = await facade.createReceipt('acme', { supplier: 'P', lines: [{ sku: 'LOT-X', qty: 5 }] });
    // Sin lote -> rechazado.
    await expectThrows(() => facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 5 }]), ValidationError);
    // Con lote -> pasa.
    const done = await facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 5, lot: 'L-1' }]);
    assert.equal(done.status, 'RECEIVED');
  });

  await test('recepción: SKU controlado por vencimiento exige vencimiento', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await facade.createSku('acme', { sku: 'PER-X', description: 'Perecible', expiryControlled: true });
    const rec = await facade.createReceipt('acme', { supplier: 'P', lines: [{ sku: 'PER-X', qty: 3 }] });
    await expectThrows(() => facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 3 }]), ValidationError);
    const done = await facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 3, expiry: '2027-12-31' }]);
    assert.equal(done.status, 'RECEIVED');
  });

  await test('recepción: series distintas a la cantidad recibida es rechazada', async () => {
    const { facade } = buildFacade();
    await seedSerialSeller(facade);
    const rec = await facade.createReceipt('acme', { supplier: 'Prov', lines: [{ sku: 'SER-1', qty: 2 }] });
    await expectThrows(
      () => facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 2, serials: ['SOLO-UNO'] }]),
      ValidationError,
    );
  });

  await test('recepción: número de serie duplicado (ya en stock) es rechazado', async () => {
    const { facade } = buildFacade();
    await seedSerialSeller(facade);
    const r1 = await facade.createReceipt('acme', { supplier: 'Prov', lines: [{ sku: 'SER-1', qty: 1 }] });
    await facade.receiveReceipt('acme', r1.id, [{ lineNo: 1, qty: 1, serials: ['DUP-1'] }]);
    const r2 = await facade.createReceipt('acme', { supplier: 'Prov', lines: [{ sku: 'SER-1', qty: 1 }] });
    await expectThrows(
      () => facade.receiveReceipt('acme', r2.id, [{ lineNo: 1, qty: 1, serials: ['DUP-1'] }]),
      ValidationError,
    );
  });

  await test('reserva masiva: reserva las órdenes con stock y omite las que no alcanzan', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P1', description: 'Producto 1' });
    // Ingresa 5 unidades y guárdalas en almacenaje (reservable).
    const rec = await facade.createReceipt('acme', { supplier: 'Prov', lines: [{ sku: 'P1', qty: 5 }] });
    await facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 5 }]);
    const recvLoc = (await facade.getStock({ sellerId: 'acme' }))[0].locationId;
    await facade.putaway('acme', { sku: 'P1', qty: 5, fromLocationId: recvLoc, toLocationId: stg.id });
    // Orden A pide 4 (alcanza), Orden B pide 3 (ya no alcanza tras A).
    const a = await facade.createOrder('acme', { externalOrderId: 'A', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'P1', qty: 4 }] });
    const b = await facade.createOrder('acme', { externalOrderId: 'B', salesChannel: 'web', shipTo: { name: 'y' }, lines: [{ sku: 'P1', qty: 3 }] });
    const res = await facade.allocateOrders('acme', null);
    assert.equal(res.solicitadas, 2);
    assert.equal(res.reservadas, 1, 'una reservada');
    assert.equal(res.conError, 1, 'una sin stock');
    const orderA = await facade.getOrder('acme', a.id);
    const orderB = await facade.getOrder('acme', b.id);
    assert.equal(orderA!.status, 'ALLOCATED');
    assert.equal(orderB!.status, 'RECEIVED');
  });

  await test('cola de preparación: ordena por prioridad de courier y luego FIFO', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME', courierPriority: ['Rapiboy', 'DHL'] });
    await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 999, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P1', description: 'P1' });
    const rec = await facade.createReceipt('acme', { supplier: 'Prov', lines: [{ sku: 'P1', qty: 100 }] });
    await facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 100 }]);
    const recvLoc = (await facade.getStock({ sellerId: 'acme' }))[0].locationId;
    await facade.putaway('acme', { sku: 'P1', qty: 100, fromLocationId: recvLoc, toLocationId: stg.id });
    // Se crean en un orden; la cola debe reordenarlas por courier y antigüedad.
    const o1 = await facade.createOrder('acme', { externalOrderId: 'O1-CHILE-VIEJA', salesChannel: 'web', carrier: 'Chilexpress', shipTo: { name: 'x' }, lines: [{ sku: 'P1', qty: 1 }] });
    const o2 = await facade.createOrder('acme', { externalOrderId: 'O2-DHL', salesChannel: 'web', carrier: 'DHL', shipTo: { name: 'x' }, lines: [{ sku: 'P1', qty: 1 }] });
    const o3 = await facade.createOrder('acme', { externalOrderId: 'O3-RAPIBOY', salesChannel: 'web', carrier: 'Rapiboy', shipTo: { name: 'x' }, lines: [{ sku: 'P1', qty: 1 }] });
    const o4 = await facade.createOrder('acme', { externalOrderId: 'O4-SINCOURIER', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'P1', qty: 1 }] });
    for (const o of [o1, o2, o3, o4]) await facade.allocateOrder('acme', o.id);
    const queue = await facade.getPickingQueue('acme');
    // Esperado: Rapiboy (prio 0) → DHL (prio 1) → Chilexpress (no listado) → sin courier (último).
    assert.deepEqual(queue.map((q) => q.externalOrderId), ['O3-RAPIBOY', 'O2-DHL', 'O1-CHILE-VIEJA', 'O4-SINCOURIER']);
    assert.equal(queue[0].queuePosition, 1);
    // Solo entran las reservadas/en picking.
    assert.ok(queue.every((q) => q.status === 'ALLOCATED' || q.status === 'PICKING'));
  });

  await test('cola de preparación: sin prioridad de courier, es FIFO por antigüedad', async () => {
    const { facade, clock } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' }); // courierPriority vacío
    await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 999, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P1', description: 'P1' });
    const rec = await facade.createReceipt('acme', { supplier: 'Prov', lines: [{ sku: 'P1', qty: 100 }] });
    await facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 100 }]);
    const recvLoc = (await facade.getStock({ sellerId: 'acme' }))[0].locationId;
    await facade.putaway('acme', { sku: 'P1', qty: 100, fromLocationId: recvLoc, toLocationId: stg.id });
    clock.set('2026-01-01T00:00:00.000Z');
    const vieja = await facade.createOrder('acme', { externalOrderId: 'VIEJA', salesChannel: 'web', carrier: 'Chilexpress', shipTo: { name: 'x' }, lines: [{ sku: 'P1', qty: 1 }] });
    clock.set('2026-02-01T00:00:00.000Z');
    const nueva = await facade.createOrder('acme', { externalOrderId: 'NUEVA', salesChannel: 'web', carrier: 'Rapiboy', shipTo: { name: 'x' }, lines: [{ sku: 'P1', qty: 1 }] });
    await facade.allocateOrder('acme', nueva.id);
    await facade.allocateOrder('acme', vieja.id);
    const queue = await facade.getPickingQueue('acme');
    // Sin prioridad de courier, manda la antigüedad: la más vieja primero pese al courier.
    assert.deepEqual(queue.map((q) => q.externalOrderId), ['VIEJA', 'NUEVA']);
  });

  console.log('\nInsumos de embalaje (packaging)\n');

  async function seedForPacking(facade: WmsFacade, clock: FixedClock) {
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 999, pickRank: 1 });
    await facade.createSku('acme', { sku: 'P1', description: 'P1' });
    const rec = await facade.createReceipt('acme', { supplier: 'P', lines: [{ sku: 'P1', qty: 10 }] });
    await facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 10 }]);
    const recvLoc = (await facade.getStock({ sellerId: 'acme' }))[0].locationId;
    await facade.putaway('acme', { sku: 'P1', qty: 10, fromLocationId: recvLoc, toLocationId: stg.id });
    return { stg };
  }
  async function orderToPicked(facade: WmsFacade, ext: string, qty: number) {
    const o = await facade.createOrder('acme', { externalOrderId: ext, salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'P1', qty }] });
    await facade.allocateOrder('acme', o.id);
    await facade.confirmPick('acme', o.id);
    return o;
  }

  await test('embalaje: consumo al empacar descuenta stock y queda en la orden', async () => {
    const { facade, clock } = buildFacade();
    clock.set('2026-05-15T12:00:00.000Z');
    await seedForPacking(facade, clock);
    await facade.createPackaging('op1', { sku: 'CAJA-M', name: 'Caja M', unitPrice: 500 });
    await facade.receivePackagingStock('op1', 'CAJA-M', 100);
    const o = await orderToPicked(facade, 'O1', 2);
    await facade.packOrder('acme', o.id, { bultos: 1, materials: [{ sku: 'CAJA-M', qty: 3 }] });
    const cat = await facade.listPackaging('op1');
    assert.equal(cat.find((m) => m.sku === 'CAJA-M')!.onHand, 97, 'stock descontado 100 - 3');
    const order = await facade.getOrder('acme', o.id);
    assert.equal(order!.packing!.materials.length, 1);
    assert.equal(order!.packing!.materials[0].qty, 3);
    assert.equal(order!.packing!.materials[0].name, 'Caja M');
  });

  await test('embalaje: se cobra en la factura con precio por defecto', async () => {
    const { facade, billingService, clock } = buildFacade();
    clock.set('2026-05-15T12:00:00.000Z');
    await seedForPacking(facade, clock);
    await facade.createPackaging('op1', { sku: 'CAJA-M', name: 'Caja M', unitPrice: 500 });
    await facade.receivePackagingStock('op1', 'CAJA-M', 100);
    const o = await orderToPicked(facade, 'O1', 2);
    await facade.packOrder('acme', o.id, { bultos: 1, materials: [{ sku: 'CAJA-M', qty: 3 }] });
    await facade.shipOrder('acme', o.id, { carrier: 'X' });
    const inv = await billingService.computeInvoice('acme', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    const line = inv.lines.find((l) => l.concept.includes('Caja M'));
    assert.ok(line, 'hay línea de embalaje');
    assert.equal(line!.qty, 3);
    assert.equal(line!.rate, 500);
    assert.equal(line!.amount, 1500);
  });

  await test('embalaje: precio custom por seller pisa el precio por defecto en el cobro', async () => {
    const { facade, billingService, clock } = buildFacade();
    clock.set('2026-05-15T12:00:00.000Z');
    await seedForPacking(facade, clock);
    await facade.createPackaging('op1', { sku: 'CAJA-M', name: 'Caja M', unitPrice: 500 });
    await facade.receivePackagingStock('op1', 'CAJA-M', 100);
    await facade.setPackagingSellerPrice('op1', 'CAJA-M', 'acme', 800); // override para ACME
    const o = await orderToPicked(facade, 'O1', 2);
    await facade.packOrder('acme', o.id, { bultos: 1, materials: [{ sku: 'CAJA-M', qty: 2 }] });
    await facade.shipOrder('acme', o.id, { carrier: 'X' });
    const inv = await billingService.computeInvoice('acme', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    const line = inv.lines.find((l) => l.concept.includes('Caja M'));
    assert.ok(line);
    assert.equal(line!.rate, 800, 'usa el precio override del seller');
    assert.equal(line!.amount, 1600);
  });

  // ---- Canal de voz operador↔admin -----------------------------------------
  function buildOpsChannel() {
    const repo = new InMemoryOpsChannelRepository();
    const svc = new OpsChannelService(repo, new SequentialIdGenerator('ops'), new FixedClock());
    return { repo, svc };
  }

  await test('canal: clasificación heurística detecta el tópico por palabras clave', async () => {
    assert.equal(classifyHeuristic('Falta stock de la caja, hay diferencia en inventario').category, 'stock');
    assert.equal(classifyHeuristic('No encuentro la ubicación, en qué pasillo está el rack').category, 'ubicaciones');
    assert.equal(classifyHeuristic('El producto llegó roto, hay un producto dañado').category, 'incidencia');
    assert.equal(classifyHeuristic('La pistola scanner no funciona, falla el lector').category, 'equipos');
    // Sin coincidencias -> otro, confianza 0.
    const none = classifyHeuristic('hola buenas tardes');
    assert.equal(none.category, 'otro');
    assert.equal(none.confidence, 0);
  });

  await test('canal: la clasificación ignora acentos y mayúsculas', async () => {
    // "Ubicación" con acento debe caer en ubicaciones.
    assert.equal(classifyHeuristic('UBICACIÓN incorrecta en el estante').category, 'ubicaciones');
  });

  await test('canal: enviar mensaje de texto lo clasifica y guarda en el hilo del operador', async () => {
    const { svc } = buildOpsChannel();
    const m = await svc.send('op1', {
      threadUserId: 'oper-1', senderId: 'oper-1', senderName: 'Juan', senderRole: 'OPERATOR',
      kind: 'text', text: 'Falta stock en la zona A, hay un quiebre',
    });
    assert.equal(m.category, 'stock');
    assert.equal(m.categorySource, 'heuristic');
    assert.equal(m.kind, 'text');
    const list = await svc.listMessages('op1', { threadUserId: 'oper-1' });
    assert.equal(list.length, 1);
    // Aislamiento por operación.
    assert.equal((await svc.listMessages('op2')).length, 0);
  });

  await test('canal: mensaje de voz guarda el audio y se recupera por id', async () => {
    const { svc } = buildOpsChannel();
    const m = await svc.send('op1', {
      threadUserId: 'oper-1', senderId: 'oper-1', senderName: 'Juan', senderRole: 'OPERATOR',
      kind: 'voice', audioBase64: 'QUJD', audioMime: 'audio/webm', durationSec: 5,
      note: 'el scanner y la impresora del equipo no sirven',
    });
    assert.ok(m.audioId, 'debe generar audioId');
    // Sin IA real, clasifica por la nota.
    assert.equal(m.category, 'equipos');
    const blob = await svc.getAudio('op1', m.audioId!);
    assert.ok(blob);
    assert.equal(blob!.dataBase64, 'QUJD');
    assert.equal(blob!.mime, 'audio/webm');
  });

  await test('canal: mensaje de voz sin audio o texto vacío son rechazados', async () => {
    const { svc } = buildOpsChannel();
    await expectThrows(() => svc.send('op1', {
      threadUserId: 'o', senderId: 'o', senderName: 'x', senderRole: 'OPERATOR', kind: 'voice',
    }) as Promise<unknown>, ValidationError);
    await expectThrows(() => svc.send('op1', {
      threadUserId: 'o', senderId: 'o', senderName: 'x', senderRole: 'OPERATOR', kind: 'text', text: '   ',
    }) as Promise<unknown>, ValidationError);
  });

  await test('canal: estadísticas agregan por categoría y por operador (excluye admin)', async () => {
    const { svc } = buildOpsChannel();
    await svc.send('op1', { threadUserId: 'o1', senderId: 'o1', senderName: 'Ana', senderRole: 'OPERATOR', kind: 'text', text: 'falta stock, quiebre de unidades' });
    await svc.send('op1', { threadUserId: 'o1', senderId: 'o1', senderName: 'Ana', senderRole: 'OPERATOR', kind: 'text', text: 'otra diferencia de inventario en stock' });
    await svc.send('op1', { threadUserId: 'o2', senderId: 'o2', senderName: 'Beto', senderRole: 'OPERATOR', kind: 'text', text: 'no encuentro la ubicación del pasillo' });
    // Respuesta del admin: no cuenta como operador.
    await svc.send('op1', { threadUserId: 'o1', senderId: 'adm', senderName: 'Jefe', senderRole: 'ADMIN', kind: 'text', text: 'ya lo reviso' });
    const s = await svc.stats('op1');
    assert.equal(s.total, 4);
    assert.equal(s.text, 4);
    assert.equal(s.voice, 0);
    const stock = s.byCategory.find((c) => c.category === 'stock');
    assert.equal(stock!.count, 2);
    // Dos operadores; el admin no aparece en byOperator.
    assert.equal(s.byOperator.length, 2);
    assert.ok(!s.byOperator.some((o) => o.userId === 'adm'));
    assert.equal(s.byOperator[0].userId, 'o1'); // el de más mensajes primero
  });

  await test('canal: insights heurísticos priorizan el tópico dominante con sugerencia', async () => {
    // 4 incidencias de 5 -> 80% -> sugerencia de incidencias.
    const counts = { incidencia: 4, stock: 1 };
    const ins = insightsHeuristic(counts, 5);
    assert.equal(ins.generatedBy, 'heuristic');
    assert.equal(ins.totalMessages, 5);
    assert.equal(ins.topTopics[0].category, 'incidencia');
    assert.equal(ins.topTopics[0].pct, 80);
    assert.ok(ins.suggestions.some((t) => /incidencia/i.test(t)));
  });

  await test('canal: insights sin mensajes no rompe', async () => {
    const ins = insightsHeuristic({}, 0);
    assert.equal(ins.totalMessages, 0);
    assert.equal(ins.topTopics.length, 0);
    assert.ok(ins.summary.length > 0);
  });

  // ---- Copiloto -------------------------------------------------------------
  await test('copiloto: clasifica intenciones en español', async () => {
    assert.equal(parseCopilotIntent('¿qué SKUs están por quebrar stock?').intent, 'low_stock');
    assert.equal(parseCopilotIntent('cuántas órdenes tengo pendientes').intent, 'open_orders');
    assert.equal(parseCopilotIntent('qué se despachó hoy').intent, 'shipped');
    assert.equal(parseCopilotIntent('muéstrame la cola de preparación').intent, 'pending_pick');
    assert.equal(parseCopilotIntent('cuánto llevo facturado este mes').intent, 'billing_month');
    assert.equal(parseCopilotIntent('hola, buenos días').intent, 'help');
  });

  await test('copiloto: detecta ventana temporal y candidato de SKU', async () => {
    assert.equal(parseCopilotIntent('qué se despachó este mes').window, 'month');
    assert.equal(parseCopilotIntent('despachos de la semana').window, 'week');
    const r = parseCopilotIntent('cuánto stock hay de SKU-100');
    assert.equal(r.intent, 'sku_stock');
    assert.equal(r.skuGuess, 'SKU-100');
  });

  await test('copiloto: insights priorizan reabastecimiento y órdenes en riesgo', async () => {
    const ins = buildInsights({
      lowStock: [
        { sku: 'A', name: 'A', onHand: 0, demand: 30, windowDays: 30, coverageDays: 0, reorder: 30 },
        { sku: 'B', name: 'B', onHand: 3, demand: 30, windowDays: 30, coverageDays: 3, reorder: 27 },
      ],
      agingOrders: [{ id: 'o1', ref: 'ACME-1', days: 4, status: 'ALLOCATED' }],
      pendingPick: 2, toAllocate: 1, shippedToday: 5,
    });
    const ids = ins.map((i) => i.id);
    assert.ok(ids.includes('low_stock'));
    assert.ok(ids.includes('aging_orders'));
    assert.ok(ids.includes('pending_pick'));
    // Con un SKU en 0, el reabastecimiento es crítico.
    assert.equal(ins.find((i) => i.id === 'low_stock')!.severity, 'crit');
  });

  await test('copiloto: sin problemas devuelve "todo al día"', async () => {
    const ins = buildInsights({ lowStock: [], agingOrders: [], pendingPick: 0, toAllocate: 0, shippedToday: 3 });
    assert.equal(ins.length, 1);
    assert.equal(ins[0].id, 'all_clear');
  });

  await test('copiloto: nuevas intenciones (vencimientos, embalaje, anomalías)', async () => {
    assert.equal(parseCopilotIntent('¿qué lotes están por vencer?').intent, 'expiring');
    assert.equal(parseCopilotIntent('mostrar vencimientos FEFO').intent, 'expiring');
    assert.equal(parseCopilotIntent('¿qué insumos de embalaje se están por agotar?').intent, 'packaging_low');
    assert.equal(parseCopilotIntent('¿hay alguna anomalía de consumo?').intent, 'anomalies');
  });

  await test('copiloto: insights de vencimiento, embalaje y anomalías', async () => {
    const ins = buildInsights({
      lowStock: [], agingOrders: [], pendingPick: 0, toAllocate: 0, shippedToday: 0,
      expiringLots: [{ sku: 'LECHE', lot: 'L1', days: -1, qty: 10 }, { sku: 'YOG', lot: 'L2', days: 5, qty: 4 }],
      packagingLow: [{ sku: 'CAJA-M', name: 'Caja M', onHand: 2, demand: 40, windowDays: 14, coverageDays: 1, reorder: 38 }],
      anomalies: [{ sellerName: 'ACME', metric: 'despachos 7d', changePct: 120, from: 5, to: 11 }],
    });
    const ids = ins.map((i) => i.id);
    assert.ok(ids.includes('expiring'));
    assert.ok(ids.includes('packaging_low'));
    assert.ok(ids.includes('anomalies'));
    // Con un lote ya vencido, el insight de vencimiento es crítico.
    assert.equal(ins.find((i) => i.id === 'expiring')!.severity, 'crit');
  });

  await test('copiloto tools: dispatcher entrega datos y respeta el tenant', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createSeller({ id: 'globex', operationId: 'op1', name: 'Globex' });
    const recv = await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 10, locationId: recv.id });

    const cli = await facade.runCopilotTool('clientes_operacion', {}, 'op1', null);
    assert.equal(cli.clientes.length, 2);

    const inv = await facade.runCopilotTool('inventario_resumen', {}, 'op1', null);
    assert.equal(inv.inventario.find((x: any) => x.sellerId === 'acme').total, 10);

    const st = await facade.runCopilotTool('stock_de_sku', { sku: 'CAM' }, 'op1', null);
    assert.equal(st.resultados[0].total, 10);

    const kx = await facade.runCopilotTool('kardex_sku', { sku: 'CAM' }, 'op1', null);
    assert.ok(kx.total >= 1);

    // Aislamiento: un seller no puede espiar a otro aunque el LLM proponga su id.
    const scoped = await facade.runCopilotTool('inventario_resumen', { sellerId: 'globex' }, 'op1', 'acme');
    assert.equal(scoped.inventario.length, 1);
    assert.equal(scoped.inventario[0].sellerId, 'acme');

    const unk = await facade.runCopilotTool('no_existe', {}, 'op1', null);
    assert.ok(unk.error);
  });

  await test('copiloto acciones: crear recepción, crear orden + reservar y asignar los 7 tipos', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id }); // stock en STORAGE (reservable)
    const oper = await facade.createUser({ name: 'Pedro', email: 'pedro@nh.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    // Este test prueba la EJECUCIÓN de las acciones: nivel 3 y sin sombra (la política se prueba aparte).
    await facade.updateAgentSettings('op1', { autonomyLevel: 3, shadowMode: false, actionMode: 'direct' }, 'ana');

    const call = (name: string, args: any, mode: 'confirm' | 'direct' = 'direct', pendingActions: any[] = []) =>
      (facade as any).copilotExecAction(name, args, { operationId: 'op1', sellerId: null, mode, canWrite: true, question: 't', actor: { id: 'ana', role: UserRole.ADMIN }, pendingActions });

    // 1) Crear recepción (inbound) — queda pendiente para cotejo.
    const rc = await call('crear_recepcion', { sellerId: 'acme', proveedor: 'Prov X', lineas: [{ sku: 'CAM', qty: 30 }] });
    assert.ok(rc.ok, `recepción creada: ${JSON.stringify(rc)}`);
    assert.equal(rc.unidadesEsperadas, 30);
    assert.equal((await facade.listReceipts('acme')).length, 1);

    // 2) Crear orden SIN reservar → RECEIVED (borrador, sin comprometer stock).
    const o1 = await call('crear_orden', { sellerId: 'acme', destinatario: { nombre: 'Juan' }, lineas: [{ sku: 'CAM', qty: 2 }] });
    assert.ok(o1.ok); assert.equal(o1.estado, 'RECEIVED');

    // 3) Crear orden CON reservar en modo DIRECTO → ALLOCATED (stock reservado).
    const o2 = await call('crear_orden', { sellerId: 'acme', destinatario: { nombre: 'Ana', direccion: 'Calle 1' }, lineas: [{ sku: 'CAM', qty: 3 }], reservar: true });
    assert.ok(o2.ok); assert.equal(o2.estado, 'ALLOCATED'); assert.equal(o2.reservada, true);

    // 4) Crear orden CON reservar en modo CONFIRMACIÓN → TODA la creación queda PROPUESTA
    //    (política Fase 1: en confirmación no se escribe nada de nivel ≥2 sin un humano).
    await facade.updateAgentSettings('op1', { actionMode: 'confirm' }, 'ana');
    const pend: any[] = [];
    const o3 = await call('crear_orden', { sellerId: 'acme', destinatario: { nombre: 'Luis' }, lineas: [{ sku: 'CAM', qty: 1 }], reservar: true }, 'confirm', pend);
    assert.equal(o3.requiresConfirmation, true); assert.equal(pend.length, 1); assert.equal(pend[0].tool, 'crear_orden');
    assert.equal((await facade.listOrders('acme')).length, 2, 'la orden NO se creó hasta confirmar');
    const c3 = await facade.copilotConfirmTool('op1', null, { id: 'ana', role: UserRole.ADMIN }, { tool: pend[0].tool, args: pend[0].args });
    assert.ok(c3.ok); assert.equal(c3.estado, 'ALLOCATED', 'al confirmar se crea Y se reserva');
    await facade.updateAgentSettings('op1', { actionMode: 'direct' }, 'ana');

    // 5) Asignar tarea ligada a orden: PICK, luego PACK y SHIP avanzando el estado.
    assert.ok((await call('asignar_tarea', { tipo: 'PICK', entidad: o2.orden, operario: oper.id })).ok, 'PICK asignada');
    await facade.confirmPick('acme', o2.id, 'ana');
    assert.ok((await call('asignar_tarea', { tipo: 'PACK', entidad: o2.orden, operario: oper.id })).ok, 'PACK asignada');
    await facade.packOrder('acme', o2.id, { bultos: 1, materials: [] }, 'ana');
    assert.ok((await call('asignar_tarea', { tipo: 'SHIP', entidad: o2.orden, operario: oper.id })).ok, 'SHIP asignada');

    // 6) Asignar tarea desde el pool: RECEIVE (la recepción recién creada).
    const poolR = await facade.getTaskPool('op1', 'RECEIVE');
    assert.ok(poolR.length >= 1, 'hay recepción en el pool RECEIVE');
    const aRecv = await call('asignar_tarea', { tipo: 'RECEIVE', entidad: poolR[0].entityRef || poolR[0].entityId, operario: oper.id });
    assert.ok(aRecv.ok, `RECEIVE asignada: ${JSON.stringify(aRecv)}`);

    // 7) Sin permisos de escritura, toda acción es rechazada.
    const denied = await (facade as any).copilotExecAction('crear_orden', { sellerId: 'acme', destinatario: { nombre: 'X' }, lineas: [{ sku: 'CAM', qty: 1 }] }, { operationId: 'op1', sellerId: null, mode: 'direct', canWrite: false, question: 't', actor: { id: 'c', role: UserRole.CLIENT }, pendingActions: [] });
    assert.ok(denied.error, 'sin permiso → error');
  });

  await test('copiloto: las herramientas de acción están registradas', async () => {
    const names = COPILOT_ACTION_TOOLS.map((t) => t.name);
    for (const n of ['crear_recepcion', 'crear_orden', 'asignar_tarea']) {
      assert.ok(names.includes(n), `acción registrada: ${n}`);
    }
    // asignar_tarea acepta los 7 tipos que ejecuta un operario.
    const asignar = COPILOT_ACTION_TOOLS.find((t) => t.name === 'asignar_tarea');
    const tipos = (asignar as any).parameters.properties.tipo.enum as string[];
    for (const t of ['PICK', 'PACK', 'SHIP', 'PUTAWAY', 'COUNT', 'RECEIVE', 'RESLOT']) {
      assert.ok(tipos.includes(t), `asignar_tarea soporta ${t}`);
    }
  });

  await test('ledger de tareas: cada etapa de la orden es una tarea con id, tipo y relación a la orden', async () => {
    const { facade, taskLedger } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });

    const order = await facade.createOrder('acme', { externalOrderId: 'PED-1', salesChannel: 'shopify', shipTo: { name: 'Juan' }, lines: [{ sku: 'CAM', qty: 4 }] }, 'ana');
    // Recorre el ciclo: reservar → picking → pickear → empacar → despachar.
    await facade.allocateOrder('acme', order.id, 'ana');
    await facade.startPicking('acme', order.id, 'ana');
    await facade.confirmPick('acme', order.id, 'ana');
    await facade.packOrder('acme', order.id, { bultos: 1, materials: [] }, 'ana');
    await facade.shipOrder('acme', order.id, {}, 'ana');

    const tasks = await facade.orderTasks('acme', order.id);
    const byType: Record<string, any> = {};
    for (const t of tasks) byType[t.type] = t;
    for (const stage of ['RESERVE', 'PICK', 'PACK', 'SHIP']) {
      assert.ok(byType[stage], `existe tarea de etapa ${stage}`);
      assert.ok(/^t-\d+$/.test(byType[stage].id), `${stage} tiene id interno secuencial (${byType[stage].id})`);
      assert.equal(byType[stage].orderId, order.id, `${stage} está ligada a la orden`);
      assert.equal(byType[stage].state, 'done', `${stage} quedó hecha al recorrer el ciclo`);
    }
    // Se resuelve también por referencia externa de la orden.
    const byRef = await facade.orderTasks('acme', 'PED-1');
    assert.equal(byRef.length, tasks.length);

    // El copiloto puede consultar las tareas de la orden.
    const viaTool: any = await facade.runCopilotTool('tareas_de_orden', { orden: 'PED-1' }, 'op1', null);
    assert.ok(viaTool.tareas && viaTool.tareas.length >= 4, 'tareas_de_orden entrega las etapas');
  });

  await test('ledger de tareas: asignar liga la tarea al operario; recepción y guardado se registran', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    const oper = await facade.createUser({ name: 'Pedro', email: 'pedro@nh.cl', role: UserRole.OPERATOR, operationId: 'op1' });

    // Orden reservada → tarea PICK pendiente; al asignarla queda 'assigned' con operario.
    const order = await facade.createOrder('acme', { externalOrderId: 'PED-9', salesChannel: 'shopify', shipTo: { name: 'Ana' }, lines: [{ sku: 'CAM', qty: 2 }] }, 'ana');
    await facade.allocateOrder('acme', order.id, 'ana');
    await facade.assignTask('op1', { type: 'PICK', entityId: order.id, entityRef: 'PED-9', sellerId: 'acme', operator: oper.id, unitsEstimate: 2, by: 'ana' });
    const pick = (await facade.orderTasks('acme', order.id)).find((t) => t.type === 'PICK');
    assert.ok(pick); assert.equal(pick!.state, 'assigned'); assert.equal(pick!.operator, oper.id);
    assert.equal(pick!.assignmentId, 'PICK:' + order.id);

    // Recepción: crea tarea RECEIVE pendiente; al cotejar completo queda hecha.
    const rec = await facade.createReceipt('acme', { locationId: recv.id, lines: [{ sku: 'CAM', qty: 10 }] }, 'ana');
    let recvTasks = await facade.listTasks('op1', { type: 'RECEIVE' });
    assert.ok(recvTasks.find((t) => t.entityId === rec.id && t.state === 'pending'), 'RECEIVE pendiente creada');
    await facade.receiveReceipt('acme', rec.id, [{ lineNo: 1, qty: 10 }], 'ana');
    recvTasks = await facade.listTasks('op1', { type: 'RECEIVE' });
    assert.equal(recvTasks.find((t) => t.entityId === rec.id)!.state, 'done', 'RECEIVE hecha tras cotejo');
  });

  await test('disponibilidad de operarios: la IA la ve y las asignaciones la respetan', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    const activo = await facade.createUser({ id: 'pedro', name: 'Pedro', email: 'pedro@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const inactivo = await facade.createUser({ id: 'luis', name: 'Luis', email: 'luis@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    await facade.deactivateUser(inactivo.id);
    const cli = await facade.createUser({ id: 'c1', name: 'Cli', email: 'c1@op1.cl', role: UserRole.CLIENT, operationId: 'op1', sellerId: 'acme' });

    // La IA ve el directorio con activos e inactivos.
    const dir: any = await facade.runCopilotTool('operarios', {}, 'op1', null);
    assert.equal(dir.activos, 1); assert.equal(dir.inactivos, 1);
    assert.equal(dir.operarios.find((o: any) => o.id === 'pedro').activo, true);
    assert.equal(dir.operarios.find((o: any) => o.id === 'luis').activo, false);

    const order = await facade.createOrder('acme', { externalOrderId: 'PED-A', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 2 }] }, 'ana');
    await facade.allocateOrder('acme', order.id, 'ana');

    // No se puede asignar a un operario inactivo, ni a un cliente; sí a uno activo.
    await expectThrows(() => facade.assignTask('op1', { type: 'PICK', entityId: order.id, entityRef: 'PED-A', sellerId: 'acme', operator: inactivo.id, unitsEstimate: 2, by: 'ana' }), ValidationError);
    await expectThrows(() => facade.assignTask('op1', { type: 'PICK', entityId: order.id, entityRef: 'PED-A', sellerId: 'acme', operator: cli.id, unitsEstimate: 2, by: 'ana' }), ValidationError);
    await expectThrows(() => facade.assignTask('op1', { type: 'PICK', entityId: order.id, entityRef: 'PED-A', sellerId: 'acme', operator: 'fantasma', unitsEstimate: 2, by: 'ana' }), ValidationError);
    const ok = await facade.assignTask('op1', { type: 'PICK', entityId: order.id, entityRef: 'PED-A', sellerId: 'acme', operator: activo.id, unitsEstimate: 2, by: 'ana' });
    assert.equal(ok.operator, 'pedro');
  });

  await test('reserva inmediata por cliente: la orden se reserva al ingresar si está configurado', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });

    // Por defecto (sin configurar): la orden nace RECEIVED (pasa por revisión).
    const o1 = await facade.createOrder('acme', { externalOrderId: 'PED-1', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 2 }] }, 'ana');
    assert.equal(o1.status, 'RECEIVED');

    // El administrador activa la reserva inmediata para el cliente.
    const seller = await facade.updateSellerPolicy('acme', { autoAllocateOnIngest: true });
    assert.equal(seller.autoAllocateOnIngest, true);

    // Ahora una orden nueva se reserva sola al ingresar.
    const o2 = await facade.createOrder('acme', { externalOrderId: 'PED-2', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 3 }] }, 'ana');
    assert.equal(o2.status, 'ALLOCATED');
    // Y su tarea RESERVE queda registrada en el ledger.
    const reserve = (await facade.orderTasks('acme', o2.id)).find((t) => t.type === 'RESERVE');
    assert.ok(reserve && reserve.state === 'done', 'la reserva quedó registrada como tarea');

    // Sin stock suficiente, la reserva inmediata no rompe el ingreso: queda RECEIVED.
    const o3 = await facade.createOrder('acme', { externalOrderId: 'PED-3', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 9999 }] }, 'ana');
    assert.equal(o3.status, 'RECEIVED');
  });

  await test('agente: catálogo de reglas + override persistente', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    const rules = await facade.agentRules('op1');
    assert.equal(rules.length, 6, 'seis reglas en el catálogo');
    assert.ok(rules.every((r) => typeof r.enabled === 'boolean' && r.threshold >= 0), 'cada regla trae config efectiva');
    const upd = await facade.updateAgentRule('op1', 'orden_estancada', { threshold: 6, enabled: false }, 'ana');
    assert.equal(upd.threshold, 6); assert.equal(upd.enabled, false);
    const again = await facade.agentRules('op1');
    const r = again.find((x) => x.ruleKey === 'orden_estancada')!;
    assert.equal(r.threshold, 6); assert.equal(r.enabled, false);
  });

  await test('agente: detecta operario inactivo con carga, deduplica y se descarta', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    const pedro = await facade.createUser({ id: 'pedro', name: 'Pedro', email: 'pedro@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const order = await facade.createOrder('acme', { externalOrderId: 'PED-1', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 2 }] }, 'ana');
    await facade.allocateOrder('acme', order.id, 'ana');
    await facade.assignTask('op1', { type: 'PICK', entityId: order.id, entityRef: 'PED-1', sellerId: 'acme', operator: pedro.id, unitsEstimate: 2, by: 'ana' });
    await facade.deactivateUser('pedro'); // queda inactivo CON una tarea abierta

    const sweep1 = await facade.runAgentSweep('op1');
    assert.ok(sweep1.nuevas >= 1, 'el barrido genera al menos una alerta');
    let open = (await facade.agentAlerts('op1')).abiertas;
    const inact = open.filter((a) => a.ruleKey === 'operario_inactivo');
    assert.equal(inact.length, 1, 'una alerta de operario inactivo');

    // Segundo barrido: no duplica (ya hay una abierta).
    await facade.runAgentSweep('op1');
    open = (await facade.agentAlerts('op1')).abiertas;
    assert.equal(open.filter((a) => a.ruleKey === 'operario_inactivo').length, 1, 'sigue habiendo solo una (dedupe)');

    // El copiloto ve la alerta.
    const viaTool: any = await facade.runCopilotTool('alertas_activas', {}, 'op1', null);
    assert.ok(viaTool.total >= 1 && viaTool.alertas.length >= 1);

    // Descartar la cierra.
    const r = await facade.ackAgentAlert('op1', inact[0].id, 'ana');
    assert.equal(r.ok, true);
    open = (await facade.agentAlerts('op1')).abiertas;
    assert.equal(open.filter((a) => a.ruleKey === 'operario_inactivo').length, 0, 'descartada → ya no está abierta');
  });

  await test('agente: regla apagada no dispara; orden estancada dispara por tiempo', async () => {
    const { facade, clock } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.createOrder('acme', { externalOrderId: 'PED-9', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 1 }] }, 'ana');

    // Regla apagada: aunque la orden envejezca, no genera alerta.
    await facade.updateAgentRule('op1', 'orden_estancada', { enabled: false }, 'ana');
    clock.set('2026-01-03T00:00:00.000Z'); // 48 h después
    await facade.runAgentSweep('op1');
    let open = (await facade.agentAlerts('op1')).abiertas;
    assert.equal(open.filter((a) => a.ruleKey === 'orden_estancada').length, 0, 'apagada → no dispara');

    // Encendida (umbral 24 h) y con la orden detenida 48 h → dispara.
    await facade.updateAgentRule('op1', 'orden_estancada', { enabled: true, threshold: 24 }, 'ana');
    await facade.runAgentSweep('op1');
    open = (await facade.agentAlerts('op1')).abiertas;
    assert.equal(open.filter((a) => a.ruleKey === 'orden_estancada').length, 1, 'encendida + 48h detenida → alerta');
  });

  await test('agente Fase 3: solo reglas con acción pueden ejecutar', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    // quiebre_stock no tiene acción automática → no se puede poner en 'execute'.
    await expectThrows(() => facade.updateAgentRule('op1', 'quiebre_stock', { actionType: 'execute' }, 'ana'), ValidationError);
    // operario_inactivo sí.
    const upd = await facade.updateAgentRule('op1', 'operario_inactivo', { actionType: 'execute', actionMode: 'directo' }, 'ana');
    assert.equal(upd.actionType, 'execute'); assert.equal(upd.actionMode, 'directo');
    const rules = await facade.agentRules('op1');
    assert.ok(rules.find((r) => r.ruleKey === 'operario_inactivo')!.autoAction, 'operario_inactivo expone su acción');
    assert.equal(rules.find((r) => r.ruleKey === 'quiebre_stock')!.autoAction, null, 'quiebre_stock no tiene acción');
  });

  await test('agente Fase 3: modo DIRECTO ejecuta y reasigna; modo CONFIRMAR propone y luego ejecuta', async () => {
    async function setup() {
      const f = buildFacade();
      await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
      await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
      const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
      await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
      await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
      const pedro = await f.facade.createUser({ id: 'pedro', name: 'Pedro', email: 'p@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
      await f.facade.createUser({ id: 'carla', name: 'Carla', email: 'c@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' }); // activa, recibe la carga
      await f.facade.updateAgentSettings('op1', { autonomyLevel: 1, shadowMode: false }, 'ana'); // ejecución real (sin sombra)
      const order = await f.facade.createOrder('acme', { externalOrderId: 'PED-1', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 2 }] }, 'ana');
      await f.facade.allocateOrder('acme', order.id, 'ana');
      await f.facade.assignTask('op1', { type: 'PICK', entityId: order.id, entityRef: 'PED-1', sellerId: 'acme', operator: pedro.id, unitsEstimate: 2, by: 'ana' });
      await f.facade.deactivateUser('pedro');
      return f.facade;
    }

    // DIRECTO: el barrido ejecuta solo.
    let facade = await setup();
    await facade.updateAgentRule('op1', 'operario_inactivo', { actionType: 'execute', actionMode: 'directo' }, 'ana');
    await facade.runAgentSweep('op1');
    let al = (await facade.agentAlerts('op1')).abiertas.find((a) => a.ruleKey === 'operario_inactivo')!;
    assert.ok(al, 'se generó la alerta');
    assert.equal(al.actionStatus, 'done', 'en directo, la acción quedó ejecutada');
    assert.match(al.actionResult || '', /liberada/);
    assert.equal((await facade.getOperatorTasks('op1', 'pedro')).length, 0, 'pedro quedó sin tareas');
    assert.equal((await facade.getOperatorTasks('op1', 'carla')).length, 1, 'carla recibió la tarea');
    const acts = await facade.listAgentActions('op1', { agent: 'agent-rule' });
    assert.ok(acts.length >= 1, 'quedó registrada en auditoría IA');

    // CONFIRMAR: el barrido propone; la ejecución es explícita.
    facade = await setup();
    await facade.updateAgentRule('op1', 'operario_inactivo', { actionType: 'execute', actionMode: 'confirmar' }, 'ana');
    await facade.runAgentSweep('op1');
    al = (await facade.agentAlerts('op1')).abiertas.find((a) => a.ruleKey === 'operario_inactivo')!;
    assert.equal(al.actionStatus, 'proposed', 'en confirmar, queda propuesta');
    assert.equal((await facade.getOperatorTasks('op1', 'pedro')).length, 1, 'pedro AÚN tiene su tarea (no se ejecutó sola)');
    const r = await facade.executeAgentAlertAction('op1', al.id, 'ana');
    assert.equal(r.ok, true);
    assert.equal((await facade.getOperatorTasks('op1', 'carla')).length, 1, 'tras confirmar, carla recibió la tarea');
    const al2 = await (facade as any).agentAlertRepo.get(al.id);
    assert.equal(al2.actionStatus, 'done');
  });

  await test('asignaciones por operario: actividades pendientes vs. en ejecución', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    const pedro = await facade.createUser({ id: 'pedro', name: 'Pedro', email: 'p@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const order = await facade.createOrder('acme', { externalOrderId: 'PED-1', salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 4 }] }, 'ana');
    await facade.allocateOrder('acme', order.id, 'ana');
    await facade.assignTask('op1', { type: 'PICK', entityId: order.id, entityRef: 'PED-1', sellerId: 'acme', operator: pedro.id, unitsEstimate: 4, by: 'ana' });

    // Recién asignada → pendiente.
    let act = await facade.operatorActivities('op1', 'pedro');
    assert.equal(act.tareas.length, 1);
    assert.equal(act.pendientes, 1); assert.equal(act.enEjecucion, 0);
    assert.equal(act.tareas[0].estado, 'assigned');

    // Al iniciar el picking, la tarea pasa a "en ejecución".
    await facade.startPicking('acme', order.id, 'pedro');
    act = await facade.operatorActivities('op1', 'pedro');
    assert.equal(act.enEjecucion, 1); assert.equal(act.pendientes, 0);
    assert.equal(act.tareas[0].estado, 'in_progress');

    // Otro operario sin carga → sin actividades.
    await facade.createUser({ id: 'carla', name: 'Carla', email: 'c@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const vacía = await facade.operatorActivities('op1', 'carla');
    assert.equal(vacía.tareas.length, 0);
  });

  await test('copiloto: TODA feature es contexto — cada tool despacha sin error', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await f.facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 20, locationId: recv.id });
    // Cada herramienta de LECTURA del copiloto debe responder (sin lanzar ni devolver {error}).
    for (const tool of COPILOT_TOOLS) {
      const res = await f.facade.runCopilotTool(tool.name, { sellerId: 'acme', sku: 'CAM' }, 'op1', null);
      assert.ok(res && typeof res === 'object', `${tool.name} devuelve un objeto`);
      assert.ok(!('error' in res), `${tool.name} no devuelve error: ${JSON.stringify((res as any).error)}`);
    }
  });

  await test('copiloto: contexto_operativo consolida todos los módulos', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const ctx: any = await f.facade.runCopilotTool('contexto_operativo', {}, 'op1', null);
    for (const k of ['ejecutivo', 'exactitudInventario', 'productividad', 'carga', 'clasificacionABC', 'auditoriaIA']) {
      assert.ok(k in ctx, `contexto_operativo incluye ${k}`);
    }
  });

  await test('grounding del LLM incluye las secciones de TODOS los módulos', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await f.facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 30, locationId: recv.id });
    // Genera actividad de conteo para que la exactitud aparezca.
    const { context } = await f.facade.copilotContextPreview('op1', null);
    assert.ok(/UBICACIONES/.test(context), 'incluye ubicaciones');
    assert.ok(/CLASIFICACIÓN ABC/.test(context), 'incluye ABC');
    assert.ok(/CLIENTE: ACME/.test(context), 'incluye al cliente');
    // Las secciones de módulos nuevos se agregan cuando hay datos; el grounding no rompe sin ellos.
    assert.ok(context.length > 50);
  });

  await test('copiloto acciones: confirma transición, valida permiso y estado', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 10, locationId: stg.id });
    const order = await facade.createOrder('acme', {
      externalOrderId: 'SHOP-A', salesChannel: 'web', shipTo: { name: 'Ana', line1: 'Calle 1', city: 'Santiago', region: 'RM', country: 'CL' } as any,
      lines: [{ sku: 'CAM', qty: 2 }],
    });

    // Sin permiso de escritura (rol CLIENT) → rechazado.
    const denied = await facade.copilotConfirmAction('op1', null, { id: 'u1', role: 'CLIENT' }, { orden: 'SHOP-A', accion: 'reservar' });
    assert.equal(denied.ok, false);
    assert.ok(denied.error);

    // Transición inválida (despachar una orden RECEIVED) → error legible, sin cambio.
    const bad = await facade.copilotConfirmAction('op1', null, { id: 'u1', role: 'ADMIN' }, { orden: 'SHOP-A', accion: 'despachar' });
    assert.equal(bad.ok, false);
    assert.ok(/PACKED|despachar/i.test(bad.error || ''));

    // Orden inexistente → error.
    const missing = await facade.copilotConfirmAction('op1', null, { id: 'u1', role: 'ADMIN' }, { orden: 'NO-EXISTE', accion: 'reservar' });
    assert.equal(missing.ok, false);

    // Acción válida por un ADMIN → ejecuta y avanza el estado real.
    const ok = await facade.copilotConfirmAction('op1', null, { id: 'u1', role: 'ADMIN' }, { orden: 'SHOP-A', accion: 'reservar' });
    assert.equal(ok.ok, true);
    assert.equal(ok.nuevoEstado, 'ALLOCATED');
    const reloaded = await facade.getOrder('acme', order.id);
    assert.equal(reloaded?.status, 'ALLOCATED');
  });

  await test('copiloto acciones: modo por operación por defecto es confirm', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    const mode = await facade.getCopilotActionMode('op1');
    assert.equal(mode, 'confirm');
  });

  await test('actividad por usuario: productividad y feed cruzan órdenes + inventario', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createUser({ id: 'pedro', name: 'Pedro', email: 'pedro@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    await facade.createUser({ id: 'carla', name: 'Carla', email: 'carla@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const recv = await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });

    // Pedro recepciona y guarda; Carla toma la orden completa.
    await facade.receive('acme', { sku: 'CAM', qty: 10, locationId: recv.id, actor: 'pedro' });
    await facade.putaway('acme', { sku: 'CAM', qty: 10, fromLocationId: recv.id, toLocationId: stg.id, actor: 'pedro' });
    const order = await facade.createOrder('acme', {
      externalOrderId: 'SO-1', salesChannel: 'web', shipTo: { name: 'Ana', line1: 'C 1', city: 'Stgo', region: 'RM', country: 'CL' } as any,
      lines: [{ sku: 'CAM', qty: 3 }],
    }, 'carla');
    await facade.allocateOrder('acme', order.id, 'carla');
    await facade.confirmPick('acme', order.id, 'carla');
    await facade.packOrder('acme', order.id, { bultos: 1, materials: [] }, 'carla');

    const act = await facade.userActivity('op1');
    // Roster expone a los operadores para el filtro.
    assert.ok(act.users.some((u) => u.id === 'pedro') && act.users.some((u) => u.id === 'carla'));

    const pedro = act.productivity.find((p) => p.userId === 'pedro');
    const carla = act.productivity.find((p) => p.userId === 'carla');
    assert.ok(pedro && carla, 'ambos operadores tienen productividad');
    // Pedro: 1 recepción (10 un) + 1 guardado (10 un). El putaway (2 patas) se colapsa a 1.
    assert.equal(pedro!.receipts, 1);
    assert.equal(pedro!.receiptUnits, 10);
    assert.equal(pedro!.putaways, 1);
    assert.equal(pedro!.putawayUnits, 10);
    // Carla: reservó, pickeó y empacó 1 orden.
    assert.equal(carla!.allocated, 1);
    assert.equal(carla!.picked, 1);
    assert.equal(carla!.packed, 1);
    assert.equal(carla!.shipped, 0);

    // El feed está ordenado del más nuevo al más viejo y nombra al actor.
    assert.ok(act.feed.length >= 5);
    for (let i = 1; i < act.feed.length; i++) {
      assert.ok(Date.parse(act.feed[i - 1].at) >= Date.parse(act.feed[i].at));
    }
    assert.ok(act.feed.some((f) => f.actorName === 'Pedro' && f.label === 'Guardó en ubicación'));
    assert.ok(act.feed.some((f) => f.actorName === 'Carla' && f.label === 'Empacó'));

    // Filtro por usuario: solo eventos de Carla.
    const soloCarla = await facade.userActivity('op1', { userId: 'carla' });
    assert.ok(soloCarla.feed.every((f) => f.actor === 'carla'));
    assert.equal(soloCarla.productivity.length, 1);
    assert.equal(soloCarla.productivity[0].userId, 'carla');
  });

  await test('actividad por usuario: la ventana de fecha acota el feed', async () => {
    const { facade, clock } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createUser({ id: 'pedro', name: 'Pedro', email: 'pedro@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const recv = await facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });

    clock.set('2026-01-01T10:00:00.000Z');
    await facade.receive('acme', { sku: 'CAM', qty: 5, locationId: recv.id, actor: 'pedro' });
    clock.set('2026-02-01T10:00:00.000Z');
    await facade.receive('acme', { sku: 'CAM', qty: 7, locationId: recv.id, actor: 'pedro' });

    const janOnly = await facade.userActivity('op1', { from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-01-15T00:00:00Z') });
    assert.equal(janOnly.feed.length, 1);
    assert.equal(janOnly.feed[0].detail?.includes('+5 un'), true);
  });

  await test('self-serve: registro de marca provisiona operación + admin + seller', async () => {
    const { facade } = buildFacade();
    const res = await facade.registerSelfServe({ companyName: 'Tienda Aurora', name: 'Camila', email: 'camila@aurora.cl', password: 'secreto123', track: 'brand' });
    assert.ok(res.token && res.token.length > 20, 'auto-login: devuelve JWT');
    assert.equal(res.user.role, 'ADMIN');
    assert.equal(res.user.emailVerified, false, 'el email nace sin verificar');
    assert.ok(res.operationId);
    assert.ok(res.sellerId, 'marca -> seller por defecto');
    // La operación quedó marcada como self-serve con su pista.
    const op = await facade.getOperation(res.operationId);
    assert.equal(op?.track, 'brand');
    assert.equal(op?.selfServe, true);
    // El seller por defecto existe en la operación.
    const sellers = await facade.listSellers(res.operationId);
    assert.equal(sellers.length, 1);
    assert.equal(sellers[0].name, 'Tienda Aurora');
    // Puede loguear de inmediato con su clave.
    const login = await facade.loginWithPassword('camila@aurora.cl', 'secreto123');
    assert.equal(login.authenticated, true);
  });

  await test('self-serve: registro de operador 3PL no crea sellers', async () => {
    const { facade } = buildFacade();
    const res = await facade.registerSelfServe({ companyName: 'Bodega Halcón', name: 'Iván', email: 'ivan@halcon.cl', password: 'clave12345', track: 'operator' });
    assert.equal(res.sellerId, null, 'operador 3PL invita clientes luego');
    const op = await facade.getOperation(res.operationId);
    assert.equal(op?.track, 'operator');
    const sellers = await facade.listSellers(res.operationId);
    assert.equal(sellers.length, 0);
  });

  await test('self-serve: email duplicado se rechaza con mensaje claro', async () => {
    const { facade } = buildFacade();
    await facade.registerSelfServe({ companyName: 'Uno', name: 'A', email: 'dup@x.cl', password: 'clave12345', track: 'brand' });
    await expectThrows(
      () => facade.registerSelfServe({ companyName: 'Dos', name: 'B', email: 'DUP@x.cl', password: 'clave12345', track: 'brand' }),
      ValidationError,
    );
  });

  await test('self-serve: verificación de email por token de un solo uso', async () => {
    const { facade } = buildFacade();
    const res = await facade.registerSelfServe({ companyName: 'Verif Co', name: 'Vera', email: 'vera@verif.cl', password: 'clave12345', track: 'brand' });
    const token = res.verification.devToken!;
    assert.ok(token, 'en dev, el token viaja en la respuesta');
    // Token inválido -> error legible.
    const bad = await facade.verifyEmail('no-existe');
    assert.equal(bad.ok, false);
    // Token válido -> verifica.
    const ok = await facade.verifyEmail(token);
    assert.equal(ok.ok, true);
    const user = await facade.getUser(res.user.id);
    assert.equal(user?.emailVerified, true);
    // Reuso del mismo token -> rechazado.
    const again = await facade.verifyEmail(token);
    assert.equal(again.ok, false);
  });

  await test('self-serve: reset de contraseña por token', async () => {
    const { facade } = buildFacade();
    await facade.registerSelfServe({ companyName: 'Reset Co', name: 'Rita', email: 'rita@reset.cl', password: 'viejaClave1', track: 'brand' });
    const req = await facade.requestPasswordReset('rita@reset.cl');
    assert.equal(req.ok, true);
    const token = req.devToken!;
    assert.ok(token);
    // Clave muy corta -> rechazada sin quemar el token.
    const short = await facade.resetPassword(token, '123');
    assert.equal(short.ok, false);
    // Reset válido.
    const done = await facade.resetPassword(token, 'nuevaClave9');
    assert.equal(done.ok, true);
    // La clave nueva funciona y la vieja no.
    assert.equal((await facade.loginWithPassword('rita@reset.cl', 'nuevaClave9')).authenticated, true);
    assert.equal((await facade.loginWithPassword('rita@reset.cl', 'viejaClave1')).authenticated, false);
    // Email inexistente -> respuesta genérica ok (no filtra).
    assert.equal((await facade.requestPasswordReset('fantasma@x.cl')).ok, true);
  });

  await test('planes: cuenta self-serve parte en trial de Growth', async () => {
    const { facade } = buildFacade();
    const res = await facade.registerSelfServe({ companyName: 'Marca PLG', name: 'Pía', email: 'pia@plg.cl', password: 'clave12345', track: 'brand' });
    const st = await facade.getPlanState(res.operationId);
    assert.equal(st.plan.id, 'growth', 'durante la prueba el plan efectivo es Growth');
    assert.equal(st.basePlan.id, 'free', 'el plan base es Free');
    assert.equal(st.trial.active, true);
    assert.ok(st.trial.daysLeft >= 13 && st.trial.daysLeft <= 14);
    // Uso inicial: 1 seller (la marca), 1 usuario admin, 0 órdenes, 0 ubicaciones.
    assert.equal(st.usage.sellers.used, 1);
    assert.equal(st.usage.users.used, 1);
    assert.equal(st.usage.ordersPerMonth.used, 0);
    // Feature de Growth disponible durante la prueba.
    assert.equal(await facade.hasFeature(res.operationId, 'ai_copilot'), true);
  });

  await test('planes: al vencer la prueba cae a Free y se aplican los features', async () => {
    const { facade } = buildFacade();
    const res = await facade.registerSelfServe({ companyName: 'Marca Free', name: 'Leo', email: 'leo@free.cl', password: 'clave12345', track: 'brand' });
    // Forzar el vencimiento del trial (poner una fecha pasada).
    await facade.setOperationPlan(res.operationId, 'free'); // setPlan borra el trial -> plan efectivo = Free
    const st = await facade.getPlanState(res.operationId);
    assert.equal(st.plan.id, 'free');
    assert.equal(st.trial.active, false);
    // En Free el copiloto IA NO está incluido: conectar una clave se rechaza con PlanLimitError.
    assert.equal(await facade.hasFeature(res.operationId, 'ai_copilot'), false);
    await expectThrows(
      () => facade.setAiConfig(res.operationId, null, { provider: 'openai', apiKey: 'sk-xxxxxxxx', chatModel: 'gpt-4o-mini' }),
      PlanLimitError,
    );
  });

  await test('planes: enforcement de cuota de usuarios en Free', async () => {
    const { facade } = buildFacade();
    const res = await facade.registerSelfServe({ companyName: 'Cuota Co', name: 'Uno', email: 'uno@cuota.cl', password: 'clave12345', track: 'brand' });
    await facade.setOperationPlan(res.operationId, 'free'); // Free: máx 2 usuarios; ya hay 1 (admin)
    // El 2º usuario entra.
    await facade.createUser({ name: 'Dos', email: 'dos@cuota.cl', role: UserRole.OPERATOR, operationId: res.operationId, password: 'clave12345' });
    // El 3º excede el plan Free.
    await expectThrows(
      () => facade.createUser({ name: 'Tres', email: 'tres@cuota.cl', role: UserRole.OPERATOR, operationId: res.operationId, password: 'clave12345' }),
      PlanLimitError,
    );
  });

  await test('planes: operaciones sin plan (semilla/super-admin) no tienen límites', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Interna' });
    const st = await facade.getPlanState('op1');
    assert.equal(st.plan.id, 'internal');
    // Puede crear muchos sellers/usuarios sin toparse con límites.
    for (let i = 0; i < 5; i++) await facade.createSeller({ operationId: 'op1', name: 'S' + i });
    const sellers = await facade.listSellers('op1');
    assert.equal(sellers.length, 5);
  });

  await test('empaquetado: editar la config de un plan cambia los entitlements en vivo', async () => {
    const { facade } = buildFacade();
    // Matriz inicial: Free NO incluye copiloto IA.
    const m0 = await facade.getPackagingMatrix();
    const free0 = m0.plans.find((p: any) => p.id === 'free')!;
    assert.equal(free0.features.includes('ai_copilot'), false);
    // El super-admin asocia el módulo ai_copilot al plan Free y sube el límite de usuarios.
    await facade.updatePlanConfig('free', { features: ['ai_copilot'], limits: { users: 9 } });
    const m1 = await facade.getPackagingMatrix();
    const free1 = m1.plans.find((p: any) => p.id === 'free')!;
    assert.equal(free1.features.includes('ai_copilot'), true, 'ahora Free incluye copiloto');
    assert.equal(free1.features.includes('wms_core'), true, 'el núcleo va siempre incluido');
    assert.equal(free1.limits.users, 9, 'límite de usuarios actualizado');
    // Efecto en vivo: una cuenta en Free ahora puede conectar IA.
    const res = await facade.registerSelfServe({ companyName: 'Pkg Co', name: 'Pau', email: 'pau@pkg.cl', password: 'clave12345', track: 'brand' });
    await facade.setOperationPlan(res.operationId, 'free');
    assert.equal(await facade.hasFeature(res.operationId, 'ai_copilot'), true);
  });

  await test('empaquetado: tarifas por plan configurables en USD y CLP', async () => {
    const { facade } = buildFacade();
    // Defaults: Growth trae precio en ambas monedas.
    const m0 = await facade.getPackagingMatrix();
    const g0 = m0.plans.find((p: any) => p.id === 'growth')!;
    assert.equal(typeof g0.prices.usd, 'number');
    assert.equal(typeof g0.prices.clp, 'number');
    // El super-admin fija nuevas tarifas.
    await facade.updatePlanConfig('growth', { prices: { usd: 69, clp: 62000 } });
    const m1 = await facade.getPackagingMatrix();
    const g1 = m1.plans.find((p: any) => p.id === 'growth')!;
    assert.equal(g1.prices.usd, 69);
    assert.equal(g1.prices.clp, 62000);
    // Se refleja también en el catálogo público (comparador).
    const cat = await facade.planCatalog();
    assert.equal(cat.find((p: any) => p.id === 'growth')!.prices.clp, 62000);
    // Precio vacío/null = a medida (enterprise).
    await facade.updatePlanConfig('enterprise', { prices: { usd: null, clp: null } });
    const ent = (await facade.getPackagingMatrix()).plans.find((p: any) => p.id === 'enterprise')!;
    assert.equal(ent.prices.usd, null);
  });

  await test('empaquetado: restaurar defaults revierte los cambios', async () => {
    const { facade } = buildFacade();
    await facade.updatePlanConfig('free', { features: ['ai_copilot', 'webhooks'], name: 'Gratis' });
    await facade.resetPackaging();
    const m = await facade.getPackagingMatrix();
    const free = m.plans.find((p: any) => p.id === 'free')!;
    assert.equal(free.name, 'Free', 'volvió al nombre por defecto');
    assert.equal(free.features.includes('ai_copilot'), false, 'volvió a sin copiloto');
  });

  await test('empaquetado: no se puede editar el plan interno ni módulos inválidos', async () => {
    const { facade } = buildFacade();
    await expectThrows(() => facade.updatePlanConfig('internal', { name: 'x' }), ValidationError);
    // Módulos inexistentes se ignoran; el núcleo se conserva.
    const cfg = await facade.updatePlanConfig('growth', { features: ['ai_copilot', 'no_existe'] });
    assert.equal(cfg.features.includes('no_existe' as any), false);
    assert.equal(cfg.features.includes('wms_core'), true);
    assert.equal(cfg.features.includes('ai_copilot'), true);
  });

  await test('onboarding: cuenta nueva de marca arranca el checklist en cero', async () => {
    const { facade } = buildFacade();
    const res = await facade.registerSelfServe({ companyName: 'Marca Onb', name: 'Ona', email: 'ona@onb.cl', password: 'clave12345', track: 'brand' });
    const st = await facade.getOnboardingState(res.operationId);
    assert.equal(st.track, 'brand');
    assert.equal(st.activated, false);
    // Marca no tiene el paso "crear cliente" (ya tiene su seller por defecto).
    assert.equal(st.steps.some((s: any) => s.key === 'create_client'), false);
    // Aún no hay ubicación, producto, stock, orden ni despacho.
    const key = (k: string) => st.steps.find((s: any) => s.key === k);
    assert.equal(key('create_location')!.done, false);
    assert.equal(key('create_product')!.done, false);
    assert.equal(key('ship_order')!.done, false);
  });

  await test('onboarding: operador 3PL incluye el paso de crear cliente', async () => {
    const { facade } = buildFacade();
    const res = await facade.registerSelfServe({ companyName: 'Op Onb', name: 'Ivo', email: 'ivo@op.cl', password: 'clave12345', track: 'operator' });
    const st = await facade.getOnboardingState(res.operationId);
    assert.equal(st.track, 'operator');
    const cc = st.steps.find((s: any) => s.key === 'create_client');
    assert.ok(cc, 'incluye crear cliente');
    assert.equal(cc!.done, false, 'operador nace sin clientes');
  });

  await test('onboarding: datos de ejemplo pueblan y activan la cuenta', async () => {
    const { facade } = buildFacade();
    const res = await facade.registerSelfServe({ companyName: 'Sample Co', name: 'Sam', email: 'sam@sample.cl', password: 'clave12345', track: 'brand' });
    const r = await facade.loadSampleData(res.operationId);
    assert.equal(r.loaded, true);
    // Puebla productos, stock y órdenes; despacha al menos una => activada.
    const st = await facade.getOnboardingState(res.operationId);
    assert.equal(st.activated, true, 'con datos de ejemplo, la cuenta queda activada');
    const key = (k: string) => st.steps.find((s: any) => s.key === k)!.done;
    assert.equal(key('create_product'), true);
    assert.equal(key('receive_stock'), true);
    assert.equal(key('create_order'), true);
    assert.equal(key('ship_order'), true);
    // Idempotente: no vuelve a cargar si ya hay datos.
    const again = await facade.loadSampleData(res.operationId);
    assert.equal(again.loaded, false);
    assert.equal(again.reason, 'already');
  });

  await test('idempotencia (G1): reenviar el mismo payload N veces crea exactamente 1 orden', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    const payload = { externalOrderId: 'SHOP-777', salesChannel: 'shopify', shipTo: { name: 'Ana' } as any, lines: [{ sku: 'CAM', qty: 2 }] };
    const first = await facade.createOrder('acme', payload);
    // Reintentos del webhook: mismo externalOrderId.
    const r2 = await facade.createOrder('acme', payload);
    const r3 = await facade.createOrder('acme', payload);
    assert.equal(r2.id, first.id, 'el reintento devuelve la MISMA orden');
    assert.equal(r3.id, first.id);
    const all = await facade.listOrders('acme');
    assert.equal(all.filter((o) => o.externalOrderId === 'SHOP-777').length, 1, 'exactamente 1 orden');
  });

  await test('idempotencia (G1): auditar y consolidar duplicados históricos', async () => {
    const { facade, orders } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    const base = await facade.createOrder('acme', { externalOrderId: 'DUP-1', salesChannel: 'web', shipTo: { name: 'X' } as any, lines: [{ sku: 'CAM', qty: 1 }] });
    // Inyecta 2 copias históricas (mismo externalOrderId, distinto id, creadas después)
    // directo en el repo, como las habría dejado un retry en el sistema SIN idempotencia.
    await orders.save({ ...base, id: 'dupA', createdAt: '2026-01-02T00:00:00.000Z' } as any);
    await orders.save({ ...base, id: 'dupB', createdAt: '2026-01-03T00:00:00.000Z' } as any);
    assert.equal((await facade.listOrders('acme')).length, 3);
    // Auditoría detecta 1 grupo con 2 sobrantes.
    const audit = await facade.auditDuplicateOrders('op1');
    assert.equal(audit.groups.length, 1);
    assert.equal(audit.groups[0].count, 3);
    assert.equal(audit.totalDuplicates, 2);
    // Consolidación conserva la MÁS ANTIGUA (base) y elimina las 2 copias.
    const cons = await facade.consolidateDuplicateOrders('op1');
    assert.equal(cons.removed, 2);
    const left = await facade.listOrders('acme');
    assert.equal(left.length, 1);
    assert.equal(left[0].id, base.id, 'sobrevive la orden original');
    // Post-consolidación: 0 duplicados.
    assert.equal((await facade.auditDuplicateOrders('op1')).totalDuplicates, 0);
  });

  console.log('\nExactitud de inventario (G8): CountVariance + tendencia\n');

  await test('exactitud (G8): cada conteo persiste una auditoría con % de exactitud', async () => {
    const { facade, countAudits } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const loc = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.createSku('acme', { sku: 'PAN', description: 'Pantalón' });
    await facade.receive('acme', { sku: 'CAM', qty: 10, locationId: loc.id });
    await facade.receive('acme', { sku: 'PAN', qty: 10, locationId: loc.id });
    // 2 líneas contadas, 1 con varianza (CAM faltan 2) -> exactitud 50%
    await facade.performCount('acme', loc.id, [
      { sku: 'CAM', lot: null, countedQty: 8 },
      { sku: 'PAN', lot: null, countedQty: 10 },
    ]);
    const saved = await countAudits.list('op1', {});
    assert.equal(saved.length, 1, 'se persistió 1 auditoría de conteo');
    assert.equal(saved[0].linesCounted, 2);
    assert.equal(saved[0].linesAccurate, 1);
    assert.equal(saved[0].variances.length, 1);
    assert.equal(saved[0].accuracyPct, 0.5);
  });

  await test('exactitud (G8): KPI agrega varios conteos y expone tendencia', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const loc = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 10, locationId: loc.id });
    // Conteo 1: exacto (100%)
    await facade.performCount('acme', loc.id, [{ sku: 'CAM', lot: null, countedQty: 10 }]);
    // Conteo 2: con varianza (0%)
    await facade.performCount('acme', loc.id, [{ sku: 'CAM', lot: null, countedQty: 7 }]);
    const kpi = await facade.getInventoryAccuracy('op1', {});
    assert.equal(kpi.countsConsidered, 2);
    assert.equal(kpi.linesCounted, 2);
    assert.equal(kpi.linesAccurate, 1);
    assert.equal(kpi.accuracyPct, 0.5, 'exactitud global = 1 línea exacta / 2 contadas');
    assert.equal(kpi.trend.length, 2);
    // Tendencia ordenada del más viejo al más nuevo.
    assert.ok(kpi.trend[0].at <= kpi.trend[1].at);
  });

  await test('exactitud (G8): sin conteos, el KPI es nulo pero no rompe', async () => {
    const { facade } = buildFacade();
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    const kpi = await facade.getInventoryAccuracy('op1', {});
    assert.equal(kpi.accuracyPct, null);
    assert.equal(kpi.countsConsidered, 0);
    assert.equal(kpi.trend.length, 0);
  });

  console.log('\nEvent store consultable (G2+G6): DomainEvent + tiempos entre estados\n');

  async function seedOrderFlow(facade: WmsFacade, clock: FixedClock) {
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const loc = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await facade.receive('acme', { sku: 'CAM', qty: 20, locationId: loc.id });
    clock.set('2026-02-01T00:00:00.000Z');
    const order = await facade.createOrder('acme', { externalOrderId: 'EV-1', salesChannel: 'web', shipTo: { name: 'Ana' } as any, lines: [{ sku: 'CAM', qty: 5 }] });
    clock.set('2026-02-01T02:00:00.000Z'); // +2h
    await facade.allocateOrder('acme', order.id);
    return order;
  }

  await test('event store (G2): cada transición aparece en la tabla en tiempo real', async () => {
    const { facade, clock, events } = buildFacade();
    const order = await seedOrderFlow(facade, clock);
    const rows = await events.listByEntity(order.id);
    assert.equal(rows.length, 2, 'CREATED + ALLOCATED promovidos a la tabla');
    assert.deepEqual(rows.map((r) => r.type), ['CREATED', 'ALLOCATED'], 'ordenados por seq');
    assert.deepEqual(rows.map((r) => r.seq), [0, 1]);
    assert.equal(rows[0].entityType, 'ORDER');
    assert.equal(rows[0].entityRef, 'EV-1');
    assert.equal(rows[0].sellerId, 'acme');
  });

  await test('event store (G2): línea de tiempo con horas entre estados (query indexada)', async () => {
    const { facade, clock } = buildFacade();
    await seedOrderFlow(facade, clock);
    const tl = await facade.getOrderTimeline('acme', 'EV-1');
    assert.ok(tl, 'la orden tiene línea de tiempo');
    assert.equal(tl.lineaTiempo.length, 2);
    assert.equal(tl.lineaTiempo[0].hrsDesdeAnterior, 0);
    assert.equal(tl.lineaTiempo[1].hrsDesdeAnterior, 2, '2 h entre CREATED y ALLOCATED');
    assert.equal(tl.horasTotales, 2);
  });

  await test('event store (G2): append es idempotente — no duplica al re-guardar', async () => {
    const { facade, clock, events } = buildFacade();
    const order = await seedOrderFlow(facade, clock);
    // Reintento del webhook (mismo externalOrderId): idempotente, no agrega eventos.
    await facade.createOrder('acme', { externalOrderId: 'EV-1', salesChannel: 'web', shipTo: { name: 'Ana' } as any, lines: [{ sku: 'CAM', qty: 5 }] });
    const rows = await events.listByEntity(order.id);
    assert.equal(rows.length, 2, 'sigue habiendo exactamente 2 eventos');
    assert.equal(await events.count(), 2);
  });

  await test('event store (G2): paridad métricas viejas (JSON) vs nuevas (tabla)', async () => {
    const { facade, clock } = buildFacade();
    await seedOrderFlow(facade, clock);
    const p = await facade.verifyEventParity('op1');
    assert.equal(p.ok, true, 'las transiciones coinciden entre JSON y tabla');
    assert.equal(p.ordersJson, p.ordersTable);
    assert.ok(p.transitionsChecked >= 1, 'al menos una transición verificada');
    assert.equal(p.mismatches.length, 0);
  });

  await test('event store (G2): tiempos de preparación por transición desde la tabla', async () => {
    const { facade, clock } = buildFacade();
    await seedOrderFlow(facade, clock);
    // El copiloto expone tiempos_preparacion; verificamos vía la herramienta.
    const res = await facade.runCopilotTool('tiempos_preparacion', { sellerId: 'acme' }, 'op1', null);
    assert.ok(res.transiciones, 'devuelve transiciones');
    assert.ok(res.transiciones['CREATED→ALLOCATED'], 'la transición CREATED→ALLOCATED está medida');
    assert.equal(res.transiciones['CREATED→ALLOCATED'].promedioHrs, 2);
  });

  await test('event store (G2): backfill promueve historiales existentes (idempotente)', async () => {
    const { facade, clock, events } = buildFacade();
    await seedOrderFlow(facade, clock);
    const before = await events.count();
    const r1 = await facade.backfillEvents('op1');
    const r2 = await facade.backfillEvents('op1'); // idempotente
    assert.equal(await events.count(), before, 'el backfill no crea filas nuevas (ya estaban)');
    assert.ok(r1.events >= 2);
    assert.equal(r1.events, r2.events, 'backfill idempotente');
  });

  console.log('\nRollups diarios (G3): snapshots, demanda y métricas O(1)\n');

  function mkMov(over: Partial<any>): any {
    return {
      id: 'm-' + Math.random().toString(36).slice(2), sellerId: 'acme', sku: 'CAM', locationId: 'L1', lot: null,
      state: StockState.AVAILABLE, type: MovementType.SHIP, qtyDelta: -1, uom: Uom.EACH, reference: null,
      groupId: null, actor: 'system', occurredAt: '2026-03-01T10:00:00.000Z', ...over,
    };
  }

  async function seedLedger(f: ReturnType<typeof buildFacade>) {
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.createSku('acme', { sku: 'PAN', description: 'Pantalón' });
    // Día 1 (2026-03-01): recepción 20 CAM, pick 5 CAM (pedro), ship 5 CAM (orden O1)
    await f.movements.append([
      mkMov({ type: MovementType.RECEIPT, qtyDelta: 20, occurredAt: '2026-03-01T08:00:00.000Z', actor: 'pedro' }),
      mkMov({ type: MovementType.PICK, qtyDelta: -5, occurredAt: '2026-03-01T09:00:00.000Z', actor: 'pedro', reference: 'O1' }),
      mkMov({ type: MovementType.SHIP, qtyDelta: -5, occurredAt: '2026-03-01T10:00:00.000Z', actor: 'pedro', reference: 'O1' }),
    ]);
    // Día 2 (2026-03-02): pick 3 PAN (carla) + ship 3 PAN (orden O2)
    await f.movements.append([
      mkMov({ sku: 'PAN', type: MovementType.RECEIPT, qtyDelta: 10, occurredAt: '2026-03-02T08:00:00.000Z', actor: 'carla' }),
      mkMov({ sku: 'PAN', type: MovementType.PICK, qtyDelta: -3, occurredAt: '2026-03-02T11:00:00.000Z', actor: 'carla', reference: 'O2' }),
      mkMov({ sku: 'PAN', type: MovementType.SHIP, qtyDelta: -3, occurredAt: '2026-03-02T12:00:00.000Z', actor: 'carla', reference: 'O2' }),
    ]);
  }

  // Flujo REAL de despacho (para demanda): el stock sale por PICK y el despacho queda
  // como evento SHIPPED; la demanda se toma de las líneas de la orden despachada.
  async function seedShipped(f: ReturnType<typeof buildFacade>) {
    const { facade, clock } = f;
    await facade.createOperation({ id: 'op1', name: 'Op 1' });
    await facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const loc = await facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 1 });
    await facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    clock.set('2026-03-01T07:00:00.000Z');
    await facade.receive('acme', { sku: 'CAM', qty: 20, locationId: loc.id });
    clock.set('2026-03-01T08:00:00.000Z');
    const o = await facade.createOrder('acme', { externalOrderId: 'O1', salesChannel: 'web', shipTo: { name: 'Ana' } as any, lines: [{ sku: 'CAM', qty: 5 }] });
    await facade.allocateOrder('acme', o.id);
    clock.set('2026-03-01T09:00:00.000Z');
    await facade.confirmPick('acme', o.id, 'pedro');
    await facade.packOrder('acme', o.id, { bultos: 1, materials: [] } as any, 'pedro');
    clock.set('2026-03-01T10:00:00.000Z');
    await facade.shipOrder('acme', o.id, { carrier: 'Chilexpress', trackingNumber: 'TRK1' } as any, 'pedro');
    return o;
  }

  await test('rollup (G3): demanda diaria por SKU (unidades despachadas + nº órdenes)', async () => {
    const f = buildFacade();
    await seedShipped(f);
    await f.rollupService.runRange('2026-03-01', '2026-03-01', 'op1');
    const dem = await f.facade.getDemandSeries('acme');
    const cam = dem.find((d: any) => d.sku === 'CAM' && d.date === '2026-03-01');
    assert.ok(cam, 'hay demanda de CAM el 2026-03-01');
    assert.equal(cam.unitsShipped, 5, '5 unidades despachadas');
    assert.equal(cam.orders, 1, '1 orden');
  });

  await test('rollup (G3): snapshot de inventario on-hand por estado al cierre del día', async () => {
    const f = buildFacade();
    await seedLedger(f);
    await f.rollupService.runRange('2026-03-01', '2026-03-02', 'op1');
    const snaps = await f.facade.getInventorySnapshots('acme', { sku: 'CAM' });
    const d1 = snaps.find((s: any) => s.date === '2026-03-01');
    assert.ok(d1);
    // 20 recibidas - 5 pickeadas - 5 despachadas = 10 disponibles al cierre del día 1
    assert.equal(d1.available, 10);
    assert.equal(d1.total, 10);
  });

  await test('rollup (G3): reproducible — re-ejecutar el job da el mismo resultado', async () => {
    const f = buildFacade();
    await seedShipped(f);
    await f.rollupService.runRange('2026-03-01', '2026-03-01', 'op1');
    const c1 = await f.rollups.countAll();
    const dem1 = await f.facade.getDemandSeries('acme');
    await f.rollupService.runRange('2026-03-01', '2026-03-01', 'op1'); // re-run
    const c2 = await f.rollups.countAll();
    const dem2 = await f.facade.getDemandSeries('acme');
    assert.deepEqual(c1, c2, 'no crecen las filas al re-ejecutar');
    assert.deepEqual(dem1, dem2, 'misma serie de demanda');
    assert.ok(dem1.length >= 1, 'hay demanda materializada');
  });

  await test('rollup (G3): MetricsService lee de los rollups (sin full-scan)', async () => {
    const f = buildFacade();
    await seedLedger(f);
    await f.rollupService.runRange('2026-03-01', '2026-03-02', 'op1');
    // Reloj justo después del día 2 → ventana de 90d cubre ambos días.
    f.clock.set('2026-03-03T00:00:00.000Z');
    const m = await f.metricsService.forSeller('acme');
    const w90 = m.windows.find((w: any) => w.window === '90d');
    assert.ok(w90);
    assert.equal(w90.unitsPrepared.current, 8, 'PICK: 5 + 3');
    assert.equal(w90.unitsReceived.current, 30, 'RECEIPT: 20 + 10');
    assert.equal(w90.movements.current, 6, '6 movimientos en la ventana');
  });

  console.log('\nProductividad de mano de obra (G4): LaborTask\n');

  await test('labor (G4): derivación desde el ledger (PICK) es idempotente', async () => {
    const f = buildFacade();
    await seedLedger(f);
    const r1 = await f.facade.deriveLaborFromLedger('op1');
    const r2 = await f.facade.deriveLaborFromLedger('op1');
    assert.equal(r1.derived, 2, '2 movimientos PICK → 2 tareas');
    assert.equal(await f.laborTasks.count(), 2, 're-derivar no duplica');
    assert.equal(r2.derived, 2);
  });

  await test('labor (G4): productividad por operador y por tipo de tarea', async () => {
    const f = buildFacade();
    await seedLedger(f);
    await f.facade.deriveLaborFromLedger('op1');
    // Tarea capturada con inicio/fin reales: 12 unidades en 1 hora → 12 u/h.
    await f.facade.captureLaborTask({ operationId: 'op1', sellerId: 'acme', operator: 'pedro', type: 'PACK', startAt: '2026-03-01T13:00:00.000Z', endAt: '2026-03-01T14:00:00.000Z', units: 12 });
    const prod = await f.facade.laborProductivity('op1');
    const pedro = prod.operators.find((o: any) => o.operator === 'pedro');
    assert.ok(pedro, 'pedro aparece en el reporte');
    const pack = pedro.byType.find((t: any) => t.type === 'PACK');
    assert.ok(pack);
    assert.equal(pack.unitsPerHour, 12, '12 u en 1 h');
    assert.ok(pedro.byType.some((t: any) => t.type === 'PICK'), 'incluye PICK derivado del ledger');
  });

  await test('labor (G4): serie diaria lista como input del forecast de personal', async () => {
    const f = buildFacade();
    await seedLedger(f);
    await f.facade.deriveLaborFromLedger('op1');
    const series = await f.facade.laborSeries('op1');
    assert.ok(series.length >= 2, 'al menos 2 filas (día×operador)');
    const row = series.find((s: any) => s.operator === 'pedro' && s.date === '2026-03-01');
    assert.ok(row);
    assert.equal(row.units, 5, 'pedro pickeó 5 el día 1');
  });

  console.log('\nGeometría de ubicaciones + velocidad computada (G7)\n');

  await test('geometría (G7): el advisor puntúa por distancia real, no sólo pickRank', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    // Punto de despacho en (0,0).
    await f.facade.createLocation({ operationId: 'op1', code: 'SHIP-01', zoneType: ZoneType.SHIPPING, x: 0, y: 0 });
    // NEAR: cerca del despacho pero pickRank ALTO (malo por la regla vieja).
    await f.facade.createLocation({ operationId: 'op1', code: 'NEAR', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 9, x: 1, y: 0 });
    // FAR: lejos del despacho pero pickRank BAJO (bueno por la regla vieja).
    await f.facade.createLocation({ operationId: 'op1', code: 'FAR', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 1, x: 20, y: 0 });
    await f.facade.createSku('acme', { sku: 'HOT', description: 'Rápido', rotationClass: RotationClass.A } as any);
    const sugg = await f.facade.suggestPutaway('acme', { sku: 'HOT', qty: 5 });
    assert.equal(sugg[0].locationCode, 'NEAR', 'para clase A gana la ubicación cercana al despacho por distancia real');
    assert.ok(sugg[0].reasons.some((r: string) => /distancia/i.test(r)), 'la razón menciona la distancia real');
  });

  await test('ABC (G7): la clase se recalcula sola desde la velocidad del ledger', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createSku('acme', { sku: 'HOT', description: 'A', rotationClass: RotationClass.C } as any);
    await f.facade.createSku('acme', { sku: 'COLD', description: 'C', rotationClass: RotationClass.A } as any);
    // HOT rota mucho; COLD nada.
    await f.movements.append([
      mkMov({ sku: 'HOT', type: MovementType.PICK, qtyDelta: -900, occurredAt: '2026-03-01T09:00:00.000Z', actor: 'pedro' }),
    ]);
    f.clock.set('2026-03-02T00:00:00.000Z');
    const res = await f.facade.recomputeAbc('op1');
    assert.ok(res.updated >= 1);
    const hot = await f.skus.find('acme', 'HOT');
    const cold = await f.skus.find('acme', 'COLD');
    assert.equal(hot!.rotationClass, RotationClass.A, 'HOT sube a A por rotación observada');
    assert.equal(cold!.rotationClass, RotationClass.C, 'COLD baja a C (sin rotación)');
  });

  console.log('\nPersistencia + auditoría de IA (G5)\n');

  await test('IA audit (G5): suggestPutaway registra una recomendación', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.suggestPutaway('acme', { sku: 'CAM', qty: 3 });
    const recs = await f.facade.listAiRecommendations('op1', { type: 'putaway' });
    assert.equal(recs.length, 1, 'quedó registrada la recomendación de guardado');
    assert.equal(recs[0].taken, null, 'aún no se sabe si se siguió');
  });

  await test('IA audit (G5): recomputeAbc deja una acción de agente auditable', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.recomputeAbc('op1');
    const acts = await f.facade.listAgentActions('op1', { agent: 'abc_job' });
    assert.equal(acts.length, 1);
    assert.ok(acts[0].result.startsWith('ok'));
  });

  await test('IA audit (G5): resumen mide % de sugerencias aceptadas', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    // Tres recomendaciones: 2 aceptadas, 1 rechazada → 66.7%.
    await f.aiAudit.saveRecommendation({ id: 'r1', operationId: 'op1', sellerId: 'acme', type: 'putaway', input: '{}', output: '{}', score: null, taken: true, outcome: 'ok', actor: 'x', at: '2026-03-01T00:00:00.000Z' });
    await f.aiAudit.saveRecommendation({ id: 'r2', operationId: 'op1', sellerId: 'acme', type: 'putaway', input: '{}', output: '{}', score: null, taken: true, outcome: 'ok', actor: 'x', at: '2026-03-01T00:00:00.000Z' });
    await f.aiAudit.saveRecommendation({ id: 'r3', operationId: 'op1', sellerId: 'acme', type: 'putaway', input: '{}', output: '{}', score: null, taken: false, outcome: 'otra', actor: 'x', at: '2026-03-01T00:00:00.000Z' });
    const s = await f.facade.aiAuditSummary('op1');
    assert.equal(s.recommendations.total, 3);
    assert.equal(s.recommendations.accepted, 2);
    assert.equal(s.recommendations.acceptanceRate, 66.7);
  });

  console.log('\nActionables del copiloto (valor operativo/gerencial)\n');

  await test('actionable: riesgo de quiebre por días de cobertura', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createSku('acme', { sku: 'HOT', description: 'Rápido' });
    await f.facade.createSku('acme', { sku: 'COLD', description: 'Lento' });
    f.clock.set('2026-01-01T00:00:00.000Z');
    // HOT: 30 disponibles, demanda 300 en 30 días (avg 10/día) → cobertura 3 días → en riesgo.
    // COLD: 1000 disponibles, demanda 30 (avg 1/día) → cobertura 1000 → sin riesgo.
    await f.movements.append([
      mkMov({ sku: 'HOT', type: MovementType.RECEIPT, qtyDelta: 30, state: StockState.AVAILABLE, occurredAt: '2025-12-05T08:00:00.000Z' }),
      mkMov({ sku: 'HOT', type: MovementType.PICK, qtyDelta: -100, state: StockState.RESERVED, occurredAt: '2025-12-15T08:00:00.000Z' }),
      mkMov({ sku: 'HOT', type: MovementType.PICK, qtyDelta: -100, state: StockState.RESERVED, occurredAt: '2025-12-20T08:00:00.000Z' }),
      mkMov({ sku: 'HOT', type: MovementType.PICK, qtyDelta: -100, state: StockState.RESERVED, occurredAt: '2025-12-25T08:00:00.000Z' }),
      mkMov({ sku: 'COLD', type: MovementType.RECEIPT, qtyDelta: 1000, state: StockState.AVAILABLE, occurredAt: '2025-12-05T08:00:00.000Z' }),
      mkMov({ sku: 'COLD', type: MovementType.PICK, qtyDelta: -30, state: StockState.RESERVED, occurredAt: '2025-12-20T08:00:00.000Z' }),
    ]);
    const risk = await f.facade.getStockoutRisk('op1', {});
    const hot = risk.items.find((i: any) => i.sku === 'HOT');
    assert.ok(hot, 'HOT aparece en riesgo');
    assert.equal(hot.disponible, 30);
    assert.equal(hot.diasCobertura, 3);
    assert.equal(hot.reposicionSugerida, 270, 'reponer para 30 días: 10×30 − 30');
    assert.ok(!risk.items.find((i: any) => i.sku === 'COLD'), 'COLD no está en riesgo');
  });

  await test('actionable: órdenes en riesgo / atascadas', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const loc = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    f.clock.set('2026-02-01T08:00:00.000Z');
    await f.facade.receive('acme', { sku: 'CAM', qty: 50, locationId: loc.id });
    const o = await f.facade.createOrder('acme', { externalOrderId: 'STUCK-1', salesChannel: 'web', shipTo: { name: 'x' } as any, lines: [{ sku: 'CAM', qty: 5 }] });
    await f.facade.allocateOrder('acme', o.id, 'pedro'); // queda ALLOCATED
    // 48 h después sigue detenida.
    f.clock.set('2026-02-03T08:00:00.000Z');
    const risk = await f.facade.getOrdersAtRisk('op1', { maxHours: 24 });
    assert.equal(risk.enRiesgo, 1);
    assert.equal(risk.items[0].orden, 'STUCK-1');
    assert.equal(risk.items[0].estado, 'ALLOCATED');
    assert.ok(risk.items[0].horasDetenida >= 47 && risk.items[0].horasDetenida <= 49);
  });

  await test('actionable: brief ejecutivo entrega la estructura gerencial', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const brief = await f.facade.getExecutiveBrief('op1');
    assert.ok(brief.throughput && brief.throughput.ordenesPreparadas7d, 'incluye throughput');
    assert.ok('exactitudInventario' in brief);
    assert.ok(Array.isArray(brief.productividadTop));
    assert.ok(typeof brief.quiebresInminentes === 'number');
    assert.ok(typeof brief.ordenesEnRiesgo === 'number');
  });

  console.log('\nAsignación de tareas / balanceo de carga (Camino B)\n');

  async function seedPickPool(f: ReturnType<typeof buildFacade>, n: number): Promise<string[]> {
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const loc = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 5000, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 1000, locationId: loc.id });
    await f.facade.createUser({ id: 'opa', name: 'Op A', email: 'opa@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    await f.facade.createUser({ id: 'opb', name: 'Op B', email: 'opb@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const o = await f.facade.createOrder('acme', { externalOrderId: `A-${i}`, salesChannel: 'web', shipTo: { name: 'x' } as any, lines: [{ sku: 'CAM', qty: 5 }] });
      await f.facade.allocateOrder('acme', o.id); // → ALLOCATED (entra al pool de picking)
      ids.push(o.id);
    }
    return ids;
  }

  // ---- O4: falta de stock informada por orden, con todos los faltantes juntos ----

  await test('falta de stock: informa TODOS los productos que faltan, no solo el primero', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await f.facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 5000, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'GUA', description: 'Guantes negros M' });
    await f.facade.createSku('acme', { sku: 'BUF', description: 'Bufanda azul U' });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    // GUA: 40 un en RECEPCIÓN (no reservable). BUF: sin stock. CAM: 100 en almacenaje (alcanza).
    await f.facade.receive('acme', { sku: 'GUA', qty: 40, locationId: recv.id });
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    const o = await f.facade.createOrder('acme', {
      externalOrderId: 'WEB-FALTA-1', salesChannel: 'web', shipTo: { name: 'x' } as any,
      lines: [{ sku: 'GUA', qty: 25 }, { sku: 'BUF', qty: 6 }, { sku: 'CAM', qty: 10 }],
    });
    let err: any = null;
    try { await f.facade.allocateOrder('acme', o.id); } catch (e) { err = e; }
    assert.ok(err instanceof StockShortageError, 'lanza el error con detalle de faltantes');
    assert.equal(err.orden, 'WEB-FALTA-1', 'el detalle viene identificado por orden');
    assert.equal(err.faltantes.length, 2, 'informa los DOS productos que faltan de una vez');
    const gua: any = err.faltantes.find((x: any) => x.sku === "GUA")!;
    assert.equal(gua.requerido, 25);
    assert.equal(gua.reservable, 0, 'lo que está en recepción no es reservable');
    assert.equal(gua.falta, 25);
    assert.equal(gua.enRecepcion, 40, 'dice que el stock existe pero está sin guardar');
    assert.equal(gua.descripcion, 'Guantes negros M', 'incluye el nombre del producto');
    const buf: any = err.faltantes.find((x: any) => x.sku === "BUF")!;
    assert.equal(buf.enRecepcion, 0, 'este no tiene stock en ninguna parte');
    assert.ok(!err.faltantes.some((x: any) => x.sku === 'CAM'), 'el producto que sí alcanza no aparece');
    // La orden no cambió de estado ni se reservó nada.
    const sigue = await f.facade.getOrder('acme', o.id);
    assert.equal(sigue!.status, 'RECEIVED');
    const reservado = (await f.facade.getStock({ sellerId: 'acme' })).filter((b: any) => b.state === 'RESERVED').reduce((a: number, b: any) => a + b.qty, 0);
    assert.equal(reservado, 0, 'no se reservó nada: sigue siendo todo o nada');
  });

  await test('falta de stock: dice de qué recepciones viene lo que está sin guardar', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await f.facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 5000, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'GUA', description: 'Guantes negros M' });
    // DOS recepciones distintas del mismo producto, cotejadas en el dock.
    const r1 = await f.facade.createReceipt('acme', { supplier: 'Textiles Sur', reference: 'GD-4417', locationId: recv.id, lines: [{ sku: 'GUA', qty: 30 }] }, 'pamela');
    await f.facade.receiveReceipt('acme', r1.id, [{ lineNo: 1, qty: 30 }], 'pamela');
    f.clock.set('2026-09-15T12:00:00.000Z');
    const r2 = await f.facade.createReceipt('acme', { supplier: 'Importadora Norte', reference: 'GD-4490', locationId: recv.id, lines: [{ sku: 'GUA', qty: 10 }] }, 'pamela');
    await f.facade.receiveReceipt('acme', r2.id, [{ lineNo: 1, qty: 10 }], 'pamela');

    const o = await f.facade.createOrder('acme', {
      externalOrderId: 'WEB-FALTA-3', salesChannel: 'web', shipTo: { name: 'x' } as any,
      lines: [{ sku: 'GUA', qty: 60 }],
    });
    let err: any = null;
    try { await f.facade.allocateOrder('acme', o.id); } catch (e) { err = e; }
    assert.ok(err instanceof StockShortageError);
    const gua: any = err.faltantes[0];
    assert.equal(gua.enRecepcion, 40, '30 + 10 en el dock');
    assert.equal(gua.recepciones.length, 2, 'lista las DOS recepciones de origen');
    const porRef: any = {};
    gua.recepciones.forEach((r: any) => { porRef[r.referencia] = r; });
    assert.equal(porRef['GD-4417'].cantidad, 30, 'con la cantidad de cada una');
    assert.equal(porRef['GD-4490'].cantidad, 10);
    assert.equal(porRef['GD-4417'].proveedor, 'Textiles Sur', 'y su proveedor');
    assert.equal(gua.recepciones.reduce((t: number, r: any) => t + r.cantidad, 0), gua.enRecepcion, 'la suma cuadra con el saldo en recepción');

    // Al guardar parte de lo recibido, lo pendiente baja empezando por la más antigua.
    await f.facade.putaway('acme', { sku: 'GUA', qty: 30, fromLocationId: recv.id, toLocationId: stg.id, actor: 'opa' });
    let err2: any = null;
    try { await f.facade.allocateOrder('acme', o.id); } catch (e) { err2 = e; }
    const gua2: any = err2.faltantes[0];
    assert.equal(gua2.enRecepcion, 10, 'quedan 10 en el dock');
    assert.equal(gua2.recepciones.length, 1, 'ya solo queda pendiente una recepción');
    assert.equal(gua2.recepciones[0].referencia, 'GD-4490', 'la más antigua se dio por guardada primero');
    assert.equal(gua2.recepciones[0].cantidad, 10);
  });

  await test('falta de stock: un mismo producto en varias líneas se suma antes de comparar', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 5000, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 10, locationId: stg.id });
    const o = await f.facade.createOrder('acme', {
      externalOrderId: 'WEB-FALTA-2', salesChannel: 'web', shipTo: { name: 'x' } as any,
      lines: [{ sku: 'CAM', qty: 6 }, { sku: 'CAM', qty: 7 }],   // 13 en total, hay 10
    });
    let err: any = null;
    try { await f.facade.allocateOrder('acme', o.id); } catch (e) { err = e; }
    assert.ok(err instanceof StockShortageError);
    assert.equal(err.faltantes.length, 1, 'un solo producto en el detalle, no dos líneas');
    assert.equal(err.faltantes[0].requerido, 13, 'suma la demanda de las dos líneas');
    assert.equal(err.faltantes[0].falta, 3);
  });

  // ---- O3: editar una orden ya creada ---------------------------------------

  await test('edición: una orden RESERVADA se puede editar — libera, aplica y vuelve a reservar', async () => {
    const f = buildFacade();
    const [o0] = await seedPickPool(f, 1);   // CAM x5, ya ALLOCATED
    const disponibleAntes = (await f.facade.getStock({ sellerId: 'acme', sku: 'CAM' }))
      .filter((b: any) => b.state === 'AVAILABLE').reduce((s: number, b: any) => s + b.qty, 0);
    const o = await f.facade.getOrder('acme', o0);
    // Sube la cantidad de 5 a 12 con la orden ya reservada.
    const editada = await f.facade.updateOrder('acme', o0, {
      externalOrderId: o!.externalOrderId, salesChannel: 'web', shipTo: { name: 'x' } as any,
      lines: [{ sku: 'CAM', qty: 12 }],
    }, 'pamela');
    assert.equal(editada.status, 'ALLOCATED', 'vuelve a quedar reservada');
    assert.equal(editada.lines[0].qty, 12);
    const bal = await f.facade.getStock({ sellerId: 'acme', sku: 'CAM' });
    const reservado = bal.filter((b: any) => b.state === 'RESERVED').reduce((s: number, b: any) => s + b.qty, 0);
    const disponible = bal.filter((b: any) => b.state === 'AVAILABLE').reduce((s: number, b: any) => s + b.qty, 0);
    assert.equal(reservado, 12, 'la reserva quedó con la cantidad nueva');
    assert.equal(disponible, disponibleAntes - 7, 'el disponible bajó solo la diferencia');
    const ev = (editada.events || []).filter((e: any) => e.type === 'UPDATED').pop();
    assert.ok(String(ev?.detail || '').includes('reservas rehechas'), 'el evento deja constancia');
  });

  await test('edición: si el stock no alcanza, la orden queda EXACTAMENTE como estaba', async () => {
    const f = buildFacade();
    const [o0] = await seedPickPool(f, 1);   // hay 1000 un de CAM; la orden reserva 5
    const o = await f.facade.getOrder('acme', o0);
    await expectThrows(() => f.facade.updateOrder('acme', o0, {
      externalOrderId: o!.externalOrderId, salesChannel: 'web', shipTo: { name: 'x' } as any,
      lines: [{ sku: 'CAM', qty: 999999 }],
    }, 'pamela'), InsufficientStockError);
    const despues = await f.facade.getOrder('acme', o0);
    assert.equal(despues!.status, 'ALLOCATED', 'sigue reservada');
    assert.equal(despues!.lines[0].qty, 5, 'conserva las líneas anteriores');
    const reservado = (await f.facade.getStock({ sellerId: 'acme', sku: 'CAM' }))
      .filter((b: any) => b.state === 'RESERVED').reduce((s: number, b: any) => s + b.qty, 0);
    assert.equal(reservado, 5, 'la reserva original se restauró');
  });

  await test('edición: se pueden agregar y quitar productos de una orden reservada', async () => {
    const f = buildFacade();
    const [o0] = await seedPickPool(f, 1);
    const loc = (await f.facade.listLocations('op1'))[0];
    await f.facade.createSku('acme', { sku: 'PAN', description: 'Pantalón' });
    await f.facade.receive('acme', { sku: 'PAN', qty: 50, locationId: loc.id });
    const o = await f.facade.getOrder('acme', o0);
    const editada = await f.facade.updateOrder('acme', o0, {
      externalOrderId: o!.externalOrderId, salesChannel: 'web', shipTo: { name: 'x' } as any,
      lines: [{ sku: 'CAM', qty: 2 }, { sku: 'PAN', qty: 4 }],   // agrega un SKU nuevo
    }, 'pamela');
    assert.equal(editada.lines.length, 2);
    assert.equal(editada.status, 'ALLOCATED');
    const pan = (await f.facade.getStock({ sellerId: 'acme', sku: 'PAN' }))
      .filter((b: any) => b.state === 'RESERVED').reduce((s: number, b: any) => s + b.qty, 0);
    assert.equal(pan, 4, 'el producto agregado quedó reservado');
    // Ahora lo quita: su reserva debe liberarse.
    const sinPan = await f.facade.updateOrder('acme', o0, {
      externalOrderId: o!.externalOrderId, salesChannel: 'web', shipTo: { name: 'x' } as any,
      lines: [{ sku: 'CAM', qty: 2 }],
    }, 'pamela');
    assert.equal(sinPan.lines.length, 1);
    const pan2 = (await f.facade.getStock({ sellerId: 'acme', sku: 'PAN' }))
      .filter((b: any) => b.state === 'RESERVED').reduce((s: number, b: any) => s + b.qty, 0);
    assert.equal(pan2, 0, 'al quitar el producto se liberó su reserva');
  });

  await test('edición: bloqueada desde PICKING y el N° de orden nunca cambia', async () => {
    const f = buildFacade();
    const [o0] = await seedPickPool(f, 1);
    const o = await f.facade.getOrder('acme', o0);
    const body = { externalOrderId: o!.externalOrderId, salesChannel: 'web', shipTo: { name: 'x' } as any, lines: [{ sku: 'CAM', qty: 1 }] };
    // El N° de orden es la referencia del pedido: no se puede cambiar.
    await expectThrows(() => f.facade.updateOrder('acme', o0, { ...body, externalOrderId: 'OTRO-999' }, 'pamela'), ValidationError);
    // Desde que empieza el picking, ya no se edita.
    await f.facade.startPicking('acme', o0, 'opa');
    await expectThrows(() => f.facade.updateOrder('acme', o0, body, 'pamela'), ValidationError);
  });

  await test('asignación (B): asignar y auto-completar al pickear', async () => {
    const f = buildFacade();
    const [o0] = await seedPickPool(f, 1);
    await f.facade.assignTask('op1', { type: 'PICK', entityId: o0, entityRef: 'A-0', sellerId: 'acme', operator: 'opa', unitsEstimate: 5, by: 'sup' });
    let mine = await f.facade.getOperatorTasks('op1', 'opa');
    assert.equal(mine.length, 1, 'opa ve su tarea asignada');
    assert.equal(mine[0].status, 'assigned');
    await f.facade.confirmPick('acme', o0, 'opa'); // ejecuta la tarea
    mine = await f.facade.getOperatorTasks('op1', 'opa');
    assert.equal(mine.length, 0, 'la tarea se auto-completó al pickear');
  });

  await test('asignación (B): el picking dirigido (app) cierra la tarea en curso al completar la orden', async () => {
    const f = buildFacade();
    const [o0] = await seedPickPool(f, 2);
    await f.facade.assignTask('op1', { type: 'PICK', entityId: o0, entityRef: 'A-0', sellerId: 'acme', operator: 'opa', unitsEstimate: 5, by: 'sup' });
    await f.facade.startTask('op1', 'opa', { type: 'PICK', entityId: o0 });
    let mine = await f.facade.getOperatorTasks('op1', 'opa');
    assert.equal(mine[0].status, 'in_progress');
    const pl = await f.facade.getPickList('acme', o0);
    // Pick parcial por línea (como lo hace la app): la tarea sigue en curso.
    let o = await f.facade.pickTask('acme', o0, { sku: 'CAM', locationId: pl[0].locationId, qty: 2 }, 'opa');
    assert.equal(o.status, 'PICKING');
    mine = await f.facade.getOperatorTasks('op1', 'opa');
    assert.equal(mine.length, 1, 'con picking parcial la tarea sigue en la bandeja');
    // Completa la orden → PICKED → la tarea sale de la bandeja y el ledger abre PACK.
    o = await f.facade.pickTask('acme', o0, { sku: 'CAM', locationId: pl[0].locationId, qty: 3 }, 'opa');
    assert.equal(o.status, 'PICKED');
    mine = await f.facade.getOperatorTasks('op1', 'opa');
    assert.equal(mine.length, 0, 'la tarea PICK se cerró al terminar el picking dirigido');
    const packPool = await f.facade.getTaskPool('op1', 'PACK');
    assert.ok(packPool.some((t) => t.entityId === o0), 'la orden pasó al pool de empaque');
  });

  await test('asignación (B): cerrar recepción con faltante también cierra la tarea RECEIVE', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await f.facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.createUser({ id: 'opa', name: 'Op A', email: 'opa@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const r = await f.facade.createReceipt('acme', { supplier: 'Prov', reference: 'GD-2', locationId: recv.id, lines: [{ sku: 'CAM', qty: 100 }] }, 'system');
    await f.facade.assignTask('op1', { type: 'RECEIVE', entityId: r.id, entityRef: 'GD-2', sellerId: 'acme', operator: 'opa', unitsEstimate: 100, by: 'sup' });
    await f.facade.receiveReceipt('acme', r.id, [{ lineNo: 1, qty: 40 }], 'opa'); // parcial
    assert.equal((await f.facade.getOperatorTasks('op1', 'opa')).length, 1, 'parcial: la tarea sigue');
    await f.facade.closeReceipt('acme', r.id, 'opa');
    assert.equal((await f.facade.getOperatorTasks('op1', 'opa')).length, 0, 'cerrada con faltante: la tarea se completó');
  });

  await test('asignación (B): auto-balanceo reparte todo el pool entre operarios', async () => {
    const f = buildFacade();
    await seedPickPool(f, 6);
    const bal = await f.facade.autoBalance('op1', { type: 'PICK', execute: true, by: 'sup' });
    assert.equal(bal.asignadas, 6, 'reparte las 6 órdenes');
    assert.ok(bal.porOperario.length >= 2, 'usa a ambos operarios');
    // Ya no quedan pendientes sin asignar.
    const pool = await f.facade.getTaskPool('op1', 'PICK', { onlyUnassigned: true });
    assert.equal(pool.length, 0);
  });

  await test('asignación (B): modo estricto bloquea a otro operario; advisory permite', async () => {
    const f = buildFacade();
    const [o0] = await seedPickPool(f, 1);
    await f.facade.assignTask('op1', { type: 'PICK', entityId: o0, entityRef: 'A-0', sellerId: 'acme', operator: 'opa', unitsEstimate: 5, by: 'sup' });
    // Estricto: opb no puede pickear la orden de opa.
    await f.facade.setAssignmentMode('op1', 'strict');
    await expectThrows(() => f.facade.confirmPick('acme', o0, 'opb'), ForbiddenError);
    // Advisory: sí puede (el sistema igual registra quién la ejecutó).
    await f.facade.setAssignmentMode('op1', 'advisory');
    const o = await f.facade.confirmPick('acme', o0, 'opb');
    assert.equal(o.status, 'PICKED');
  });

  await test('asignación (B): recepciones asignables y auto-completadas al cotejar', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await f.facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.createUser({ id: 'opa', name: 'Op A', email: 'opa@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const r = await f.facade.createReceipt('acme', { supplier: 'Prov', reference: 'GD-1', locationId: recv.id, lines: [{ sku: 'CAM', qty: 100 }] }, 'system');
    const pool = await f.facade.getTaskPool('op1', 'RECEIVE');
    assert.equal(pool.length, 1, 'la recepción pendiente aparece en el pool');
    assert.equal(pool[0].entityId, r.id);
    assert.equal(pool[0].unidades, 100);
    await f.facade.assignTask('op1', { type: 'RECEIVE', entityId: r.id, entityRef: 'GD-1', sellerId: 'acme', operator: 'opa', unitsEstimate: 100, by: 'sup' });
    assert.equal((await f.facade.getOperatorTasks('op1', 'opa')).length, 1);
    await f.facade.receiveReceipt('acme', r.id, [{ lineNo: 1, qty: 100 }], 'opa'); // cotejo completo → RECEIVED
    assert.equal((await f.facade.getOperatorTasks('op1', 'opa')).length, 0, 'la asignación de recepción se auto-completó');
  });

  await test('asignación (B): re-slotting de clase A lejos del despacho', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    // Despacho en (0,0); NEAR cerca, FAR lejos.
    await f.facade.createLocation({ operationId: 'op1', code: 'SHIP-01', zoneType: ZoneType.SHIPPING, x: 0, y: 0 });
    const near = await f.facade.createLocation({ operationId: 'op1', code: 'NEAR', zoneType: ZoneType.STORAGE, capacity: 5000, pickRank: 1, x: 1, y: 0 });
    const far = await f.facade.createLocation({ operationId: 'op1', code: 'FAR', zoneType: ZoneType.STORAGE, capacity: 5000, pickRank: 2, x: 20, y: 0 });
    await f.facade.createUser({ id: 'opa', name: 'Op A', email: 'opa@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    await f.facade.createSku('acme', { sku: 'HOT', description: 'Rápido', rotationClass: RotationClass.A } as any);
    await f.facade.receive('acme', { sku: 'HOT', qty: 200, locationId: far.id }); // clase A guardada LEJOS
    const pool = await f.facade.getTaskPool('op1', 'RESLOT');
    const t = pool.find((x: any) => x.entityId === `acme:HOT:${far.id}`);
    assert.ok(t, 'propone re-slotear HOT desde FAR');
    assert.ok(/FAR → NEAR/.test(t.entityRef), 'destino: la ubicación más cercana');
    assert.equal(t.note, near.id);
    // Asignar y ejecutar el movimiento cierra la tarea.
    await f.facade.assignTask('op1', { type: 'RESLOT', entityId: t.entityId, entityRef: t.entityRef, sellerId: 'acme', operator: 'opa', unitsEstimate: 200, by: 'sup' });
    await f.facade.putaway('acme', { sku: 'HOT', qty: 200, fromLocationId: far.id, toLocationId: near.id, reference: 'RESLOT', actor: 'opa' });
    assert.equal((await f.facade.getOperatorTasks('op1', 'opa')).length, 0, 're-slot auto-completado al mover');
  });

  await test('asignación (B): auto-balanceo continuo — barrido inicial y trabajo nuevo', async () => {
    const f = buildFacade();
    // 3 órdenes ya reservadas (sin auto-balanceo aún → quedan sin asignar).
    await seedPickPool(f, 3);
    let pool = await f.facade.getTaskPool('op1', 'PICK', { onlyUnassigned: true });
    assert.equal(pool.length, 3, 'hay 3 pendientes sin asignar');
    // Activar el continuo hace un barrido inicial que las reparte.
    const r = await f.facade.setAutoBalanceContinuous('op1', true);
    assert.ok(r.asignadasInicial >= 3, 'el barrido inicial asigna las pendientes');
    assert.equal((await f.facade.getTaskPool('op1', 'PICK', { onlyUnassigned: true })).length, 0);
    // Con el continuo activo, una orden NUEVA se asigna sola al reservarla.
    const o = await f.facade.createOrder('acme', { externalOrderId: 'CONT-1', salesChannel: 'web', shipTo: { name: 'x' } as any, lines: [{ sku: 'CAM', qty: 5 }] });
    await f.facade.allocateOrder('acme', o.id);
    const t = (await f.facade.getTaskPool('op1', 'PICK')).find((x: any) => x.entityId === o.id);
    assert.ok(t && t.asignadoA, 'la orden nueva quedó auto-asignada a un operario');
  });

  await test('asignación (B): reasignación automática por ociosidad (work-stealing)', async () => {
    const f = buildFacade();
    // 6 órdenes, todas asignadas manualmente a opa → opb queda ocioso.
    const ids = await seedPickPool(f, 6);
    for (let i = 0; i < ids.length; i++) {
      await f.facade.assignTask('op1', { type: 'PICK', entityId: ids[i], entityRef: `A-${i}`, sellerId: 'acme', operator: 'opa', unitsEstimate: 5, by: 'sup' });
    }
    assert.equal((await f.facade.getOperatorTasks('op1', 'opa')).length, 6, 'opa cargado con las 6');
    assert.equal((await f.facade.getOperatorTasks('op1', 'opb')).length, 0, 'opb ocioso');
    // Redistribuir mueve tareas del más cargado (opa) al ocioso (opb).
    const res = await f.facade.rebalanceLoad('op1', { execute: true });
    assert.ok(res.movimientos.length >= 1, 'hubo al menos un movimiento');
    assert.ok(res.movimientos.every((m: any) => m.de === 'opa' && m.a === 'opb'), 'movió de opa a opb');
    const a = (await f.facade.getOperatorTasks('op1', 'opa')).length;
    const b = (await f.facade.getOperatorTasks('op1', 'opb')).length;
    assert.equal(a + b, 6, 'no se pierde ni duplica ninguna tarea');
    assert.ok(b >= 2 && Math.abs(a - b) <= 2, 'la carga quedó balanceada');
    // La tarea más antigua de opa (protegida, "en curso") no se movió.
    const opaTasks = await f.facade.getOperatorTasks('op1', 'opa');
    assert.ok(opaTasks.some((t: any) => t.entityId === ids[0]), 'la primera tarea (en curso) permanece con opa');
  });

  console.log('\nCostos y rentabilidad (costeo por actividad + estándar/real)\n');

  async function seedCosting(f: ReturnType<typeof buildFacade>) {
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createUser({ id: 'opa', name: 'Op A', email: 'opa@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    // Estándar PICK 100 u/h; tarifa estándar 5000/h; opa cuesta 6000/h (más caro).
    await f.facade.setCostRates('op1', { standardLaborRatePerHour: 5000, laborCostByOperator: { opa: 6000 }, standardUph: { PICK: 100 }, storageCostPerUnitMonth: 0, monthlyOverhead: 0 });
    // opa pickea 100 unidades pero tarda 2 h (debería tomar 1 h a estándar).
    await f.laborService.capture({ operationId: 'op1', sellerId: 'acme', operator: 'opa', type: 'PICK', startAt: '2026-01-15T00:00:00.000Z', endAt: '2026-01-15T02:00:00.000Z', units: 100 });
  }

  await test('costos: eficiencia estándar vs real y varianza por operario', async () => {
    const f = buildFacade();
    await seedCosting(f);
    const eff = await f.facade.laborEfficiency('op1', 2026, 1, 'operator');
    const row = eff.rows.find((r: any) => r.key === 'opa');
    assert.ok(row, 'aparece opa');
    assert.equal(row!.realHours, 2, 'horas reales = 2');
    assert.equal(row!.standardHours, 1, 'horas estándar = 1 (100 u ÷ 100 u/h)');
    assert.equal(row!.efficiencyPct, 50, 'eficiencia = 50% (tardó el doble)');
    assert.equal(row!.realCost, 12000, 'costo real = 2 h × 6000');
    assert.equal(row!.standardCost, 5000, 'costo estándar = 1 h × 5000');
    assert.equal(row!.variance, 7000, 'sobrecosto = real − estándar');
  });

  await test('costos: rentabilidad por cliente cruza ingreso (facturación) con costo', async () => {
    const f = buildFacade();
    await seedCosting(f);
    await f.facade.setBillingRate('acme', { fixedMonthly: 100000 }); // ingreso plano del mes
    const p = await f.facade.profitability('op1', 2026, 1);
    const acme = p.sellers.find((s: any) => s.sellerId === 'acme');
    assert.ok(acme, 'aparece el cliente acme');
    assert.equal(acme!.revenue, 100000, 'ingreso = cuota fija');
    assert.equal(acme!.cost.laborReal, 12000, 'costo real de mano de obra');
    assert.equal(acme!.cost.laborStandard, 5000, 'costo estándar de mano de obra');
    assert.equal(acme!.cost.laborVariance, 7000, 'varianza de eficiencia');
    assert.equal(acme!.marginReal, 88000, 'margen real = ingreso − costo real');
    assert.equal(acme!.marginStandard, 95000, 'margen objetivo = ingreso − costo estándar');
    assert.equal(acme!.marginPctReal, 88, 'margen real %');
    assert.equal(acme!.marginPctStandard, 95, 'margen objetivo %');
    // El total consolida al cliente.
    assert.equal(p.totals.revenue, 100000);
    assert.equal(p.totals.laborVariance, 7000, 'la varianza total es gestionable a nivel gerencial');
  });

  await test('costos: la tarjeta por defecto trae estándares y se puede editar', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    const def = await f.facade.getCostRates('op1');
    assert.equal(def.standardUph.PICK, 80, 'estándar PICK por defecto');
    assert.ok(def.standardLaborRatePerHour > 0, 'tarifa estándar por defecto');
    const upd = await f.facade.setCostRates('op1', { monthlyOverhead: 500000, overheadDriver: 'unitMonths' }, 'ana');
    assert.equal(upd.monthlyOverhead, 500000);
    assert.equal(upd.overheadDriver, 'unitMonths');
    assert.equal(upd.updatedBy, 'ana');
    assert.equal(upd.standardUph.PICK, 80, 'no pierde los estándares al hacer patch parcial');
  });

  await test('copiloto de voz: expone tools de automatismo y sus métodos operan', async () => {
    const names = COPILOT_ACTION_TOOLS.map((t) => t.name);
    for (const n of ['activar_auto_balanceo', 'fijar_modo_asignacion', 'reasignar_ociosidad']) {
      assert.ok(names.includes(n), `la acción de voz ${n} está registrada`);
    }
    // Los métodos que gatillan estos tools funcionan de punta a punta.
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createUser({ id: 'opa', name: 'Op A', email: 'opa@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const cont = await f.facade.setAutoBalanceContinuous('op1', true);
    assert.ok(cont, 'activar auto-balanceo continuo responde');
    assert.equal(await f.facade.getAutoBalanceEnabled('op1'), true);
    await f.facade.setAssignmentMode('op1', 'strict');
    assert.equal(await f.facade.getAssignmentMode('op1'), 'strict');
    const rb = await f.facade.rebalanceLoad('op1', { execute: true });
    assert.ok(rb && Array.isArray(rb.movimientos), 'reasignación por ociosidad responde');
  });

  await test('órdenes: iniciar picking (ALLOCATED → PICKING) antes de recolectar', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    const o = await f.facade.createOrder('acme', { externalOrderId: 'P-1', salesChannel: 'web', shipTo: SHIP_TO, lines: [{ sku: 'CAM', qty: 10 }] });
    await f.facade.allocateOrder('acme', o.id);
    // Iniciar picking marca la orden en curso sin recolectar (stock sigue reservado).
    const started = await f.facade.startPicking('acme', o.id, 'pedro');
    assert.equal(started.status, 'PICKING', 'la orden queda en PICKING');
    assert.ok((started.events || []).some((e: any) => e.type === 'PICKING'), 'registra el evento PICKING');
    // Idempotente: repetir no rompe.
    assert.equal((await f.facade.startPicking('acme', o.id, 'pedro')).status, 'PICKING');
    // Luego pickear la completa.
    assert.equal((await f.facade.confirmPick('acme', o.id, 'pedro')).status, 'PICKED');
  });

  await test('copiloto: acción iniciar_picking disponible y ejecutable', async () => {
    const names = COPILOT_ACTION_TOOLS.find((t) => t.name === 'avanzar_estado_orden');
    const enumVals = (names as any)?.parameters?.properties?.accion?.enum || [];
    assert.ok(enumVals.includes('iniciar_picking'), 'el LLM ve la acción iniciar_picking');
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 50, locationId: stg.id });
    const o = await f.facade.createOrder('acme', { externalOrderId: 'P-9', salesChannel: 'web', shipTo: SHIP_TO, lines: [{ sku: 'CAM', qty: 5 }] });
    await f.facade.allocateOrder('acme', o.id);
    const r = await f.facade.copilotConfirmAction('op1', null, { id: 'ana', role: 'ADMIN' }, { orden: 'P-9', accion: 'iniciar_picking' });
    assert.equal(r.ok, true, 'la confirmación ejecuta iniciar_picking');
    assert.equal(r.nuevoEstado, 'PICKING');
  });

  await test('copiloto: consulta tareas pendientes (recepción y guardado) con ids para asignar', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const recv = await f.facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.createUser({ id: 'opa', name: 'Op A', email: 'opa@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    // Recepción pendiente (por cotejar) → aparece en el pool RECEIVE.
    const r = await f.facade.createReceipt('acme', { supplier: 'Prov', reference: 'GD-1', locationId: recv.id, lines: [{ sku: 'CAM', qty: 100 }] }, 'system');
    const recPool: any = await f.facade.runCopilotTool('tareas_pendientes', { tipo: 'RECEIVE' }, 'op1', null);
    assert.equal(recPool.tipo, 'RECEIVE');
    const tRec = recPool.tareas.find((t: any) => t.ref === 'GD-1');
    assert.ok(tRec, 'la recepción pendiente aparece con su referencia');
    assert.equal(tRec.id, r.id, 'trae el id para poder asignarla');
    assert.equal(tRec.unidades, 100);
    // Stock en zona de RECEPCIÓN → tarea de GUARDADO (PUTAWAY) pendiente.
    await f.facade.receive('acme', { sku: 'CAM', qty: 40, locationId: recv.id });
    const putPool: any = await f.facade.runCopilotTool('tareas_pendientes', { tipo: 'PUTAWAY' }, 'op1', null);
    assert.equal(putPool.tipo, 'PUTAWAY');
    assert.ok(putPool.tareas.length >= 1, 'hay tarea de guardado pendiente');
    assert.ok(putPool.tareas[0].id && putPool.tareas[0].cliente === 'acme');
    // Y esas tareas se pueden asignar a un operario (path no-PICK).
    await f.facade.assignTask('op1', { type: 'RECEIVE', entityId: r.id, entityRef: 'GD-1', sellerId: 'acme', operator: 'opa', unitsEstimate: 100, by: 'ana' });
    const after: any = await f.facade.runCopilotTool('tareas_pendientes', { tipo: 'RECEIVE' }, 'op1', null);
    assert.equal(after.tareas.find((t: any) => t.id === r.id).asignadoA, 'opa', 'queda asignada al operario');
  });

  await test('copiloto: pool y asignación de EMPAQUE y DESPACHO, con auto-completado', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 500, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.createUser({ id: 'opa', name: 'Op A', email: 'opa@x.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    const o = await f.facade.createOrder('acme', { externalOrderId: 'E-1', salesChannel: 'web', shipTo: SHIP_TO, lines: [{ sku: 'CAM', qty: 10 }] });
    await f.facade.allocateOrder('acme', o.id);
    await f.facade.confirmPick('acme', o.id, 'opa'); // → PICKED
    // PACK: la orden recolectada aparece en el pool de empaque y se puede asignar.
    const packPool: any = await f.facade.runCopilotTool('tareas_pendientes', { tipo: 'PACK' }, 'op1', null);
    assert.equal(packPool.tipo, 'PACK');
    assert.ok(packPool.tareas.find((t: any) => t.ref === 'E-1'), 'la orden PICKED aparece para empacar');
    await f.facade.assignTask('op1', { type: 'PACK', entityId: o.id, entityRef: 'E-1', sellerId: 'acme', operator: 'opa', unitsEstimate: 10, by: 'ana' });
    assert.equal((await f.facade.getOperatorTasks('op1', 'opa')).filter((t: any) => t.type === 'PACK').length, 1, 'opa tiene la tarea de empaque');
    await f.facade.packOrder('acme', o.id, { bultos: 1 }, 'opa'); // → PACKED, cierra la asignación PACK
    assert.equal((await f.facade.getOperatorTasks('op1', 'opa')).filter((t: any) => t.type === 'PACK').length, 0, 'la tarea de empaque se auto-completó');
    // SHIP: la orden empacada aparece en el pool de despacho y se puede asignar.
    const shipPool: any = await f.facade.runCopilotTool('tareas_pendientes', { tipo: 'SHIP' }, 'op1', null);
    assert.ok(shipPool.tareas.find((t: any) => t.ref === 'E-1'), 'la orden PACKED aparece para despachar');
    await f.facade.assignTask('op1', { type: 'SHIP', entityId: o.id, entityRef: 'E-1', sellerId: 'acme', operator: 'opa', unitsEstimate: 10, by: 'ana' });
    await f.facade.shipOrder('acme', o.id, { carrier: 'X' }, 'opa'); // → SHIPPED, cierra la asignación SHIP
    assert.equal((await f.facade.getOperatorTasks('op1', 'opa')).filter((t: any) => t.type === 'SHIP').length, 0, 'la tarea de despacho se auto-completó');
    assert.equal((await f.facade.getOrder('acme', o.id))!.status, 'SHIPPED');
  });

  await test('vista consolidada: todos los clientes en una fila cada uno + totales', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createSeller({ id: 'globex', operationId: 'op1', name: 'Globex' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.createSku('globex', { sku: 'PAN', description: 'Pantalón' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    await f.facade.receive('globex', { sku: 'PAN', qty: 50, locationId: stg.id });
    // ACME: una orden abierta (reservada). Globex: sin órdenes.
    const o = await f.facade.createOrder('acme', { externalOrderId: 'A-1', salesChannel: 'web', shipTo: SHIP_TO, lines: [{ sku: 'CAM', qty: 10 }] });
    await f.facade.allocateOrder('acme', o.id);
    const ov = await f.facade.clientsOverview('op1');
    assert.equal(ov.clientes.length, 2, 'una fila por cliente');
    const acme = ov.clientes.find((c: any) => c.sellerId === 'acme');
    assert.ok(acme && acme.ordenesAbiertas === 1 && acme.enProceso === 1, 'ACME tiene su orden abierta/en proceso');
    assert.ok(acme.stockOnHand >= 90, 'refleja el stock on-hand del cliente');
    assert.equal(ov.totales.clientes, 2);
    assert.equal(ov.totales.ordenesAbiertas, 1, 'los totales agregan a todos los clientes');
    assert.ok('facturacionMes' in acme && 'currency' in ov.totales, 'incluye la columna comercial');
  });

  // ---- Ubicaciones: eliminar solo sin historia; reposición de embalaje con referencia ----
  await test('ubicaciones: se elimina si nunca tuvo movimientos; si los tuvo, pide desactivar', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const vacia = await f.facade.createLocation({ operationId: 'op1', code: 'Z-99', zoneType: ZoneType.STORAGE });
    const usada = await f.facade.createLocation({ operationId: 'op1', code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 1 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 5, locationId: usada.id });
    const r = await f.facade.deleteLocation(vacia.id);
    assert.equal(r.code, 'Z-99');
    assert.equal((await f.facade.listLocations('op1')).length, 1, 'la vacía desaparece');
    await expectThrows(() => f.facade.deleteLocation(usada.id), ValidationError);
    assert.equal((await f.facade.listLocations('op1')).length, 1, 'la usada sigue (con historia no se borra)');
    // Una recepción abierta apuntando a la ubicación también bloquea el borrado.
    const recv = await f.facade.createLocation({ operationId: 'op1', code: 'RECV-02', zoneType: ZoneType.RECEIVING });
    await f.facade.createReceipt('acme', { supplier: 'Prov', locationId: recv.id, lines: [{ sku: 'CAM', qty: 1 }] } as any);
    await expectThrows(() => f.facade.deleteLocation(recv.id), ValidationError);
    // Frontera de operación: un admin de otra operación no puede borrar.
    const otra = await f.facade.createLocation({ operationId: 'op1', code: 'Z-98', zoneType: ZoneType.STORAGE });
    await expectThrows(() => f.facade.deleteLocation(otra.id, { operationId: 'op-otra' } as any), ForbiddenError);
  });

  await test('embalaje: la reposición queda en el historial con referencia y usuario', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createPackaging('op1', { sku: 'CAJA-M', name: 'Caja mediana', barcode: null, unitPrice: 100 });
    await f.facade.receivePackagingStock('op1', 'CAJA-M', 200, 'pamela', 'Cartones Sur · Guía 4581');
    await f.facade.adjustPackagingStock('op1', 'CAJA-M', -3, 'pamela', 'merma');
    const movs = await f.facade.listPackagingMovements('op1', { materialSku: 'CAJA-M' });
    assert.equal(movs.length, 2);
    const repo = movs.find((m: any) => m.type === 'RECEIPT')!;
    assert.equal(repo.qtyDelta, 200);
    assert.equal(repo.reference, 'Cartones Sur · Guía 4581');
    assert.equal(repo.actor, 'pamela');
    const mats = await f.facade.listPackaging('op1');
    assert.equal(mats.find((m: any) => m.sku === 'CAJA-M')!.onHand, 197);
  });

  await test('embalaje: costo promedio ponderado (PMP) por reposición y valorización del consumo', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createPackaging('op1', { sku: 'CAJA-M', name: 'Caja mediana', barcode: null, unitPrice: 500 });
    await f.facade.receivePackagingStock('op1', 'CAJA-M', 100, 'pamela', 'Guía 1', 300); // PMP 300
    f.clock.set('2026-01-02T00:00:00.000Z');
    await f.facade.receivePackagingStock('op1', 'CAJA-M', 100, 'pamela', 'Guía 2', 400); // PMP (100*300+100*400)/200 = 350
    let mats = await f.facade.listPackaging('op1');
    let m = mats.find((x: any) => x.sku === 'CAJA-M')!;
    assert.equal(m.onHand, 200); assert.equal(m.avgCost, 350); assert.equal(m.lastCost, 400); assert.equal(m.stockValue, 70000);
    // Consumo al empacar: se valoriza al PMP vigente y se cobra al precio del seller.
    const use = await f.packagingService.resolveUse('op1', 'acme', 'ORD-1', [{ sku: 'CAJA-M', qty: 10 }], 'op');
    await f.packagingService.commit(use.movements);
    assert.equal(use.movements[0].unitCost, 350); assert.equal(use.movements[0].unitPrice, 500);
    mats = await f.facade.listPackaging('op1'); m = mats.find((x: any) => x.sku === 'CAJA-M')!;
    assert.equal(m.onHand, 190); assert.equal(m.avgCost, 350, 'la salida no cambia el PMP');
    const cc = await f.packagingService.consumptionCost('op1', 'acme', '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
    assert.deepEqual(cc, { qty: 10, cost: 3500, billed: 5000 });
    // Reposición sin costo (histórico) no altera el PMP; con saldo 0 el PMP pasa a ser el costo nuevo.
    await f.facade.receivePackagingStock('op1', 'CAJA-M', 10, 'pamela', null, null);
    mats = await f.facade.listPackaging('op1'); assert.equal(mats[0].avgCost, 350);
    await f.facade.createPackaging('op1', { sku: 'BOLSA', name: 'Bolsa', barcode: null, unitPrice: 50 });
    await f.facade.receivePackagingStock('op1', 'BOLSA', 500, 'pamela', null, 12);
    mats = await f.facade.listPackaging('op1'); assert.equal(mats.find((x: any) => x.sku === 'BOLSA')!.avgCost, 12);
    await expectThrows(() => f.facade.receivePackagingStock('op1', 'BOLSA', 5, 'pamela', null, -1), ValidationError);
  });

  // ---- Agente autónomo Fase 1: política, sombra, alertas por entidad, ciclo, diario ----
  await test('política de autonomía: nivel, sombra, pausa, límites y confirmación', async () => {
    const base = effectiveAgentSettings(null, 'op1');
    assert.equal(base.autonomyLevel, 1); assert.equal(base.shadowMode, true);
    // Nivel 1 permite asignar/balancear al agente solo si NO está en sombra.
    assert.equal(decidePolicy({ tool: 'asignar_tarea', settings: base, autonomous: true }).decision, 'propose');
    const real = { ...base, shadowMode: false };
    assert.equal(decidePolicy({ tool: 'asignar_tarea', settings: real, autonomous: true }).decision, 'execute');
    assert.equal(decidePolicy({ tool: 'avanzar_estado_orden', settings: real, autonomous: true }).decision, 'propose', 'avanzar órdenes exige nivel 2');
    assert.equal(decidePolicy({ tool: 'avanzar_estado_orden', settings: { ...real, autonomyLevel: 2 }, autonomous: true }).decision, 'execute');
    assert.equal(decidePolicy({ tool: 'balancear_carga', settings: { ...real, paused: true }, autonomous: true }).decision, 'deny');
    assert.equal(decidePolicy({ tool: 'balancear_carga', settings: real, autonomous: true, usage: { cycle: 20, hour: 0 } }).decision, 'propose', 'límite por ciclo');
    assert.equal(decidePolicy({ tool: 'balancear_carga', settings: real, autonomous: true, usage: { cycle: 0, hour: 100 } }).decision, 'propose', 'límite por hora');
    // Humano vía copiloto en modo confirmación: las acciones de nivel ≥2 quedan propuestas; las de nivel 1 se ejecutan.
    assert.equal(decidePolicy({ tool: 'crear_recepcion', settings: real, autonomous: false }).decision, 'propose');
    assert.equal(decidePolicy({ tool: 'asignar_tarea', settings: real, autonomous: false }).decision, 'execute');
    assert.equal(decidePolicy({ tool: 'crear_recepcion', settings: { ...real, actionMode: 'direct', autonomyLevel: 2 }, autonomous: false }).decision, 'execute');
    // Confirmación humana explícita siempre ejecuta; acción desconocida siempre propone.
    assert.equal(decidePolicy({ tool: 'crear_orden', settings: base, autonomous: true, confirmed: true }).decision, 'execute');
    assert.equal(decidePolicy({ tool: 'lo_que_sea', settings: { ...real, autonomyLevel: 3 }, autonomous: false }).decision, 'propose');
  });

  await test('copiloto: en modo confirmación TODAS las escrituras de nivel ≥2 quedan propuestas y se confirman con {tool,args}', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createLocation({ operationId: 'op1', code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.updateAgentSettings('op1', { autonomyLevel: 1, shadowMode: false, actionMode: 'confirm' }, 'ana');
    const pending: any[] = [];
    const r = await (f.facade as any).copilotExecAction('crear_recepcion', { sellerId: 'acme', lineas: [{ sku: 'CAM', qty: 10 }], referencia: 'G-1' }, { operationId: 'op1', sellerId: null, mode: 'confirm', canWrite: true, question: 'crea la recepción', actor: { id: 'ana', role: UserRole.ADMIN }, pendingActions: pending });
    assert.equal(r.requiresConfirmation, true, 'crear_recepcion queda propuesta (antes se ejecutaba siempre)');
    assert.equal(pending.length, 1); assert.equal(pending[0].tool, 'crear_recepcion');
    assert.equal((await f.facade.listReceipts('acme')).length, 0, 'nada se creó');
    // El humano confirma la propuesta genérica.
    const c = await f.facade.copilotConfirmTool('op1', null, { id: 'ana', role: UserRole.ADMIN }, { tool: pending[0].tool, args: pending[0].args });
    assert.equal(c.ok, true);
    assert.equal((await f.facade.listReceipts('acme')).length, 1, 'ahora sí existe');
    const recs = await f.aiAudit.listRecommendations('op1', { type: 'copilot_action' });
    assert.ok(recs.some((x) => x.taken === true), 'la recomendación quedó marcada como tomada');
    // Sin identidad y con AUTH_REQUIRED=true no hay escritura.
    process.env.AUTH_REQUIRED = 'true';
    assert.equal((f.facade as any).copilotCanWrite(null), false);
    delete process.env.AUTH_REQUIRED;
    assert.equal((f.facade as any).copilotCanWrite(null), true, 'modo demo');
  });

  await test('agente: alertas POR ENTIDAD con referencia, y ciclo con lock, sombra y diario', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    await f.facade.createUser({ id: 'pedro', name: 'Pedro', email: 'p@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    await f.facade.createUser({ id: 'carla', name: 'Carla', email: 'c@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    // Dos órdenes estancadas 48 h → dos alertas, una por orden, con su referencia.
    f.clock.set('2026-01-01T00:00:00.000Z');
    for (const ref of ['PED-1', 'PED-2']) { const o = await f.facade.createOrder('acme', { externalOrderId: ref, salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 1 }] }, 'ana'); await f.facade.allocateOrder('acme', o.id, 'ana'); }
    f.clock.set('2026-01-03T00:00:00.000Z');
    await f.facade.updateAgentRule('op1', 'orden_estancada', { enabled: true, threshold: 24, actionType: 'execute', actionMode: 'directo' }, 'ana');
    // Sombra ON (default): la acción NO se ejecuta, queda registrada como "habría ejecutado".
    const c1 = await f.facade.runAgentCycle('op1', { by: 'test' });
    assert.ok(c1.barrido, 'ciclo corrió');
    const open = await f.facade.agentAlerts('op1');
    const est = open.abiertas.filter((a) => a.ruleKey === 'orden_estancada');
    assert.equal(est.length, 2, 'una alerta por orden');
    assert.deepEqual(est.map((a) => a.entityRef).sort(), ['PED-1', 'PED-2']);
    assert.equal(est[0].entityType, 'ORDER');
    assert.equal(c1.barrido!.sombra, 1, 'acción de la regla en sombra (una vez por barrido)');
    assert.equal(c1.barrido!.ejecutadas, 0);
    const shadowActs = await f.aiAudit.listActions('op1', { agent: 'agent-shadow' });
    assert.equal(shadowActs.length, 1);
    const journal = await f.facade.agentJournalList('op1');
    assert.ok(journal.some((e) => e.kind === 'decision' && /sombra/.test(e.text)), 'el diario registra la decisión en sombra');
    assert.ok(journal.some((e) => e.kind === 'cycle'), 'el diario registra el ciclo');
    // Dedupe por entidad: un segundo ciclo no duplica.
    await f.facade.runAgentCycle('op1', { by: 'test' });
    assert.equal((await f.facade.agentAlerts('op1')).abiertas.filter((a) => a.ruleKey === 'orden_estancada').length, 2);
    // Pausa → el ciclo se omite.
    await f.facade.updateAgentSettings('op1', { paused: true }, 'ana');
    assert.equal((await f.facade.runAgentCycle('op1')).skipped, 'agente en pausa');
    // Estado del agente para el panel.
    const st = await f.facade.agentStatus('op1');
    assert.equal(st.settings.paused, true); assert.ok(st.lastCycle);
  });

  await test('agente: instrucciones vigentes y contexto en capas (perfil, estado, memoria)', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Bodega Norte' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME', pickingStrategy: PickingStrategy.FEFO });
    await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 500 });
    await f.facade.addAgentInstruction('op1', 'Hoy priorizar Chilexpress', 1, 'ana');
    const ins = await f.facade.agentInstructions('op1');
    assert.equal(ins.length, 1);
    const profile = await f.facade.agentProfileContext('op1');
    assert.ok(/Bodega Norte/.test(profile) && /FEFO/.test(profile) && /Reglas de negocio/.test(profile), 'perfil con clientes, políticas y reglas');
    const state = await f.facade.agentStateContext('op1', null);
    assert.ok(/ESTADO OPERATIVO/.test(state) && /Órdenes abiertas 0/.test(state), 'estado compacto');
    const mem = await f.facade.agentMemoryContext('op1');
    assert.ok(/Hoy priorizar Chilexpress/.test(mem), 'la instrucción entra en la memoria');
    const full = await f.facade.copilotContextPreview('op1', null);
    assert.ok(/PERFIL DE LA OPERACIÓN/.test(full.context) && /INSTRUCCIONES VIGENTES/.test(full.context) && /Inventario por SKU/.test(full.context), 'contexto en capas completo');
    await f.facade.retireAgentInstruction('op1', ins[0].id, 'ana');
    assert.equal((await f.facade.agentInstructions('op1')).length, 0);
    // guardar_instruccion como herramienta del copiloto (nivel 1 → ejecuta).
    await f.facade.updateAgentSettings('op1', { shadowMode: false }, 'ana');
    const r = await (f.facade as any).copilotExecAction('guardar_instruccion', { texto: 'No despachar ACME hasta que apruebe' }, { operationId: 'op1', sellerId: null, mode: 'confirm', canWrite: true, question: 'x', actor: { id: 'ana', role: UserRole.ADMIN }, pendingActions: [] });
    assert.equal(r.ok, true);
    assert.equal((await f.facade.agentInstructions('op1')).length, 1);
  });

  await test('bandeja del operario: orden de ejecución por tipo, cola, SLA e instrucciones', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    await f.facade.createUser({ id: 'pedro', name: 'Pedro', email: 'p@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });
    const mk = async (ref: string, carrier: string) => { const o = await f.facade.createOrder('acme', { externalOrderId: ref, salesChannel: 'web', carrier, shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 1 }] }, 'ana'); await f.facade.allocateOrder('acme', o.id, 'ana'); return o; };
    const o1 = await mk('STK-1', 'Starken');
    f.clock.set('2026-01-01T00:01:00.000Z');
    const o2 = await mk('CHX-1', 'Chilexpress');
    // Se asignan en ese orden a Pedro: sin más información, STK-1 iría primero (asignada antes).
    await f.facade.assignTask('op1', { type: 'PICK', entityId: o1.id, entityRef: 'STK-1', sellerId: 'acme', operator: 'pedro', unitsEstimate: 1, by: 'ana' });
    await f.facade.assignTask('op1', { type: 'PICK', entityId: o2.id, entityRef: 'CHX-1', sellerId: 'acme', operator: 'pedro', unitsEstimate: 1, by: 'ana' });
    let mine = await f.facade.getOperatorTasks('op1', 'pedro');
    assert.deepEqual(mine.map((t) => t.entityRef), ['STK-1', 'CHX-1']);
    assert.equal(mine[0].next, true); assert.equal(mine[0].position, 1);
    // Instrucción del administrador: priorizar Chilexpress → CHX-1 pasa a ser la siguiente.
    await f.facade.addAgentInstruction('op1', 'Hoy priorizar Chilexpress', 0, 'ana');
    (f.facade as any).prioritiesAt.clear();
    mine = await f.facade.getOperatorTasks('op1', 'pedro');
    assert.deepEqual(mine.map((t) => t.entityRef), ['CHX-1', 'STK-1'], 'la instrucción reordena la bandeja');
    assert.match(mine[0].priorityReason || '', /priorizar courier/);
    // Un despacho pendiente va antes que cualquier picking (peso por tipo).
    await f.facade.confirmPick('acme', o1.id, 'ana');
    await f.facade.packOrder('acme', o1.id, { bultos: 1, materials: [] }, 'ana');
    await f.facade.assignTask('op1', { type: 'SHIP', entityId: o1.id, entityRef: 'STK-1', sellerId: 'acme', operator: 'pedro', unitsEstimate: 1, by: 'ana' });
    (f.facade as any).prioritiesAt.clear();
    mine = await f.facade.getOperatorTasks('op1', 'pedro');
    assert.equal(mine[0].type, 'SHIP', 'el despacho listo va primero');
    const view = await f.facade.operatorActivities('op1', 'pedro');
    assert.equal(view.tareas[0].tipo, 'SHIP'); assert.ok(view.tareas[0].motivo);
  });

  // ---- Deadline de preparación (v99) ----------------------------------------

  await test('deadline: la próxima hora de corte del courier respeta día y huso', () => {
    // Bodega en Chile (UTC−3). Jueves 14:00 local = 17:00 UTC.
    const jueves9 = '2026-09-17T12:00:00.000Z'; // 09:00 local
    const at = nextCutoff(jueves9, '14:00', undefined, -3);
    assert.equal(at, '2026-09-17T17:00:00.000Z', 'mismo día si el corte aún no pasa');
    // Si ya pasó, el corte es el del día siguiente.
    const jueves16 = '2026-09-17T19:00:00.000Z'; // 16:00 local
    assert.equal(nextCutoff(jueves16, '14:00', undefined, -3), '2026-09-18T17:00:00.000Z');
    // Con días hábiles (lunes a viernes), un viernes tarde salta al lunes.
    const viernes16 = '2026-09-18T19:00:00.000Z';
    assert.equal(nextCutoff(viernes16, '14:00', [1, 2, 3, 4, 5], -3), '2026-09-21T17:00:00.000Z');
    assert.equal(nextCutoff(jueves9, '99:99', undefined, -3), null, 'hora inválida → sin deadline');
  });

  await test('deadline: se resuelve por corte del courier, luego por SLA del cliente, luego nada', () => {
    const now = '2026-09-17T12:00:00.000Z'; // jueves 09:00 en Chile
    const config = { offsetHoras: -3, cortes: [{ courier: 'Chilexpress', hora: '14:00' }] };
    // 1) explícito (lo que mandó el OMS) gana sobre todo.
    const oms = resolveDueAt({ nowIso: now, carrier: 'Chilexpress', config, slaHoras: 24, explicito: '2026-09-17T15:30:00.000Z', fuenteExplicita: 'oms' });
    assert.equal(oms.dueSource, 'oms');
    assert.equal(oms.dueAt, '2026-09-17T15:30:00.000Z');
    // 2) corte del courier (tolera mayúsculas y espacios en el nombre).
    const corte = resolveDueAt({ nowIso: now, carrier: '  CHILEXPRESS ', config, slaHoras: 24 });
    assert.equal(corte.dueSource, 'corte');
    assert.equal(corte.dueAt, '2026-09-17T17:00:00.000Z');
    // 3) sin corte para ese courier → SLA del cliente.
    const sla = resolveDueAt({ nowIso: now, carrier: 'Starken', config, slaHoras: 6 });
    assert.equal(sla.dueSource, 'sla');
    assert.equal(sla.dueAt, '2026-09-17T18:00:00.000Z');
    // 4) sin corte y sin SLA → la orden no tiene compromiso horario.
    assert.deepEqual(resolveDueAt({ nowIso: now, carrier: 'Starken', config }), { dueAt: null, dueSource: null });
  });

  await test('deadline: nivel, texto e impulso de prioridad según la holgura', () => {
    const now = '2026-09-17T12:00:00.000Z';
    assert.equal(deadlineState(null, now).level, 'sin');
    const vencida = deadlineState('2026-09-17T11:20:00.000Z', now);
    assert.equal(vencida.level, 'vencido');
    assert.equal(vencida.holguraMin, -40);
    assert.match(vencida.texto, /vencida hace 40 min/);
    assert.equal(deadlineBoost(vencida), -900);
    const critica = deadlineState('2026-09-17T12:45:00.000Z', now);
    assert.equal(critica.level, 'critico');
    assert.match(critica.texto, /vence en 45 min/);
    assert.equal(deadlineBoost(critica), -700);
    const riesgo = deadlineState('2026-09-17T14:30:00.000Z', now);
    assert.equal(riesgo.level, 'riesgo');
    assert.match(riesgo.texto, /vence en 2 h 30/);
    assert.equal(deadlineBoost(riesgo), -450);
    // La ventana de riesgo es configurable por operación.
    assert.equal(deadlineState('2026-09-17T20:00:00.000Z', now).level, 'ok');
    assert.equal(deadlineState('2026-09-17T20:00:00.000Z', now, 12).level, 'riesgo');
  });

  await test('deadline: la orden nace con el compromiso del corte y el editar lo recalcula', async () => {
    const f = buildFacade();
    f.clock.set('2026-09-17T12:00:00.000Z'); // jueves 09:00 en Chile
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.setDeadlineConfig('op1', { offsetHoras: -3, riesgoHoras: 4, cortes: [{ courier: 'Chilexpress', hora: '14:00' }, { courier: 'Starken', hora: '17:00' }] });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME', slaHoras: 8 });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });

    const o = await f.facade.createOrder('acme', { externalOrderId: 'D-1', salesChannel: 'web', carrier: 'Chilexpress', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 2 }] }, 'ana');
    assert.equal(o.dueAt, '2026-09-17T17:00:00.000Z', 'corte de Chilexpress de hoy');
    assert.equal(o.dueSource, 'corte');

    // Cambiar de courier cambia el compromiso.
    const e = await f.facade.updateOrder('acme', o.id, { externalOrderId: 'D-1', salesChannel: 'web', carrier: 'Starken', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 2 }] }, 'ana');
    assert.equal(e.dueAt, '2026-09-17T20:00:00.000Z', 'corte de Starken');

    // Un courier sin corte configurado cae al SLA del cliente (8 h desde el ingreso).
    const sinCorte = await f.facade.createOrder('acme', { externalOrderId: 'D-2', salesChannel: 'web', carrier: 'Rapiboy', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 1 }] }, 'ana');
    assert.equal(sinCorte.dueSource, 'sla');
    assert.equal(sinCorte.dueAt, '2026-09-17T20:00:00.000Z');

    // Fijarlo a mano gana, y se puede hacer aunque la orden ya esté reservada.
    await f.facade.allocateOrder('acme', o.id, 'ana');
    const fijada = await f.facade.setOrderDueAt('acme', o.id, '2026-09-17T13:00:00.000Z', 'manual', 'ana');
    assert.equal(fijada.dueSource, 'manual');
    assert.ok((fijada.events || []).some((ev) => ev.type === 'DUE_SET'), 'queda auditado');
    // Una orden despachada ya no cambia su compromiso.
    await f.facade.confirmPick('acme', o.id, 'ana');
    await f.facade.packOrder('acme', o.id, { bultos: 1, materials: [] }, 'ana');
    await f.facade.shipOrder('acme', o.id, { carrier: 'Chilexpress', trackingNumber: 'T1' }, 'ana');
    await assert.rejects(() => f.facade.setOrderDueAt('acme', o.id, '2026-09-18T13:00:00.000Z', 'manual', 'ana'), /despachada/);
  });

  await test('deadline: lo que está por vencer se salta la cola y sube en la bandeja del operario', async () => {
    const f = buildFacade();
    f.clock.set('2026-09-17T12:00:00.000Z');
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.setDeadlineConfig('op1', { offsetHoras: -3, riesgoHoras: 4, cortes: [] });
    // El cliente prioriza Chilexpress: sin deadlines, una orden de Chilexpress va primero.
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME', courierPriority: ['Chilexpress'] });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    await f.facade.createUser({ id: 'pedro', name: 'Pedro', email: 'p@op1.cl', role: UserRole.OPERATOR, operationId: 'op1' });

    const mk = async (ref: string, carrier: string, due: string | null) => {
      const o = await f.facade.createOrder('acme', { externalOrderId: ref, salesChannel: 'web', carrier, dueAt: due, dueSource: due ? 'oms' : null, shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 1 }] }, 'ana');
      await f.facade.allocateOrder('acme', o.id, 'ana');
      return o;
    };
    const chx = await mk('CHX-1', 'Chilexpress', null);        // courier prioritario, sin compromiso
    const stk = await mk('STK-1', 'Starken', '2026-09-17T13:00:00.000Z'); // vence en 1 h

    const cola = await f.facade.getPickingQueue('acme');
    assert.deepEqual(cola.map((o) => o.externalOrderId), ['STK-1', 'CHX-1'], 'el compromiso manda sobre la prioridad de courier');
    assert.equal(cola[0].deadline?.level, 'critico');

    // Y lo mismo en la bandeja del operario: el motivo explica por qué.
    await f.facade.assignTask('op1', { type: 'PICK', entityId: chx.id, entityRef: 'CHX-1', sellerId: 'acme', operator: 'pedro', unitsEstimate: 1, by: 'ana' });
    await f.facade.assignTask('op1', { type: 'PICK', entityId: stk.id, entityRef: 'STK-1', sellerId: 'acme', operator: 'pedro', unitsEstimate: 1, by: 'ana' });
    (f.facade as any).prioritiesAt.clear();
    const mine = await f.facade.getOperatorTasks('op1', 'pedro');
    assert.deepEqual(mine.map((x) => x.entityRef), ['STK-1', 'CHX-1']);
    assert.match(mine[0].priorityReason || '', /vence en/);

    // El agente la ve como riesgo ANTES de incumplir, con su holgura.
    const due = await f.facade.getOrdersDueSoon('op1', { withinHours: 2 });
    assert.equal(due.total, 1);
    assert.equal(due.items[0].orden, 'STK-1');
    assert.equal(due.items[0].holguraMin, 60);
    assert.equal(due.items[0].vencida, false);
    // Una hora y media después ya está vencida.
    f.clock.set('2026-09-17T13:30:00.000Z');
    const tarde = await f.facade.getOrdersDueSoon('op1', { withinHours: 2 });
    assert.equal(tarde.vencidas, 1);
    assert.match(tarde.items[0].texto, /vencida hace 30 min/);
  });

  // ---- Verificación al empacar y panel consolidado (v100) --------------------

  await test('verificación al empacar: registra la diferencia y alimenta la precisión de preparación', async () => {
    const f = buildFacade();
    f.clock.set('2026-09-17T12:00:00.000Z');
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.createSku('acme', { sku: 'PAN', description: 'Pantalón' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 50, locationId: stg.id });
    await f.facade.receive('acme', { sku: 'PAN', qty: 50, locationId: stg.id });

    const prep = async (ref: string) => {
      const o = await f.facade.createOrder('acme', { externalOrderId: ref, salesChannel: 'web', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 3 }, { sku: 'PAN', qty: 2 }] }, 'ana');
      await f.facade.allocateOrder('acme', o.id, 'ana');
      await f.facade.confirmPick('acme', o.id, 'ana');
      return o;
    };

    // 1) Lo contado calza con lo que pedía la orden.
    const ok = await prep('V-1');
    const packOk = await f.facade.packOrder('acme', ok.id, { bultos: 1, verify: [{ sku: 'CAM', qty: 3 }, { sku: 'PAN', qty: 2 }] }, 'pedro');
    assert.equal(packOk.packing?.verification?.ok, true);
    assert.equal(packOk.packing?.verification?.lineasConError, 0);

    // 2) Falta una unidad: queda registrado el esperado vs. contado, y el empaque NO se bloquea.
    const mal = await prep('V-2');
    const packMal = await f.facade.packOrder('acme', mal.id, { bultos: 1, verify: [{ sku: 'CAM', qty: 2 }, { sku: 'PAN', qty: 2 }] }, 'pedro');
    assert.equal(packMal.status, OrderStatus.PACKED, 'la orden igual se empaca');
    assert.equal(packMal.packing?.verification?.ok, false);
    assert.deepEqual(packMal.packing?.verification?.diferencias, [{ sku: 'CAM', lot: null, esperado: 3, contado: 2 }]);
    const ev = (packMal.events || []).find((e) => e.type === 'PACKED');
    assert.match(ev?.detail || '', /VERIFICACIÓN CON DIFERENCIAS/);

    // 3) Empacar sin verificar sigue siendo válido: queda sin verificación.
    const sin = await prep('V-3');
    const packSin = await f.facade.packOrder('acme', sin.id, { bultos: 1 }, 'pedro');
    assert.equal(packSin.packing?.verification, null);

    // 4) El panel consolidado lo convierte en precisión de preparación: 1 de 2 con error.
    const dash: any = await f.facade.operationDashboard('op1', { window: '24h' });
    assert.equal(dash.precision.pedidosVerificados, 2);
    assert.equal(dash.precision.pedidosConError, 1);
    assert.equal(dash.precision.pct, 50);
    assert.equal(dash.precision.empacadosEnVentana, 3);
    assert.equal(dash.precision.coberturaPct, 66.7, 'dos de cada tres empaques se verificaron');
  });

  await test('panel consolidado: suma toda la operación y explica lo que todavía no mide', async () => {
    const f = buildFacade();
    f.clock.set('2026-09-17T12:00:00.000Z');
    await f.facade.createOperation({ id: 'op1', name: 'Op 1' });
    await f.facade.setDeadlineConfig('op1', { offsetHoras: -3, riesgoHoras: 4, cortes: [] });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createSeller({ id: 'globex', operationId: 'op1', name: 'Globex' });
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 100 });
    for (const sid of ['acme', 'globex']) {
      await f.facade.createSku(sid, { sku: 'CAM', description: 'Camisa' });
      await f.facade.receive(sid, { sku: 'CAM', qty: 20, locationId: stg.id });
    }
    // Una orden vencida en un cliente y una a tiempo en el otro.
    const a = await f.facade.createOrder('acme', { externalOrderId: 'A-1', salesChannel: 'web', carrier: 'Starken', dueAt: '2026-09-17T10:00:00.000Z', dueSource: 'oms', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 4 }] }, 'ana');
    await f.facade.allocateOrder('acme', a.id, 'ana');
    const g = await f.facade.createOrder('globex', { externalOrderId: 'G-1', salesChannel: 'web', carrier: 'Chilexpress', dueAt: '2026-09-17T18:00:00.000Z', dueSource: 'oms', shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 6 }] }, 'ana');
    await f.facade.allocateOrder('globex', g.id, 'ana');

    const d: any = await f.facade.operationDashboard('op1', { window: '24h' });
    assert.equal(d.alcance.consolidado, true);
    assert.equal(d.alcance.clientes, 2);
    assert.equal(d.despacho.atrasadas, 1);
    assert.equal(d.despacho.aTiempo, 1);
    assert.equal(d.cargaPorCliente.length, 2, 'los dos clientes tienen carga abierta');
    assert.equal(d.cargaPorCliente[0].unidades, 6, 'ordenado por unidades');
    assert.deepEqual(d.colaPorCourier.map((c: any) => c.courier).sort(), ['Chilexpress', 'Starken']);
    assert.equal(d.ordenesPorEstado.ALLOCATED, 2);
    assert.equal(d.ocupacion.usado, 40);
    assert.equal(d.ocupacion.capacidad, 100);
    assert.equal(d.ocupacion.pct, 40);
    // Sin verificaciones todavía: el panel lo dice en vez de inventar un 100%.
    assert.equal(d.precision.pct, null);
    assert.ok(d.faltantes.some((x: string) => x.startsWith('precision-preparacion')));

    // Filtrado por cliente: solo ese cliente.
    const solo: any = await f.facade.operationDashboard('op1', { window: '24h', sellerId: 'globex' });
    assert.equal(solo.alcance.consolidado, false);
    assert.equal(solo.despacho.atrasadas, 0);
    assert.equal(solo.cargaPorCliente.length, 1);
  });

  /**
   * El panel tiene que alimentarse SOLO, de punta a punta. Esta prueba siembra
   * el sandbox completo (el mismo que usa el administrador) y exige que los
   * trece bloques traigan datos coherentes con lo sembrado: si mañana alguien
   * rompe una consulta, el bloque se vacía y esto falla.
   */
  await test('panel: los trece bloques se alimentan con la data sembrada', async () => {
    const f = buildFacade();
    f.clock.set('2026-09-17T15:00:00.000Z');
    await f.facade.createOperation({ id: 'op1', name: 'Bodega' });
    const semilla = await f.facade.seedAgentSandbox('op1', 'ana');
    // Un minuto después de sembrar: las ventanas se cuentan en [desde, ahora),
    // así que con el reloj congelado en el mismo instante nada entraría.
    f.clock.set('2026-09-17T15:01:00.000Z');
    const d: any = await f.facade.operationDashboard('op1', { window: '30d' });

    // Alcance y sello de tiempo: el panel dice cuándo se generó y qué abarca.
    assert.equal(d.alcance.operationId, 'op1');
    assert.equal(d.alcance.consolidado, true);
    assert.equal(d.generadoEn, '2026-09-17T15:01:00.000Z');
    assert.equal(d.ventana.tipo, '30d');

    // 1. Actividad: el sandbox despacha y recibe, así que algo tiene que marcar.
    for (const k of ['ordenesPreparadas', 'unidadesPreparadas', 'ordenesRecibidas', 'unidadesRecibidas', 'movimientos']) {
      assert.ok(d.actividad[k] && typeof d.actividad[k].valor === 'number', `actividad.${k} sin forma`);
    }
    assert.ok(d.actividad.movimientos.valor > 0, 'la actividad no ve ningún movimiento');
    assert.ok(d.actividad.unidadesPreparadas.valor > 0, 'no cuenta unidades preparadas');
    assert.ok(d.actividad.unidadesRecibidas.valor > 0, 'no cuenta unidades recibidas');

    // 2. Productividad: las tareas se derivan solas del ledger al abrir el panel.
    assert.ok(d.productividad.length > 0, 'productividad vacía: no se derivaron las tareas');
    assert.equal(d.productividad[0].tareas, d.actividad.ordenesPreparadas.valor);
    assert.ok(d.productividad[0].unidades > 0);

    // 3. Pre-facturación: suma el mes en curso y cuadra con el detalle por cliente.
    assert.equal(d.prefacturacion.periodo, '2026-09');
    assert.ok(d.prefacturacion.total > 0, 'pre-facturación en cero');
    assert.equal(d.prefacturacion.total, d.prefacturacion.porCliente.reduce((t: number, c: any) => t + c.monto, 0));

    // 6. Tiempos de preparación: hay muestras B2C con las órdenes empacadas.
    assert.ok(d.tiempos.muestrasB2C > 0, 'ningún tiempo de preparación medido');
    assert.equal(d.tiempos.ventanaDias, 30);

    // 4. Deadlines: los números del panel cuadran con los que reportó la semilla.
    assert.equal(d.despacho.conCompromiso + d.despacho.sinCompromiso, d.despacho.abiertasTotal);
    assert.equal(d.despacho.aTiempo + d.despacho.atrasadas, d.despacho.conCompromiso);
    assert.equal(d.despacho.atrasadas, semilla.deadlines.vencidas, 'las vencidas del panel no son las sembradas');

    // 5. Precisión: la semilla deja una verificación con diferencia a propósito.
    assert.ok(d.precision.pedidosVerificados > 0, 'no llegó ninguna verificación de empaque');
    assert.equal(d.precision.pedidosConError, 1);
    assert.ok(d.precision.coberturaPct !== null);

    // 7. Ocupación: hay ubicaciones con capacidad y stock guardado en ellas.
    assert.equal(d.ocupacion.unidad, 'unidades');
    assert.ok(d.ocupacion.ubicaciones >= semilla.ubicaciones, 'faltan ubicaciones');
    assert.ok(d.ocupacion.capacidad > 0 && d.ocupacion.usado > 0, 'ocupación vacía');
    assert.equal(d.ocupacion.pct, Math.round((d.ocupacion.usado / d.ocupacion.capacidad) * 1000) / 10);
    const zonas = Object.values(d.ocupacion.porZona) as any[];
    assert.equal(zonas.reduce((t, z) => t + z.usado, 0), d.ocupacion.usado, 'las zonas no suman el total');

    // 8/9/10. Carga, cola por courier y estados: consistentes entre sí.
    assert.ok(d.cargaPorCliente.length >= 1);
    assert.equal(d.cargaPorCliente.reduce((t: number, c: any) => t + c.ordenes, 0), d.despacho.abiertasTotal);
    assert.ok(d.colaPorCourier.length >= 1, 'ninguna orden en cola de courier');
    assert.equal(Object.values(d.ordenesPorEstado).reduce((a: any, b: any) => a + b, 0), semilla.ordenes);

    // 11. Embalaje: la semilla deja un insumo bajo el mínimo para que se vea.
    assert.ok(d.embalaje.length > 0, 'el bloque de embalaje llegó vacío');
    assert.ok(d.embalaje.some((m: any) => m.estado === 'critico' || m.estado === 'bajo'), 'ningún insumo bajo mínimo');
    assert.ok(d.embalaje.every((m: any) => typeof m.stock === 'number' && typeof m.sugerido === 'number'));

    // 12. Excepciones: el agente ve trabajo pendiente y lo reporta acá.
    assert.ok(Array.isArray(d.excepciones));
    assert.ok(d.excepciones.every((e: any) => e.titulo && e.severidad && e.cliente));

    // Nada se cayó silenciosamente: los únicos faltantes aceptables son los que
    // dependen de configuración del cliente, no de que el panel no sepa leer.
    const rotos = (d.faltantes as string[]).filter((x) => ['productividad', 'embalaje', 'excepciones'].includes(x));
    assert.deepEqual(rotos, [], `bloques caídos: ${rotos.join(', ')}`);
  });

  /**
   * La prueba que faltaba: los números de "Actividad operativa" con valores
   * exactos. El panel leía un campo que no existe (`value` en vez de `current`)
   * y mostraba 0 con −100 % en todas las tarjetas sin que nada fallara.
   */
  await test('panel: actividad cuenta el período actual y lo compara con el anterior', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Bodega' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    f.clock.set('2026-09-20T12:00:00.000Z');
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });

    // Período ANTERIOR de la ventana de 7 días: [ahora−14d, ahora−7d).
    f.clock.set('2026-09-09T10:00:00.000Z');
    await f.facade.receive('acme', { sku: 'CAM', qty: 10, locationId: stg.id });
    // Período ACTUAL: [ahora−7d, ahora).
    f.clock.set('2026-09-16T10:00:00.000Z');
    await f.facade.receive('acme', { sku: 'CAM', qty: 30, locationId: stg.id });
    await f.facade.receive('acme', { sku: 'CAM', qty: 5, locationId: stg.id });

    f.clock.set('2026-09-20T12:00:00.000Z');
    const d: any = await f.facade.operationDashboard('op1', { window: '7d' });
    assert.equal(d.actividad.unidadesRecibidas.valor, 35, 'no suma las unidades del período actual');
    assert.equal(d.actividad.unidadesRecibidas.anterior, 10, 'no suma las del período anterior');
    assert.equal(d.actividad.unidadesRecibidas.cambioPct, 250, '35 sobre 10 es +250 %');
    assert.equal(d.actividad.movimientos.valor, 2);
    assert.equal(d.actividad.movimientos.anterior, 1);

    // Otra ventana, otro corte: a 30 días las tres recepciones caen en el actual.
    const m: any = await f.facade.operationDashboard('op1', { window: '30d' });
    assert.equal(m.actividad.unidadesRecibidas.valor, 45);
    assert.equal(m.actividad.unidadesRecibidas.anterior, 0);
    assert.equal(m.actividad.unidadesRecibidas.cambioPct, null, 'sin base de comparación no se inventa un %');

    // Y a 24 horas no hubo nada: cero de verdad, no cero por leer mal el campo.
    const h: any = await f.facade.operationDashboard('op1', { window: '24h' });
    assert.equal(h.actividad.unidadesRecibidas.valor, 0);

    // Rango personalizado: mismo camino, otra consulta.
    const r: any = await f.facade.operationDashboard('op1', { from: '2026-09-15T00:00:00.000Z', to: '2026-09-20T12:00:00.000Z' });
    assert.equal(r.ventana.tipo, 'personalizado');
    assert.equal(r.actividad.unidadesRecibidas.valor, 35, 'el rango personalizado tampoco lee bien el campo');
    assert.equal(r.actividad.movimientos.valor, 2);
  });

  /**
   * El panel filtrado por cliente tiene que recortar TODO, no solo la tabla de
   * órdenes: actividad, pre-facturación y carga incluidas.
   */
  await test('panel: filtrar por cliente recorta todos los bloques, no solo las órdenes', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Bodega' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    await f.facade.createSeller({ id: 'globex', operationId: 'op1', name: 'Globex' });
    f.clock.set('2026-09-20T12:00:00.000Z');
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    for (const sid of ['acme', 'globex']) await f.facade.createSku(sid, { sku: 'CAM', description: 'Camisa' });
    f.clock.set('2026-09-18T10:00:00.000Z');
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });
    await f.facade.receive('globex', { sku: 'CAM', qty: 7, locationId: stg.id });
    f.clock.set('2026-09-20T12:00:00.000Z');

    const todo: any = await f.facade.operationDashboard('op1', { window: '7d' });
    assert.equal(todo.actividad.unidadesRecibidas.valor, 107, 'consolidado debe sumar los dos clientes');
    assert.equal(todo.alcance.clientes, 2);

    const solo: any = await f.facade.operationDashboard('op1', { window: '7d', sellerId: 'globex' });
    assert.equal(solo.alcance.clientes, 1);
    assert.equal(solo.alcance.consolidado, false);
    assert.equal(solo.actividad.unidadesRecibidas.valor, 7, 'el filtro por cliente no recorta la actividad');
    assert.equal(solo.prefacturacion.porCliente.length <= 1, true);
    // La ocupación es de la bodega, no del cliente: sigue contando solo su stock.
    assert.equal(solo.ocupacion.usado, 7);
  });

  /**
   * Reposición de embalaje: el panel tiene que decidir crítico / bajo / ok y
   * cuánto pedir, con el consumo real de los últimos 30 días.
   */
  await test('panel: reposición de embalaje clasifica y sugiere con el consumo real', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Bodega' });
    f.clock.set('2026-09-20T12:00:00.000Z');
    await f.facade.createPackaging('op1', { sku: 'CAJA-M', name: 'Caja mediana', minStock: 100 });
    await f.facade.createPackaging('op1', { sku: 'BOLSA', name: 'Bolsa', minStock: 50 });
    await f.facade.createPackaging('op1', { sku: 'CINTA', name: 'Cinta', minStock: 0 }); // sin mínimo: se avisa

    // Entradas y consumo.
    await f.facade.adjustPackagingStock('op1', 'CAJA-M', 400, 'ana');
    await f.facade.adjustPackagingStock('op1', 'BOLSA', 100, 'ana');
    await f.facade.adjustPackagingStock('op1', 'CINTA', 30, 'ana');
    f.clock.set('2026-09-19T12:00:00.000Z');
    await f.facade.adjustPackagingStock('op1', 'CAJA-M', -340, 'ana'); // queda 60 < 100 → crítico
    await f.facade.adjustPackagingStock('op1', 'CINTA', -12, 'ana');   // consumo sin mínimo
    f.clock.set('2026-09-20T12:00:00.000Z');

    const d: any = await f.facade.operationDashboard('op1', { window: '30d' });
    const byId = Object.fromEntries(d.embalaje.map((m: any) => [m.sku, m]));
    assert.equal(byId['CAJA-M'].stock, 60);
    assert.equal(byId['CAJA-M'].consumo30, 340);
    assert.equal(byId['CAJA-M'].estado, 'critico');
    assert.equal(byId['CAJA-M'].sugerido, 140, 'sugiere llegar al doble del mínimo');
    assert.equal(byId['BOLSA'].stock, 100);
    assert.equal(byId['BOLSA'].estado, 'ok');
    assert.equal(byId['BOLSA'].sugerido, 0);
    // Lo crítico va primero: el panel se lee de arriba hacia abajo.
    assert.equal(d.embalaje[0].sku, 'CAJA-M');
    // Y avisa del insumo sin mínimo en vez de tratarlo como si estuviera bien.
    assert.ok(d.faltantes.some((x: string) => x.startsWith('embalaje:')), 'no avisa del insumo sin mínimo');
  });

  /**
   * Tiempo de preparación: se mide entre ALLOCATED y PACKED, separando B2B de
   * B2C, porque son operaciones distintas y mezclarlas no dice nada.
   */
  await test('panel: mide el tiempo de preparación y separa B2B de B2C', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Bodega' });
    await f.facade.createSeller({ id: 'acme', operationId: 'op1', name: 'ACME' });
    f.clock.set('2026-09-20T08:00:00.000Z');
    const stg = await f.facade.createLocation({ operationId: 'op1', code: 'A-01', zoneType: ZoneType.STORAGE, capacity: 1000 });
    await f.facade.createSku('acme', { sku: 'CAM', description: 'Camisa' });
    await f.facade.receive('acme', { sku: 'CAM', qty: 100, locationId: stg.id });

    async function correr(ext: string, tipo: any, minutos: number) {
      f.clock.set('2026-09-20T09:00:00.000Z');
      const o = await f.facade.createOrder('acme', { externalOrderId: ext, salesChannel: 'web', orderType: tipo, shipTo: { name: 'x' }, lines: [{ sku: 'CAM', qty: 2 }] }, 'ana');
      await f.facade.allocateOrder('acme', o.id, 'ana');
      f.clock.set(new Date(Date.parse('2026-09-20T09:00:00.000Z') + minutos * 60000).toISOString());
      await f.facade.confirmPick('acme', o.id, 'pedro');
      await f.facade.packOrder('acme', o.id, { bultos: 1 }, 'pedro');
    }
    await correr('B2C-1', OrderType.B2C, 20);
    await correr('B2C-2', OrderType.B2C, 40);
    await correr('B2B-1', OrderType.B2B, 180);

    f.clock.set('2026-09-20T14:00:00.000Z');
    const d: any = await f.facade.operationDashboard('op1', { window: '24h' });
    assert.equal(d.tiempos.muestrasB2C, 2);
    assert.equal(d.tiempos.muestrasB2B, 1);
    assert.equal(d.tiempos.b2cMin, 30, 'promedio de 20 y 40 minutos');
    assert.equal(d.tiempos.b2bMin, 180);
  });

  // ---- Ventanas horarias del agente (v106) -----------------------------------

  await test('agenda del agente: la hora es local de la operación, no UTC', () => {
    // 12:00 UTC de un martes de enero son las 09:00 en Santiago (verano, UTC−3).
    const a = localEn('2026-01-13T12:00:00.000Z', 'America/Santiago');
    assert.deepEqual([a.dia, a.min], [2, 9 * 60], 'martes 09:00 en Santiago');
    const b = localEn('2026-01-13T12:00:00.000Z', 'UTC');
    assert.deepEqual([b.dia, b.min], [2, 12 * 60]);
    // Y en pleno invierno austral el desfase es de 3 horas: el horario de verano
    // no se hardcodea, lo resuelve la zona.
    const c = localEn('2026-07-14T12:00:00.000Z', 'America/Santiago');
    assert.equal(c.min, 8 * 60, 'en julio son las 08:00: UTC−4, el horario de verano lo resuelve la zona');
  });

  await test('agenda del agente: dentro, fuera y próxima apertura', () => {
    const s = normalizarSchedule({ activo: true, tz: 'UTC', alcance: 'llm', ventanas: [{ dias: [1, 2, 3, 4, 5], desde: '08:00', hasta: '20:00' }] });
    // Miércoles 10:00 UTC: dentro.
    const dentro = estadoVentana(s, '2026-09-16T10:00:00.000Z');
    assert.equal(dentro.dentro, true);
    assert.equal(dentro.proximaAperturaIso, null);
    // Miércoles 21:00: fuera, y abre el jueves a las 08:00.
    const fuera = estadoVentana(s, '2026-09-16T21:00:00.000Z');
    assert.equal(fuera.dentro, false);
    assert.equal((fuera.proximaAperturaIso || '').slice(0, 16), '2026-09-17T08:00');
    // Sábado: fuera todo el día; la próxima apertura es el lunes.
    const finde = estadoVentana(s, '2026-09-19T12:00:00.000Z');
    assert.equal(finde.dentro, false);
    assert.equal((finde.proximaAperturaIso || '').slice(0, 16), '2026-09-21T08:00', 'debe saltar el domingo y dar la hora exacta');
  });

  await test('agenda del agente: una ventana puede cruzar la medianoche', () => {
    // Turno de noche: viernes 22:00 → 06:00 del sábado.
    const s = normalizarSchedule({ activo: true, tz: 'UTC', ventanas: [{ dias: [5], desde: '22:00', hasta: '06:00' }] });
    assert.equal(estadoVentana(s, '2026-09-18T23:30:00.000Z').dentro, true, 'viernes 23:30');
    assert.equal(estadoVentana(s, '2026-09-19T03:00:00.000Z').dentro, true, 'sábado 03:00 sigue siendo el turno del viernes');
    assert.equal(estadoVentana(s, '2026-09-19T07:00:00.000Z').dentro, false, 'sábado 07:00 ya cerró');
    assert.equal(estadoVentana(s, '2026-09-18T21:00:00.000Z').dentro, false, 'viernes 21:00 todavía no abre');
  });

  await test('agenda del agente: varias ventanas en el mismo día', () => {
    const s = normalizarSchedule({ activo: true, tz: 'UTC', ventanas: [
      { dias: [1, 2, 3, 4, 5], desde: '09:00', hasta: '13:00' },
      { dias: [1, 2, 3, 4, 5], desde: '15:00', hasta: '19:00' },
    ] });
    assert.equal(estadoVentana(s, '2026-09-16T10:00:00.000Z').dentro, true);
    assert.equal(estadoVentana(s, '2026-09-16T14:00:00.000Z').dentro, false, 'la hora de colación queda afuera');
    assert.equal(estadoVentana(s, '2026-09-16T16:00:00.000Z').dentro, true);
    const almuerzo = estadoVentana(s, '2026-09-16T14:00:00.000Z');
    assert.equal((almuerzo.proximaAperturaIso || '').slice(11, 16), '15:00', 'la hora exacta, no el primer paso del barrido');
  });

  await test('agenda del agente: valida lo que se guarda y no inventa defaults peligrosos', () => {
    assert.equal(estadoVentana(SCHEDULE_DEFAULT, '2026-09-16T03:00:00.000Z').dentro, true, 'agenda apagada = sin restricción');
    // Activa y vacía no significa "siempre": se rechaza al guardar.
    assert.throws(() => normalizarSchedule({ activo: true, ventanas: [] }), /no correría nunca/);
    assert.throws(() => normalizarSchedule({ activo: true, ventanas: [{ dias: [1], desde: '25:00', hasta: '20:00' }] }), /Hora inválida/);
    assert.throws(() => normalizarSchedule({ activo: true, ventanas: [{ dias: [], desde: '08:00', hasta: '20:00' }] }), /días/);
    assert.throws(() => normalizarSchedule({ activo: true, ventanas: [{ dias: [1], desde: '08:00', hasta: '08:00' }] }), /misma hora/);
    assert.throws(() => normalizarSchedule({ tz: 'Marte/Olympus' }), /Zona horaria desconocida/);
    // Días repetidos o fuera de rango se limpian en vez de reventar.
    const s = normalizarSchedule({ activo: true, tz: 'UTC', ventanas: [{ dias: [3, 1, 1, 9, -2], desde: '08:00', hasta: '20:00' }] });
    assert.deepEqual(s.ventanas[0].dias, [1, 3]);
    assert.equal(s.alcance, 'llm', 'por defecto solo se pausa el LLM, no el agente entero');
    assert.match(resumenSchedule(s), /Lun, Mié 08:00–20:00/);
  });

  /**
   * Lo que de verdad importa: que el CICLO respete la ventana. La prueba de
   * dominio dice si estamos dentro; esta dice si el agente hace caso.
   */
  await test('agenda del agente: el ciclo consulta al LLM solo dentro de la ventana', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Bodega' });
    await f.facade.updateAgentSettings('op1', {
      llmPlanning: true, paused: false,
      agenda: { activo: true, tz: 'UTC', alcance: 'llm', ventanas: [{ dias: [1, 2, 3, 4, 5], desde: '08:00', hasta: '20:00' }] },
    } as any, 'ana');

    // Domingo a las 03:00 UTC: fuera de toda ventana.
    f.clock.set('2026-09-20T03:00:00.000Z');
    const est0: any = await f.facade.agentStatus('op1');
    assert.equal(est0.ventana.dentro, false);
    assert.equal(est0.ventana.proximaAperturaIso.slice(0, 16), '2026-09-21T08:00', 'abre el lunes a las 08:00');
    const fuera: any = await f.facade.runAgentCycle('op1', { by: 'scheduler' });
    assert.equal(fuera.llm.ran, false, 'no debe consultar al LLM fuera de hora');
    assert.equal(fuera.llm.error, 'fuera de la ventana horaria');
    assert.ok(fuera.barrido, 'el barrido de reglas SÍ sigue corriendo: es gratis y cuida la operación');

    // Miércoles a las 10:00 UTC: dentro. Ahora sí intenta (falla por falta de
    // credencial, que es otra cosa, pero llegó a intentarlo).
    f.clock.set('2026-09-16T10:00:00.000Z');
    const est1: any = await f.facade.agentStatus('op1');
    assert.equal(est1.ventana.dentro, true);
    const dentro: any = await f.facade.runAgentCycle('op1', { by: 'scheduler' });
    assert.notEqual(dentro.llm.error, 'fuera de la ventana horaria', 'dentro de ventana no debe bloquearse por horario');

    // "Evaluar ahora" lo pide una persona: el horario no le aplica.
    f.clock.set('2026-09-20T03:00:00.000Z');
    const aMano: any = await f.facade.runAgentCycle('op1', { force: true, by: 'ana' });
    assert.notEqual(aMano.llm.error, 'fuera de la ventana horaria', 'el botón manual salta la agenda');
  });

  await test('agenda del agente: con alcance "todo" el ciclo completo no arranca fuera de hora', async () => {
    const f = buildFacade();
    await f.facade.createOperation({ id: 'op1', name: 'Bodega' });
    await f.facade.updateAgentSettings('op1', {
      llmPlanning: false,
      agenda: { activo: true, tz: 'UTC', alcance: 'todo', ventanas: [{ dias: [1], desde: '08:00', hasta: '09:00' }] },
    } as any, 'ana');
    f.clock.set('2026-09-20T03:00:00.000Z'); // domingo
    const r: any = await f.facade.runAgentCycle('op1', { by: 'scheduler' });
    assert.equal(r.skipped, 'fuera de la ventana horaria');
    assert.equal(r.barrido, undefined, 'con alcance "todo" ni siquiera barre reglas');

    // Y la agenda sobrevive a guardar otros ajustes sin tocarla.
    const s2: any = await f.facade.updateAgentSettings('op1', { maxLlmCallsPerDay: 42 } as any, 'ana');
    assert.equal(s2.agenda.ventanas.length, 1, 'guardar otro campo no borra la agenda');
    assert.equal(s2.agenda.alcance, 'todo');
  });

  /**
   * El diario del panel arma una TABLA de acciones por ciclo. Eso solo funciona
   * si cada entrada trae la carga estructurada `accion`; si alguien vuelve a
   * escribir solo la frase en prosa, la tabla se vacía sin que nada falle.
   */
  await test('diario del agente: cada acción queda tabulable, no solo narrada', async () => {
    const f = buildFacade();
    f.clock.set('2026-09-17T12:00:00.000Z');
    await f.facade.createOperation({ id: 'op1', name: 'Bodega' });
    await f.facade.seedAgentSandbox('op1', 'ana');
    await f.facade.updateAgentSettings('op1', { autonomyLevel: 3, shadowMode: false, paused: false } as any, 'ana');
    await f.facade.updateAgentRule('op1', 'operario_inactivo', { enabled: true, actionType: 'execute', actionMode: 'directo', cooldownMin: 0 }, 'ana');

    f.clock.set('2026-09-17T12:05:00.000Z');
    const ciclo: any = await f.facade.runAgentCycle('op1', { force: true, by: 'ana' });
    assert.ok(ciclo.barrido.ejecutadas > 0, 'el ciclo no ejecutó nada: la prueba no prueba nada');

    const diario: any[] = await f.facade.agentJournalList('op1', { kind: null, limit: 60 });
    const conAccion = diario.filter((e) => e.data && (e.data as any).accion);
    assert.ok(conAccion.length > 0, 'ninguna entrada trae la carga estructurada `accion`');
    const a = (conAccion[0].data as any).accion;
    for (const campo of ['estado', 'etiqueta', 'regla', 'herramienta', 'resultado']) {
      assert.ok(a[campo] != null && a[campo] !== '', `la acción no trae "${campo}"; la columna quedaría vacía`);
    }
    assert.ok(['ejecutada', 'propuesta', 'sombra', 'error'].includes(a.estado), `estado desconocido: ${a.estado}`);
    assert.equal(a.estado, 'ejecutada');

    // Y en modo sombra la misma acción queda marcada como sombra, no como hecha.
    await f.facade.updateAgentSettings('op1', { shadowMode: true } as any, 'ana');
    await f.facade.seedAgentSandbox('op1', 'ana'); // material nuevo: el dedupe tapa la alerta anterior
    f.clock.set('2026-09-17T12:10:00.000Z');
    await f.facade.runAgentCycle('op1', { force: true, by: 'ana' });
    const d2: any[] = await f.facade.agentJournalList('op1', { kind: null, limit: 60 });
    const sombra = d2.map((e) => e.data && (e.data as any).accion).filter(Boolean).find((x: any) => x.estado === 'sombra');
    assert.ok(sombra, 'el modo sombra no dejó una acción marcada como sombra');
    assert.equal(sombra.herramienta, 'liberar_inactivos');
  });

  // ---- Dashboard AI (v101) ---------------------------------------------------

  await test('dashboard AI: valida lo que propone el modelo y rechaza lo inventado', () => {
    const tools = ['listar_ordenes', 'riesgo_quiebre'];
    const id = (() => { let n = 0; return () => `w${++n}`; })();

    // Una herramienta que no existe no entra, por más que el modelo insista.
    const falso = validarWidget({ tipo: 'kpi', titulo: 'X', source: { tool: 'tabla_magica' } }, tools, id);
    assert.equal(falso.ok, false);
    assert.match((falso as any).error, /no existe o no es de lectura/);

    // Un tipo de widget inventado tampoco.
    assert.equal(validarWidget({ tipo: 'holograma', titulo: 'X' }, tools, id).ok, false);

    // Un widget válido se normaliza: tamaños dentro de rango y campos limpios.
    const bueno = validarWidget({
      tipo: 'tabla', titulo: 'Órdenes', ancho: 99, alto: 1,
      source: { tool: 'listar_ordenes', path: 'items' },
      transform: { agg: 'inventada', limit: 9999, filter: { field: 'estado', op: '=', value: 'PACKED' } },
      display: { columnas: [{ campo: 'orden' }, { campo: '' }], color: 'javascript:alert(1)' },
    }, tools, id);
    assert.equal(bueno.ok, true);
    const w = (bueno as any).widget;
    assert.equal(w.ancho, 12, 'el ancho se recorta a la grilla');
    assert.equal(w.alto, 2, 'el alto tiene mínimo');
    assert.equal(w.transform.agg, undefined, 'una agregación inventada se descarta');
    assert.equal(w.transform.limit, 500, 'el límite se acota');
    assert.equal(w.display.columnas.length, 1, 'las columnas sin campo se caen');
    assert.equal(w.display.color, undefined, 'un color que no es color no pasa');

    // Un widget de texto sin texto no sirve de nada.
    assert.equal(validarWidget({ tipo: 'texto', titulo: 'Nota' }, tools, id).ok, false);
  });

  await test('dashboard AI: el patch aplica lo bueno, explica lo malo y acomoda solo', () => {
    const tools = ['listar_ordenes', 'riesgo_quiebre'];
    const id = (() => { let n = 0; return () => `w${++n}`; })();
    const base = {
      id: 'd1', operationId: 'op1', ownerId: 'ana', nombre: 'Mi tablero',
      widgets: [], version: 1, createdAt: '2026-09-17T12:00:00.000Z', updatedAt: '2026-09-17T12:00:00.000Z',
    };
    const r1 = aplicarPatch(base as any, [
      { op: 'agregar', widget: { tipo: 'kpi', titulo: 'Órdenes', ancho: 3, alto: 3, source: { tool: 'listar_ordenes' } } },
      { op: 'agregar', widget: { tipo: 'tabla', titulo: 'Quiebres', ancho: 9, alto: 7, source: { tool: 'riesgo_quiebre' } } },
      { op: 'agregar', widget: { tipo: 'kpi', titulo: 'Humo', source: { tool: 'no_existe' } } },
    ], tools, id, '2026-09-17T13:00:00.000Z');
    assert.equal(r1.aplicados.length, 2);
    assert.equal(r1.rechazados.length, 1);
    assert.equal(r1.dashboard.version, 2, 'la versión sube una vez, no una por operación');
    // Se acomodan lado a lado, no apilados: 3 + 9 = 12 columnas.
    assert.deepEqual(r1.dashboard.widgets.map((w) => [w.x, w.y, w.ancho]), [[0, 0, 3], [3, 0, 9]]);

    // Modificar respeta el id y vuelve a validar.
    const wid = r1.dashboard.widgets[0].id;
    const r2 = aplicarPatch(r1.dashboard, [{ op: 'modificar', id: wid, widget: { titulo: 'Órdenes del día' } }], tools, id, '2026-09-17T14:00:00.000Z');
    assert.equal(r2.dashboard.widgets[0].titulo, 'Órdenes del día');
    assert.equal(r2.dashboard.widgets[0].id, wid);

    // Mover y eliminar; y una operación sobre algo que no existe se explica.
    const r3 = aplicarPatch(r2.dashboard, [
      { op: 'mover', id: wid, x: 6, y: 2, ancho: 6, alto: 4 },
      { op: 'eliminar', id: 'fantasma' },
    ], tools, id, '2026-09-17T15:00:00.000Z');
    assert.deepEqual([r3.dashboard.widgets[0].x, r3.dashboard.widgets[0].y], [6, 2]);
    assert.match(r3.rechazados[0], /no existe el widget/);

    // Sin nada aplicado, la versión NO sube (no hay cambio que versionar).
    const r4 = aplicarPatch(r3.dashboard, [{ op: 'eliminar', id: 'fantasma' }], tools, id, '2026-09-17T16:00:00.000Z');
    assert.equal(r4.dashboard.version, r3.dashboard.version);
  });

  await test('dashboard AI: hueco libre y transformación de los datos de la herramienta', () => {
    // El primer hueco se busca de arriba a abajo y de izquierda a derecha.
    const ws: any[] = [{ id: 'a', x: 0, y: 0, ancho: 6, alto: 4 }];
    assert.deepEqual(primerHueco(ws as any, 6, 4), { x: 6, y: 0 }, 'al lado si cabe');
    assert.deepEqual(primerHueco(ws as any, 12, 3), { x: 0, y: 4 }, 'abajo si no cabe al lado');

    const w: any = { tipo: 'barras', source: { path: 'items' }, transform: { groupBy: 'cliente', field: 'unidades', agg: 'suma', sortBy: 'valor', sortDir: 'desc' } };
    const bruto = { items: [
      { cliente: 'ACME', unidades: 10 }, { cliente: 'Globex', unidades: 4 }, { cliente: 'ACME', unidades: 5 },
    ] };
    const r = transformar(bruto, w);
    assert.deepEqual(r.filas.map((f: any) => [f.clave, f.valor]), [['ACME', 15], ['Globex', 4]]);

    // Un KPI que cuenta filas.
    const kpi: any = { tipo: 'kpi', source: { path: 'items' }, transform: { agg: 'conteo' } };
    assert.equal(transformar(bruto, kpi).valor, 3);

    // Un objeto de conteos {clave: número} se vuelve lista, que es como se dibuja.
    const estados = transformar({ RECEIVED: 2, PACKED: 5 }, { tipo: 'barras', source: {} } as any);
    assert.deepEqual(estados.filas, [{ clave: 'RECEIVED', valor: 2 }, { clave: 'PACKED', valor: 5 }]);

    // Si la ruta no existe pero la respuesta trae UNA sola lista, se usa esa:
    // el modelo le erró al nombre del campo, no a la intención.
    const rescate = transformar({ total: 3, alertas: [{ x: 1 }, { x: 2 }] }, { tipo: 'tabla', source: { path: 'abiertas' } } as any);
    assert.equal(rescate.filas.length, 2);

    // Filtro simple.
    const filtrado = transformar(bruto, { tipo: 'tabla', source: { path: 'items' }, transform: { filter: { field: 'cliente', op: '=', value: 'ACME' } } } as any);
    assert.equal(filtrado.filas.length, 2);
  });

  await test('dashboard AI: las tres plantillas se arman sin widgets encimados', () => {
    const tools = [
      'panel_operacion', 'flujo_mercaderia', 'serie_diaria', 'inventario_por_cliente',
      'trabajo_pendiente', 'ordenes_por_vencer', 'ocupacion_ubicaciones', 'alertas_activas',
    ];
    assert.deepEqual(PLANTILLAS.map((p) => p.id), ['torre', 'premium', 'galeria']);
    for (const p of PLANTILLAS) {
      const id = (() => { let n = 0; return () => `w${++n}`; })();
      const base: any = { id: 'd1', operationId: 'op1', ownerId: 'ana', nombre: 'x', widgets: [], version: 1, createdAt: 'a', updatedAt: 'a' };
      const r = aplicarPatch(base, opsDePlantilla(p), tools, id, '2026-09-17T12:00:00.000Z');
      assert.equal(r.rechazados.length, 0, `${p.id}: ${r.rechazados.join(' · ')}`);
      assert.equal(r.dashboard.widgets.length, p.widgets.length, `${p.id}: faltan widgets`);
      assert.equal(r.dashboard.tema, p.tema, `${p.id}: tema`);
      // Ningún par de widgets puede ocupar la misma celda de la grilla.
      const ws = r.dashboard.widgets;
      for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
        const a = ws[i], b = ws[j];
        const chocan = a.x < b.x + b.ancho && b.x < a.x + a.ancho && a.y < b.y + b.alto && b.y < a.y + a.alto;
        assert.equal(chocan, false, `${p.id}: "${a.titulo}" se encima con "${b.titulo}"`);
      }
      // Y nadie se sale de las 12 columnas.
      for (const w of ws) assert.ok(w.x + w.ancho <= 12, `${p.id}: "${w.titulo}" se sale de la grilla`);
    }
  });

  await test('dashboard AI: el tema se cambia y una plantilla inventada se rechaza', () => {
    const id = (() => { let n = 0; return () => `w${++n}`; })();
    const base: any = { id: 'd1', operationId: 'op1', ownerId: 'ana', nombre: 'x', widgets: [], version: 1, createdAt: 'a', updatedAt: 'a' };
    const r = aplicarPatch(base, [{ op: 'tema', tema: 'torre' } as any], [], id, 'a');
    assert.equal(r.dashboard.tema, 'torre');
    const r2 = aplicarPatch(r.dashboard, [{ op: 'tema', tema: 'neón' } as any, { op: 'plantilla', plantilla: 'inexistente' } as any], [], id, 'a');
    assert.equal(r2.rechazados.length, 2);
    assert.match(r2.rechazados[0], /tema desconocido/);
    assert.match(r2.rechazados[1], /no existe la plantilla/);
    assert.equal(r2.dashboard.tema, 'torre', 'el tema válido anterior se conserva');
  });

  // ---- Resumen --------------------------------------------------------------
  console.log(`\n${passed} pasaron, ${failures.length} fallaron\n`);
  if (failures.length > 0) process.exit(1);
}

run();
