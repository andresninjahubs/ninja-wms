/**
 * Seed de demostración (requiere PERSISTENCE=prisma y la base migrada).
 * Crea dos sellers que comparten ubicaciones y usan el MISMO código de SKU,
 * para mostrar el aislamiento multi-tenant con datos reales.
 *
 * Ejecutar:  npm run seed
 */
process.env.PERSISTENCE = 'prisma';

import { CycleCountStrategy, PickingStrategy, RotationClass, ZoneType } from '../src/domain/types';
import { createWmsContext } from '../src/infra/context';

async function main() {
  const { facade, dispose } = await createWmsContext();

  // Ubicaciones compartidas. Las de almacenaje llevan capacidad y cercanía a picking
  // (pickRank: 1 = más cerca) para alimentar el motor de guardado caótico dirigido.
  const recv = await facade.createLocation({ code: 'RECV-01', zoneType: ZoneType.RECEIVING });
  const a1 = await facade.createLocation({ code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 200, pickRank: 1 });
  await facade.createLocation({ code: 'B-05-2-C', zoneType: ZoneType.STORAGE, capacity: 200, pickRank: 2 });
  await facade.createLocation({ code: 'C-09-3-D', zoneType: ZoneType.STORAGE, capacity: 200, pickRank: 3 });

  // Seller 1 — opera con FEFO (vence antes, primero en salir) y conteo ABC.
  const acme = await facade.createSeller({
    id: 'acme',
    name: 'ACME Retail',
    pickingStrategy: PickingStrategy.FEFO,
    cycleCountStrategy: CycleCountStrategy.ABC,
  });
  await facade.createSku('acme', { sku: 'CAM-AZ-M', description: 'Camisa azul talla M', barcode: '7801234567890', rotationClass: RotationClass.A });
  // La unidad (EAN) se auto-registró; agregamos la caja master (DUN, 1 caja = 12 unidades).
  await facade.registerPack('acme', { sku: 'CAM-AZ-M', code: 'CASE', barcode: '17801234567897', factor: 12, label: 'Caja master x12' });
  // SKU por lote con vencimiento: L-OLD entra antes pero vence después; L-NEW al revés.
  await facade.createSku('acme', { sku: 'MED-500', description: 'Medicamento 500mg', rotationClass: RotationClass.A, lotControlled: true });
  await facade.receive('acme', { sku: 'MED-500', qty: 30, locationId: a1.id, lot: 'L-OLD', expiry: '2027-12-31T00:00:00.000Z', reference: 'ASN-1003' });
  await facade.receive('acme', { sku: 'MED-500', qty: 30, locationId: a1.id, lot: 'L-NEW', expiry: '2026-06-30T00:00:00.000Z', reference: 'ASN-1004' });
  await facade.receive('acme', { sku: 'CAM-AZ-M', qty: 50, locationId: recv.id, reference: 'ASN-1001' });
  await facade.putaway('acme', { sku: 'CAM-AZ-M', qty: 40, fromLocationId: recv.id, toLocationId: a1.id });

  // Seller 2 — mismo código de SKU, misma ubicación física, stock totalmente separado
  const globex = await facade.createSeller({ id: 'globex', name: 'Globex SpA' });
  await facade.createSku('globex', { sku: 'CAM-AZ-M', description: 'Producto distinto de Globex', barcode: '9990000000001' });
  await facade.receive('globex', { sku: 'CAM-AZ-M', qty: 12, locationId: recv.id, reference: 'ASN-2001' });

  const acmeStock = await facade.getStock({ sellerId: 'acme' });
  const globexStock = await facade.getStock({ sellerId: 'globex' });

  console.log('Seed listo.');
  console.log('  ACME  :', acmeStock.map((b) => `${b.sku}@${b.locationId}=${b.qty}`).join(', '));
  console.log('  Globex:', globexStock.map((b) => `${b.sku}@${b.locationId}=${b.qty}`).join(', '));

  await dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
