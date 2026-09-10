# Ninja Hubs WMS — Walking Skeleton

Primer entregable del **WMS 3PL multi-cliente**. Es un corte vertical delgado que
atraviesa toda la arquitectura para probar que las decisiones de fondo funcionan de
punta a punta: **multi-tenant por seller**, **ledger de inventario inmutable**,
**ubicaciones compartidas** y consulta de stock en tiempo real vía API.

No es la operación completa todavía (aún no hay órdenes ni picking). Es el cimiento
sobre el que se construyen las fases siguientes.

## Qué ya funciona

El panel `/admin/` es **responsivo** (teléfonos y tablets: menú deslizante, tablas en tarjetas; ver `webadmin/mobile.css`).

Onboarding — **tutoriales guiados por sección** (tour interactivo con voz + video MP4), ver [`TUTORIALES.md`](TUTORIALES.md).

Fase 1 — inventario:
- Crear **sellers** (clientes 3PL) con aislamiento total entre ellos.
- Maestro de **SKU scoped al seller** (dos sellers pueden usar el mismo código sin colisión).
- **Ubicaciones compartidas** entre sellers (modelo caótico).
- **Recepción** de mercadería y **guardado dirigido** con validación de stock.
- **Órdenes de recepción (inbound) con cotejo físico vs teórico**: cada ingreso tiene un
  **ID propio** (OR-YYYYMMDD-XXXX) y varios SKUs con cantidades **esperadas**. El equipo
  **cotejo** el físico por SKU y confirma lo recibido; el stock entra al inventario solo al
  confirmar el conteo. Soporta **recepción parcial en varios eventos** (Pendiente → Parcial →
  Recepcionada) y **cerrar con faltante**. Imprimible como **manifiesto PDF** (esperado/
  recibido/diferencia). Editable en Pendiente; eliminable revirtiendo el stock recibido si
  sigue íntegro en recepción. Auditoría append-only por orden.
- **Consulta de stock** por seller / SKU / ubicación / estado.
- **Kardex de movimientos** con filtros (SKU, ubicación, usuario, cliente, tipo, referencia, rango de fechas).
- **Facturación 3PL por cliente**: tarifario configurable por seller (cuota fija,
  almacenamiento por unidad-mes, recepción por unidad, despacho por pedido, picking por
  unidad, armado por kit) y **factura mensual** calculada automáticamente desde el ledger
  (el almacenamiento integra las unidades físicas en el tiempo → unidad-mes). Genera,
  lista y muestra facturas con **PDF imprimible**. El tarifario y la emisión son del staff
  de operación (`billing:manage`); el cliente puede consultar sus facturas.
- **Mantenedor de productos (SKUs + kits)**: crear/editar/activar/desactivar SKUs, con
  niveles de empaque EAN/DUN. Soporta **kits** (SKU compuesto por otros SKUs) en dos modos:
  **virtual** (se explota en sus componentes al reservar/pickear una orden) y **armado**
  (stock propio; se ensambla en bodega consumiendo componentes). Accesible por el **cliente**
  (acotado a su seller) y por el **staff de operación** (permiso `product:manage`), con
  **historial de cambios auditable** por ambos.

Fase 2 — órdenes y reserva:
- **Ingreso de órdenes desde el OMS** con seller + canal de venta (contrato canónico).
- Órdenes **multi-línea** (varios SKUs, cantidades distintas) con **lote/serie opcional**
  por línea (si viene, reserva solo de ese lote).
- **Reserva de stock (allocation)**: transición `AVAILABLE → RESERVED` en el ledger,
  de modo que `disponible = físico − reservado` (anti-sobreventa).
- Reserva **full-or-nothing** en órdenes multi-línea (rollback si una línea no alcanza).
- **Cancelación** que libera las reservas (solo antes de pickear).

Fase 8 — multi-operación (multi-administrador):
- **Operación** como tenant de más alto nivel: cada una con sus propias bodegas,
  ubicaciones, sellers, usuarios e inventario, **aisladas entre sí**.
- Rol **PLATFORM_ADMIN** (Ninja Hubs) por encima de las operaciones: las crea y ve todas.
- Dos niveles de aislamiento: **operación → seller**. Un admin de una operación no ve ni
  actúa sobre otra; invariante de que una ubicación pertenece a la operación de su seller.
- Endpoints `/operations` (solo plataforma). El `operationId` se deriva del usuario.

Fase 7 — códigos de barra y unidades de medida:
- **Packs multi-nivel por SKU**: unidad (EAN), caja master (DUN), pallet… — cada nivel
  con su **propio código** y un **factor** = unidades base que representa.
- **Resolución de código escaneado** → SKU + nivel + factor.
- **Recepción por escaneo** que traduce N packs a **unidades base** (múltiplos del EAN);
  el inventario se lleva SIEMPRE en unidades base para que el stock cuadre.
- El EAN de un SKU se auto-registra como su unidad base (factor 1) al crearlo.
- **Escaneo en recepción, guardado y picking**: se pistolea el producto (nivel y factor
  automáticos por el código) y la ubicación (por su código de bin), con la misma
  conversión a unidades base en las tres operaciones.

Fase 6 — usuarios, roles y auditoría:
- **Mantenedor de usuarios** (CRUD) con roles **ADMIN / SUPERVISOR / OPERATOR / CLIENT**.
- **Permisos por acción** (`ROLE_PERMISSIONS`) y **guard** en la API que exige el permiso
  de cada endpoint y respeta la frontera de seller (un CLIENT solo actúa sobre el suyo).
- **Auditoría**: el usuario autenticado queda como `actor` de cada movimiento del ledger.
- **Autenticación real (Fase 1)**: login con email + contraseña (bcrypt) que emite un
  **JWT firmado** (HS256, `AUTH_SECRET`); el guard valida el token en cada acción. El
  admin fija contraseña inicial al crear un usuario y puede **restablecerla**; cada usuario
  **cambia la suya**. Con `AUTH_REQUIRED=true` la API exige token válido (401 si falta).

Fase 5 — estrategias por seller y conteo cíclico:
- **Estrategia de picking configurable por seller**: `FIFO` (primero en entrar),
  `FEFO` (vence antes, por vencimiento del lote) o `LOT_DIRECTED` (la orden debe
  indicar el lote/serie). Gobierna el orden en que la reserva consume el stock.
- **Metadata de lote** (`Lot`): `receivedAt` (FIFO) y `expiryDate` (FEFO).
- **Conteo cíclico configurable** (`CycleCountService`): planificador por estrategia
  del seller — `ABC` (por rotación), `LOCATION` (barrido) o `RANDOM` (muestreo) —
  y ejecución que reconcilia el ledger con movimientos de AJUSTE y reporta varianzas.
  El conteo por EVENTO (al llegar a cero/negativo) queda como base.

Fase 4 — guardado caótico dirigido:
- **Motor de sugerencia de ubicación** (`PutawayAdvisor`): al recibir, propone dónde
  guardar según **rotación ABC** (clase A cerca de picking, C lejos), **capacidad**
  disponible (medida cross-seller, ubicaciones compartidas) y **consolidación**
  (preferir donde el SKU ya está). Devuelve un ranking con las razones de cada opción.
- Nuevos atributos: `Sku.rotationClass` (A/B/C) y `Location.capacity` + `Location.pickRank`.

Fase 3 — picking y despacho:
- **Pick list** generada desde las reservas (SKU, ubicación, lote, cantidad), ordenada por ruta.
- **Confirmación de picking**: el stock reservado sale de la bodega (movimiento `PICK`).
- **Despacho** con modo derivado del tipo: **paquetería (B2C)** o **transporte (B2B)**,
  registrando courier y tracking.
- Estados de orden: `RECEIVED → ALLOCATED → PICKED → SHIPPED` (o `CANCELLED`).

Invariantes garantizados y probados (21 tests): stock = suma de movimientos, **nunca
negativo**, y ningún dato cruza la frontera de un seller.

## Arquitectura

Arquitectura hexagonal: el **dominio es puro** (sin NestJS, Prisma ni HTTP), y la
infraestructura lo envuelve. Esto permite testear la lógica crítica sin base de datos
y cambiar la persistencia sin tocar el núcleo.

```
src/
  domain/            # Núcleo puro: reglas de negocio e invariantes
    types.ts         #   entidades y enums
    errors.ts        #   errores de dominio
    ports.ts         #   interfaces (puertos) que el dominio necesita
    inventory.service.ts   # EL núcleo: ledger, recepción, guardado
  app/
    wms.facade.ts    # Fachada de aplicación (orquesta dominio + maestros)
  infra/
    memory/          # Repos en-memoria (tests y arranque sin DB)
    prisma/          # Repos PostgreSQL (producción)
    context.ts       # Elige la persistencia según env
  api/               # Capa HTTP NestJS (controllers, DTOs, filtro de errores)
test/
  inventory.domain.test.ts   # Tests de invariantes (corren sin DB)
prisma/
  schema.prisma      # Esquema PostgreSQL multi-tenant
  seed.ts            # Datos de demostración
```

## Cómo correrlo

Requiere Node 20+.

```bash
npm install
```

### Opción A — sin base de datos (arranque instantáneo)

Usa persistencia en-memoria. Ideal para probar la API al toque.

```bash
npm run build
PERSISTENCE=memory npm start
# En otra terminal:
./demo.sh
```

### Opción B — con PostgreSQL (Prisma)

```bash
docker compose up -d          # levanta Postgres
cp .env.example .env          # y pon PERSISTENCE=prisma
npm run prisma:generate
npm run prisma:migrate        # crea las tablas
npm run seed                  # datos de demo
PERSISTENCE=prisma npm start
```

### Tests

```bash
npm test    # corre los tests de invariantes del dominio (sin DB)
```

## API (corte vertical actual)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET  | `/health` | Estado del servicio |
| POST | `/auth/login` | Login (skeleton: token = id/email) |
| POST | `/users` · `GET /users` · `PATCH /users/:id` | Mantenedor de usuarios (`user:manage`) |
| POST | `/sellers` | Crear seller |
| GET  | `/sellers/:sellerId` | Ver seller |
| POST | `/sellers/:sellerId/skus` | Crear SKU del seller |
| POST | `/sellers/:sellerId/skus/:sku/packs` · `GET` | Registrar / listar niveles de empaque (códigos) |
| GET  | `/sellers/:sellerId/barcodes/:barcode` | Resolver un código escaneado |
| POST | `/sellers/:sellerId/scan/inbound` | Recepción por escaneo (packs → unidades base) |
| POST | `/sellers/:sellerId/scan/putaway` | Guardado por escaneo (producto + bins origen/destino) |
| POST | `/sellers/:sellerId/scan/pick` | Picking por escaneo (bin + producto) |
| POST | `/locations` | Crear ubicación (compartida) |
| POST | `/sellers/:sellerId/inbounds` | Recepción de mercadería (una línea) |
| GET/POST | `/sellers/:sellerId/receipts` | Órdenes de recepción (listar / crear con cantidades esperadas) |
| GET/PATCH/DELETE | `/sellers/:sellerId/receipts/:orderId` | Ver / editar (Pendiente) / eliminar orden |
| POST | `/sellers/:sellerId/receipts/:orderId/receive` | Cotejo: registra el físico recibido por línea (postea stock) |
| POST | `/sellers/:sellerId/receipts/:orderId/close` | Cierra la orden como recibida (parcial con faltante) |
| POST | `/sellers/:sellerId/putaway` | Guardado dirigido |
| GET  | `/sellers/:sellerId/inventory?sku=&locationId=` | Consulta de stock |
| POST | `/sellers/:sellerId/orders?allocate=true` | Ingresar orden del OMS (y reservar) |
| POST | `/sellers/:sellerId/orders/:orderId/allocate` | Reservar stock de la orden |
| POST | `/sellers/:sellerId/orders/:orderId/cancel` | Cancelar y liberar reservas |
| PATCH | `/sellers/:sellerId/policy` | Configurar estrategia de picking / conteo |
| GET  | `/sellers/:sellerId/putaway-suggestions?sku=&qty=` | Sugerencia de guardado dirigido |
| GET  | `/sellers/:sellerId/cycle-counts/plan` | Plan de conteo cíclico del día |
| POST | `/sellers/:sellerId/cycle-counts` | Ejecutar conteo y reconciliar |
| GET  | `/sellers/:sellerId/orders/:orderId/picklist` | Lista de recolección |
| POST | `/sellers/:sellerId/orders/:orderId/pick` | Confirmar picking (sale de bodega) |
| POST | `/sellers/:sellerId/orders/:orderId/ship` | Despachar (courier B2C / transporte B2B) |
| GET  | `/sellers/:sellerId/orders` · `/orders/:orderId` | Listar / ver órdenes |

**Autenticación (skeleton):** enviá la identidad en el header `x-user-id: <userId>`
(o `Authorization: Bearer <userId>`). Se crea un usuario `admin` por defecto. Con
`AUTH_REQUIRED=true`, todo endpoint protegido exige token válido (401 si falta); sin esa
variable, una request sin token corre como `system` para facilitar el arranque/demo.

Ejemplo:

```bash
curl -X POST localhost:3000/sellers/acme/inbounds \
  -H 'Content-Type: application/json' \
  -d '{"sku":"CAM-AZ-M","qty":50,"locationId":"<id>","reference":"ASN-1001"}'
```

## Decisiones de diseño (por qué está así)

- **Ledger inmutable**: el stock nunca se edita como número. Cada cambio es un
  `StockMovement` append-only y el saldo es la suma de los deltas. Da trazabilidad y
  auditoría reales.
- **Multi-tenant por seller**: `sellerId` está presente en toda entidad y toda
  consulta. En producción se refuerza con Row-Level Security de PostgreSQL.
- **Ubicaciones compartidas**: la posición física se comparte entre sellers; la
  propiedad del stock vive en el movimiento y nunca se mezcla.
- **Puertos y adaptadores**: el dominio depende de interfaces, no de Prisma. Por eso
  los tests corren en-memoria y la misma lógica sirve con PostgreSQL.

## Panel de administración conectado (`/admin`)

Carpeta `webadmin/`: el back-office web **conectado de verdad a la API** (no es un
mock). Se sirve desde el mismo backend en la ruta `/admin`, de modo que un único
origen expone panel + API. Cubre dashboard, inventario, órdenes, recepción,
ubicaciones/ocupación, conteo cíclico, reportes, usuarios y operaciones, con la
navegación **acotada por rol** (un CLIENT ve menos secciones que un ADMIN, y solo
el PLATFORM_ADMIN ve "Operaciones").

Para verlo con datos de demostración:

```bash
npm run build
SEED_DEMO=true PERSISTENCE=memory AUTH_REQUIRED=true AUTH_SECRET=mi-secreto node dist/src/main.js
# Abre http://localhost:3000/admin/  e inicia sesión con EMAIL + CONTRASEÑA (auth real):
#   admin@ninjahubs.cl / admin1234  -> PLATFORM_ADMIN (ve todas las operaciones)
#   ana@ninjahubs.cl  / demo1234   -> ADMIN  op-ninja
#   pedro@ninjahubs.cl/ demo1234   -> OPERATOR op-ninja
#   carla@acme.cl     / demo1234   -> CLIENT  (seller acme)
#   nora@andes.cl     / demo1234   -> ADMIN  op-andes
```

La semilla crea **dos operaciones** (Bodega Ninja Hubs y Bodega Andes), cada una con
sus sellers, ~5 ubicaciones, ~12 SKUs, ~20 órdenes en distintos estados
(RECEIVED/ALLOCATED/PICKED/SHIPPED) y 10 usuarios de diversos roles. Los valores se
generan con un PRNG **sembrado por cuenta**, así las cifras son estables entre
reinicios pero **difieren entre una operación/seller y otra**.

> **Por qué se sirve desde el backend y no como artifact/URL estática:** las páginas
> publicadas en claude.ai tienen una política de seguridad (CSP) que bloquea llamadas
> a APIs externas. Servido en `/admin` (mismo origen que la API), el panel llama al
> backend sin restricción. Acciones como **cancelar una orden** hacen el POST real,
> liberan el stock reservado en el ledger y la vista se refresca con el nuevo estado.

Las métricas que aún **no** calcula el backend (exactitud de inventario, líneas/hora)
se muestran honestamente como "—", no inventadas. Quedan anotadas en `BACKLOG.md`.

## White-label (marca configurable)

La marca del panel es un **componente del backend**, no texto incrustado en el HTML.
El endpoint público `GET /branding` devuelve la configuración de marca del deployment:

```json
{ "appName": "Ninja WMS", "primaryColor": "#0E9F6E", "logoUrl": "/brand/logo.svg" }
```

El panel (`/admin`) consume ese endpoint al cargar y aplica: nombre de la app (título),
color primario del tema (`--primary`, que recolorea toda la UI y el wordmark) y, si se
define un logo distinto, lo reemplaza por la imagen servida. El logo por defecto es un
wordmark **SVG inline** ("Ninja" en verde primario + "WMS" oscuro), nítido y temable.

Para re-marcar otro deployment **sin tocar código**, ajusta variables de entorno y,
opcionalmente, reemplaza el archivo del logo:

| Variable              | Default            | Efecto                                   |
|-----------------------|--------------------|------------------------------------------|
| `BRAND_APP_NAME`      | `Ninja WMS`        | Nombre visible (título del panel)        |
| `BRAND_PRIMARY_COLOR` | `#0E9F6E`          | Color primario del tema (hex)            |
| `BRAND_LOGO_URL`      | `/brand/logo.svg`  | URL del logo (sirve otra imagen si cambia)|

El asset del logo se sirve desde `webadmin/brand/` bajo la ruta estable `/brand`
(`/brand/logo.svg`). Para un logo propio: reemplaza `webadmin/brand/logo.svg`
(o apunta `BRAND_LOGO_URL` a otro archivo/URL) y define el color en `BRAND_PRIMARY_COLOR`.

## PWA operador (app de bodega)

Carpeta `pwa/`: app móvil instalable que usa la **cámara como lector de códigos**
(`BarcodeDetector`, con ingreso manual de respaldo) y llama a esta API. Cubre
recepción, guardado, picking y consulta de stock, con la misma conversión de unidades.

Para probarla:

1. Levanta la API con CORS (ya viene habilitado): `npm run start`.
2. Sirve la carpeta `pwa/` por HTTPS (la cámara exige contexto seguro), por ejemplo
   `npx serve pwa` detrás de un túnel TLS, o despliégala en tu hosting.
3. Ábrela en el teléfono, ingresa: servidor (URL de la API), cliente (sellerId) y
   usuario (id/email). "Instalar app" queda disponible desde el navegador.

Notas: la cámara requiere HTTPS y el `BarcodeDetector` está en Chrome/Android (en
navegadores sin soporte, la app cae al ingreso manual). El operador ingresa con
**email y contraseña** (mismo login real que el panel; el token es un JWT). El SSO
(Google/Microsoft) queda como fase siguiente, agregable por operación.

## Qué sigue (siguientes fases)

1. **Integraciones reales** — adaptadores OMS (webhooks de estado de fulfillment),
   ERP (productos/costos) y courier (cotización y guía).
2. **Reposición automática** de ubicaciones de picking desde reserva.
3. **Conteo por evento** (al llegar a cero/negativo) y ajustes con aprobación.
4. **Rastreo serial** unidad-por-unidad (si se requiere trazabilidad serial a escala).
5. **RLS en PostgreSQL**, PWA con escáner.

El contrato de ingreso de órdenes y el plan completo por fases están en el documento
de plan que acompaña esta entrega.
