#!/usr/bin/env node
/* Enriquece los datos demo (servidor en memoria) para que ningún tutorial se grabe
 * sobre una pantalla vacía: cola de preparación, devoluciones, embalajes, auditoría IA,
 * conteo cíclico. Idempotente a efectos prácticos (se puede correr más de una vez).
 *
 * Uso: node scripts/prepare-demo-for-videos.js [--base=http://localhost:3000]
 */
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const BASE = args.base || 'http://localhost:3000';
const OP = 'op-ninja', SELLER = 'acme';
let token = null;
async function api(path, opts = {}) {
  const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const t = await r.text(); let d = {}; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(path + ' → ' + r.status + ' ' + (d.detail && (d.detail.message || d.detail) || t).toString().slice(0, 160));
  return d;
}
const step = async (label, fn) => { process.stdout.write('• ' + label + ' … '); try { const r = await fn(); console.log(r || 'ok'); } catch (e) { console.log('omitido (' + e.message + ')'); } };

(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { email: 'ana@ninjahubs.cl', password: 'demo1234' } });
  token = login.token;
  const orders = await api(`/sellers/${SELLER}/orders`);

  await step('Cola de preparación: reservar 5 órdenes ingresadas', async () => {
    const news = orders.filter(o => o.status === 'RECEIVED').slice(0, 5); let n = 0;
    for (const o of news) { try { await api(`/sellers/${SELLER}/orders/${o.id}/allocate`, { method: 'POST' }); n++; } catch { } }
    return n + ' reservadas';
  });

  await step('Devoluciones: crear 2 y procesar 1 (stock / merma / cuarentena)', async () => {
    const existing = await api(`/sellers/${SELLER}/returns`); if (existing.length >= 2) return 'ya existen';
    const shipped = orders.filter(o => o.status === 'SHIPPED' && o.externalOrderId).slice(0, 2);
    const created = [];
    for (const o of shipped) created.push(await api(`/sellers/${SELLER}/returns`, { method: 'POST', body: { originalOrderRef: o.externalOrderId, reason: 'Cliente cambió de opinión' } }));
    const r = created[0]; const lines = (r.lines || []).map((l, i) => ({ sku: l.sku, toStock: Math.max(0, (l.qty || l.expectedQty || 1) - 1), toMerma: i === 0 ? 1 : 0, toQuarantine: 0 }));
    if (lines.length) await api(`/sellers/${SELLER}/returns/${r.id}/process`, { method: 'POST', body: { lines, close: true } });
    return created.length + ' creadas';
  });

  await step('Embalajes: 3 insumos con stock', async () => {
    const list = await api(`/packaging?operationId=${OP}`); if (list.length) return 'ya existen';
    const items = [{ sku: 'CAJA-S', name: 'Caja cartón S (20x15x10)', barcode: '7801234000011', unitPrice: 320 }, { sku: 'CAJA-M', name: 'Caja cartón M (30x25x15)', barcode: '7801234000028', unitPrice: 480 }, { sku: 'BOLSA-C', name: 'Bolsa courier 35x45', barcode: '7801234000035', unitPrice: 150 }];
    for (const it of items) { await api('/packaging', { method: 'POST', body: { operationId: OP, ...it } }); await api(`/packaging/${it.sku}/receive?operationId=${OP}`, { method: 'POST', body: { qty: it.sku === 'BOLSA-C' ? 800 : 350 } }); }
    return '3 creados';
  });

  await step('Auditoría IA: sugerencia de guardado seguida', async () => {
    const locs = await api(`/operations/${OP}/locations`); const recv = locs.find(l => l.zoneType === 'RECEIVING');
    const inv = await api(`/sellers/${SELLER}/inventory`); const row = inv.find(r => r.locationId === recv.id && r.state === 'AVAILABLE' && r.qty >= 10);
    if (!row) return 'sin stock en recepción';
    const sugs = await api(`/sellers/${SELLER}/putaway-suggestions?sku=${encodeURIComponent(row.sku)}&qty=10`);
    if (!sugs.length) return 'sin sugerencias';
    await api(`/sellers/${SELLER}/putaway`, { method: 'POST', body: { sku: row.sku, qty: 10, fromLocationId: recv.id, toLocationId: sugs[0].locationId, lot: row.lot || undefined } });
    return row.sku + ' → ' + sugs[0].locationCode;
  });

  await step('Conteo cíclico: ejecutar 1 conteo (para la exactitud en Reportes)', async () => {
    const plan = await api(`/sellers/${SELLER}/cycle-counts/plan`); const t = plan.find(p => p.kind === 'LOCATION'); if (!t) return 'sin tareas';
    const inv = await api(`/sellers/${SELLER}/inventory`); const rows = inv.filter(r => r.locationId === t.ref && r.state === 'AVAILABLE');
    if (!rows.length) return 'ubicación vacía';
    const counted = rows.map((r, i) => ({ sku: r.sku, lot: r.lot || null, countedQty: i === 0 ? Math.max(0, r.qty - 1) : r.qty }));
    await api(`/sellers/${SELLER}/cycle-counts`, { method: 'POST', body: { locationId: t.ref, counted } });
    return t.label;
  });

  await step('Agente: barrido de reglas', async () => { const r = await api('/agent/sweep', { method: 'POST', body: { operationId: OP } }); return JSON.stringify(r).slice(0, 80); });
  console.log('Listo.');
})().catch(e => { console.error(e.message); process.exit(1); });
