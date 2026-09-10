#!/usr/bin/env bash
# Demo del corte vertical contra un WMS corriendo en http://localhost:3000
# Uso:  ./demo.sh
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
j() { curl -s -H 'Content-Type: application/json' "$@"; echo; }

echo "== Health =="
j "$BASE/health"

echo "== Crear ubicaciones compartidas =="
RECV=$(curl -s -H 'Content-Type: application/json' -d '{"code":"RECV-01","zoneType":"RECEIVING"}' "$BASE/locations" | sed -E 's/.*"id":"([^"]+)".*/\1/')
STORAGE=$(curl -s -H 'Content-Type: application/json' -d '{"code":"A-03-2-B","zoneType":"STORAGE"}' "$BASE/locations" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "RECV=$RECV  STORAGE=$STORAGE"

echo "== Crear seller ACME y su SKU =="
j -d '{"id":"acme","name":"ACME Retail"}' "$BASE/sellers"
j -d '{"sku":"CAM-AZ-M","description":"Camisa azul M","barcode":"7801234567890"}' "$BASE/sellers/acme/skus"

echo "== Recepción de 50 unidades =="
j -d "{\"sku\":\"CAM-AZ-M\",\"qty\":50,\"locationId\":\"$RECV\",\"reference\":\"ASN-1001\"}" "$BASE/sellers/acme/inbounds"

echo "== Guardado de 40 unidades a almacenaje =="
j -d "{\"sku\":\"CAM-AZ-M\",\"qty\":40,\"fromLocationId\":\"$RECV\",\"toLocationId\":\"$STORAGE\"}" "$BASE/sellers/acme/putaway"

echo "== Stock de ACME (debe sumar 50: 10 en RECV + 40 en almacenaje) =="
j "$BASE/sellers/acme/inventory?sku=CAM-AZ-M"

echo "== Seller Globex con el MISMO código de SKU, stock separado =="
j -d '{"id":"globex","name":"Globex SpA"}' "$BASE/sellers"
j -d '{"sku":"CAM-AZ-M","description":"Otro producto"}' "$BASE/sellers/globex/skus"
j -d "{\"sku\":\"CAM-AZ-M\",\"qty\":12,\"locationId\":\"$RECV\"}" "$BASE/sellers/globex/inbounds"
echo "-- Stock Globex (debe ser 12, sin mezclarse con ACME) --"
j "$BASE/sellers/globex/inventory"

echo "== Orden de venta desde el OMS (con canal) + reserva inmediata =="
j -d "{\"externalOrderId\":\"ML-99887766\",\"salesChannel\":\"mercadolibre\",\"orderType\":\"b2c\",\"shipTo\":{\"name\":\"Juan Pérez\",\"comuna\":\"Providencia\"},\"lines\":[{\"sku\":\"CAM-AZ-M\",\"qty\":15,\"unit\":\"each\"}]}" "$BASE/sellers/acme/orders?allocate=true"
echo "-- Stock ACME: parte pasó a RESERVED (disponible = físico − reservado) --"
j "$BASE/sellers/acme/inventory?sku=CAM-AZ-M"

echo "== Intento de orden por más de lo disponible (debe rechazar con 409) =="
curl -s -o /dev/null -w "HTTP %{http_code}\n" -H 'Content-Type: application/json' \
  -d '{"externalOrderId":"ML-X","salesChannel":"web","shipTo":{"name":"x"},"lines":[{"sku":"CAM-AZ-M","qty":9999}]}' \
  "$BASE/sellers/acme/orders?allocate=true"

echo "== Ciclo completo: pick list -> picking -> despacho =="
OID=$(curl -s -H 'Content-Type: application/json' -d '{"externalOrderId":"ML-CICLO","salesChannel":"shopify","orderType":"b2c","shipTo":{"name":"Ana"},"lines":[{"sku":"CAM-AZ-M","qty":5,"unit":"each"}]}' "$BASE/sellers/acme/orders?allocate=true" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "Orden $OID"
echo "-- Pick list --"; j "$BASE/sellers/acme/orders/$OID/picklist"
echo "-- Confirmar picking --"; curl -s -X POST "$BASE/sellers/acme/orders/$OID/pick" | sed -E 's/.*"status":"([^"]+)".*/status: \1/'; echo
echo "-- Despachar (B2C) --"; j -X POST -d '{"carrier":"chilexpress","trackingNumber":"CX-777"}' "$BASE/sellers/acme/orders/$OID/ship"

echo "== Guardado caótico dirigido: ¿dónde guardar? =="
jid(){ sed -E 's/.*"id":"([^"]+)".*/\1/'; }
curl -s -H 'Content-Type: application/json' -d '{"code":"A-01-1-A","zoneType":"STORAGE","capacity":120,"pickRank":1}' "$BASE/locations" >/dev/null
curl -s -H 'Content-Type: application/json' -d '{"code":"B-05-2-C","zoneType":"STORAGE","capacity":120,"pickRank":2}' "$BASE/locations" >/dev/null
curl -s -H 'Content-Type: application/json' -d '{"code":"C-09-3-D","zoneType":"STORAGE","capacity":120,"pickRank":3}' "$BASE/locations" >/dev/null
curl -s -H 'Content-Type: application/json' -d '{"sku":"ROT-A","description":"Producto alta rotacion","rotationClass":"A"}' "$BASE/sellers/acme/skus" >/dev/null
echo "SKU clase A -> el motor prioriza la ubicación más cercana a picking:"
j "$BASE/sellers/acme/putaway-suggestions?sku=ROT-A&qty=10"

echo "== Estrategia por seller (FEFO) + conteo cíclico =="
jid2(){ sed -E 's/.*"id":"([^"]+)".*/\1/'; }
SL=$(curl -s -H 'Content-Type: application/json' -d '{"code":"F-01-1-A","zoneType":"STORAGE","capacity":200,"pickRank":1}' "$BASE/locations" | jid2)
curl -s -H 'Content-Type: application/json' -d '{"id":"farma","name":"Farma","pickingStrategy":"FEFO","cycleCountStrategy":"ABC"}' "$BASE/sellers" >/dev/null
curl -s -H 'Content-Type: application/json' -d '{"sku":"MED-500","description":"Medicamento","lotControlled":true,"rotationClass":"A"}' "$BASE/sellers/farma/skus" >/dev/null
curl -s -H 'Content-Type: application/json' -d "{\"sku\":\"MED-500\",\"qty\":20,\"locationId\":\"$SL\",\"lot\":\"L-OLD\",\"expiry\":\"2027-12-31T00:00:00.000Z\"}" "$BASE/sellers/farma/inbounds" >/dev/null
curl -s -H 'Content-Type: application/json' -d "{\"sku\":\"MED-500\",\"qty\":20,\"locationId\":\"$SL\",\"lot\":\"L-NEW\",\"expiry\":\"2026-06-30T00:00:00.000Z\"}" "$BASE/sellers/farma/inbounds" >/dev/null
OID=$(curl -s -H 'Content-Type: application/json' -d '{"externalOrderId":"FE-1","salesChannel":"web","shipTo":{"name":"x"},"lines":[{"sku":"MED-500","qty":5}]}' "$BASE/sellers/farma/orders?allocate=true" | jid2)
echo "FEFO reserva del lote que vence antes (esperado L-NEW):"
curl -s "$BASE/sellers/farma/orders/$OID" | python3 -c "import sys,json;print('  ->',[a['lot'] for a in json.load(sys.stdin)['lines'][0]['allocations']])"
echo "Conteo de $SL (cuento L-OLD=18 -> faltan 2):"
j -X POST -d "{\"locationId\":\"$SL\",\"counted\":[{\"sku\":\"MED-500\",\"lot\":\"L-OLD\",\"countedQty\":18},{\"sku\":\"MED-500\",\"lot\":\"L-NEW\",\"countedQty\":15}]}" "$BASE/sellers/farma/cycle-counts"

echo "== Usuarios, roles y auditoría =="
A='-H x-user-id:admin'
echo "-- Admin crea un operario --"
OP=$(curl -s $A -H 'Content-Type: application/json' -d '{"name":"Pedro","email":"pedro@nh.cl","role":"OPERATOR"}' "$BASE/users" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "operario=$OP"
echo "-- Operario recibe (permitido); el movimiento queda firmado por él --"
curl -s -H "x-user-id:$OP" -H 'Content-Type: application/json' -d '{"sku":"CAM-AZ-M","qty":3,"locationId":"'"$RECV"'"}' "$BASE/sellers/acme/inbounds" | sed -E 's/.*"actor":"([^"]+)".*/actor: \1/'
echo "-- Operario intenta gestionar usuarios --> 403 --"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -H "x-user-id:$OP" "$BASE/users"

echo "== Escáner y unidades de medida =="
A='-H x-user-id:admin'
echo "-- Registrar caja master (DUN, factor 12) para CAM-AZ-M --"
curl -s $A -H 'Content-Type: application/json' -d '{"code":"CASE","barcode":"17801234567897","factor":12,"label":"Caja x12"}' "$BASE/sellers/acme/skus/CAM-AZ-M/packs" >/dev/null
echo "-- Escanear 2 cajas -> 24 unidades base --"
curl -s $A -H 'Content-Type: application/json' -d '{"barcode":"17801234567897","packCount":2,"locationId":"'"$RECV"'"}' "$BASE/sellers/acme/scan/inbound" | sed -E 's/.*"baseQty":([0-9]+).*/2 cajas escaneadas = \1 unidades base/'

echo "== Escaneo en guardado y picking =="
A='-H x-user-id:admin'
SL2=$(curl -s $A -H 'Content-Type: application/json' -d '{"code":"G-02-1-A","zoneType":"STORAGE","capacity":500,"pickRank":1}' "$BASE/locations" >/dev/null; echo ok)
echo "-- Guardado por escaneo: 2 cajas de RECV-01 -> G-02-1-A --"
curl -s $A -H 'Content-Type: application/json' -d '{"productBarcode":"17801234567897","packCount":1,"fromLocationCode":"RECV-01","toLocationCode":"G-02-1-A"}' "$BASE/sellers/acme/scan/putaway" | sed -E 's/.*"baseQty":([0-9]+).*"code":"([^"]+)".*/guardado: \1 un base (\2)/'
