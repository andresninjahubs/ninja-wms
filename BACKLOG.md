# Backlog del proyecto — WMS 3PL Ninja Hubs

Estado del walking skeleton y pendientes priorizados. Actualizado al avanzar cada fase.

## ✅ Construido y probado (52 tests)

- **Costos de insumos de embalaje (v82)** — cada reposición registra el **costo unitario de compra** (más referencia y usuario). El sistema lleva el **costo promedio ponderado (PMP)** por insumo (recalculado en cada ingreso; las salidas no lo alteran), el costo de la última compra, el margen contra el precio de cobro y el valor del stock. Los consumos al empacar y los ajustes quedan **valorizados al PMP del momento**, y Rentabilidad usa ese costo real en vez del % estimado cuando existe. Esquema: columna ADITIVA `PackagingMovement.unitCost Int?` (`db push` sin pérdida).
- **Fix producción: «Error interno» al crear / recepcionar una orden de recepción (v82)** — en Prisma, la tabla normalizada `ReceiptLine` se llenaba con `l.qty` (campo del payload) en vez de `expectedQty` (campo del dominio), así que la cantidad llegaba vacía y Postgres rechazaba el insert; como la cabecera ya se había guardado, la recepción aparecía al refrescar. Ahora se mapea `expectedQty`, se ignoran vencimientos inválidos y cabecera + líneas van en una sola transacción. Sin cambio de esquema.
- **Feedback cliente, lote 1 (v82)** — (C1) **carga masiva de ubicaciones** por Excel/CSV (`/operations/:id/location-import` template/export/preview/commit, mismo patrón que productos: el código es la clave, nuevas se crean, existentes se editan con diff y confirmación; zonas en español o inglés). (C2) **eliminar ubicación** (`DELETE /locations/:id`) solo si nunca tuvo movimientos ni recepciones abiertas; si tuvo historia responde con mensaje claro y el panel ofrece desactivarla. (C3) **reposición de insumos de embalaje** con referencia (proveedor / guía / factura) y usuario, botón «Historial» por insumo con saldo, reposiciones, consumos y ajustes. (B5) botón «Historial» global de Productos eliminado (queda el de cada fila). (B3) modal «Nueva orden» a ancho completo con cabecera de columnas y campo Cantidad siempre visible (también en móvil). Sin cambios de esquema de base de datos.
- **Fix producción: historial de órdenes no se persistía en Prisma (v81)** — el modelo `SalesOrder` no tenía columna `events` (solo ReturnOrder/ReceiptOrder), así que en producción toda orden volvía sin historial y la factura contaba 0 despachos. Se agregó la columna `events Json @default("[]")` (cambio de esquema ADITIVO, `db push` la crea sin pérdida) y el repositorio la persiste (y `shipTo` en update); facturación usa `shipment.shippedAt` como respaldo para órdenes despachadas guardadas antes del fix.
- **Cambio de estado masivo de órdenes (v81)** — admin/supervisor/plataforma: casillas por fila + «todas las visibles» del filtro, barra flotante con las transiciones válidas para la selección (reservar, a picking, confirmar picking completo, empacar 1 bulto, despachar con courier opcional, cancelar, reactivar); se aplica orden por orden con resumen de ok/omitidas/errores; selección persistente entre refrescos; también en móvil.
- **Vista en vivo por sondeo (v81)** — Dashboard, Todos los clientes, inventario, recepción, almacenado, movimientos, etc. se recargan solos (20–60 s según sección) mientras la pestaña está visible; se pausa con formularios/paneles abiertos o tutorial corriendo; indicador «al día / hace N s» junto al título con refresco manual. Órdenes/cola siguen a 6 s.
- **Facturación: regla de corte por despacho (v81)** — despacho, picking (unidades PICK ligadas a la orden, con respaldo en las líneas) y embalaje se cobran por las órdenes cuyo evento DESPACHADA cae en el período; picking/empaque de meses anteriores se factura junto con el despacho, y lo no despachado no se cobra. Test de corte entre meses.
- **Panel responsivo para móviles (v81)** — `webadmin/mobile.css` + `mobile.js`: menú en cajón deslizante (☰), barra superior compacta con botón de contexto (buscador, operación, cliente, sesión), tablas como tarjetas apiladas, paneles/modales a pantalla completa, controles táctiles; sin cambios en escritorio. Probado en iPhone, Android e iPad (vertical y horizontal).
- **Módulos ocultos por versión (v81)** — `GET /ui-config` + env `HIDDEN_MODULES` (default: voz, costos, plan, aiaudit, asignaciones, agente): se quitan del menú, de la navegación directa y del Centro de aprendizaje; el super-admin de plataforma los sigue viendo.
- **Tutoriales guiados por sección (v81)** — tour interactivo con narración por voz sobre la interfaz real (foco por elemento, auto-avance, pausa, atajos), auto-ofrecido la primera vez y siempre disponible desde «▶ Tutorial» y el Centro de aprendizaje; más videos MP4 grabados automáticamente (`scripts/record-tutorials.js`). Ver `TUTORIALES.md`.
- **Multi-operación (multi-administrador)** — `Operation` como tenant de más alto nivel: cada operación tiene sus propias bodegas, ubicaciones, sellers, usuarios e inventario, aisladas entre sí. Rol `PLATFORM_ADMIN` (Ninja Hubs) por encima que crea operaciones y ve todas. Enforcement: un admin de una operación no puede ver ni actuar sobre otra; invariante de que una ubicación pertenece a la misma operación del seller. Dos niveles de aislamiento: operación → seller.
- **Códigos de barra y unidades de medida** — packs multi-nivel por SKU (unidad EAN, caja DUN, pallet…), cada uno con su código y factor a la unidad base; resolución automática del nivel escaneado; **escaneo en recepción, guardado y picking** (producto + bin) con conversión a múltiplos del EAN. El inventario se lleva en unidades base.
- **Usuarios, roles y permisos** — mantenedor de usuarios (CRUD), roles ADMIN / SUPERVISOR / OPERATOR / CLIENT, permisos por acción, guard en la API, y **auditoría**: cada movimiento del ledger queda firmado por el usuario que lo hizo (`actor`). Usuarios CLIENT aislados a su propio seller.

- **Núcleo multi-cliente (3PL)** — aislamiento total por `sellerId`; SKU scoped al seller (mismo código no colisiona); ubicaciones compartidas.
- **Inventario como ledger inmutable** — stock = suma de movimientos; nunca negativo; estados (disponible / reservado / cuarentena / dañado / en tránsito).
- **Recepción y guardado** con trazabilidad por lote.
- **Guardado caótico dirigido** — sugerencia de ubicación por rotación ABC, capacidad y consolidación.
- **Órdenes desde el OMS** — contrato canónico (seller + canal), multi-SKU, lote opcional, B2C/B2B.
- **Reserva (allocation)** — disponible = físico − reservado; anti-sobreventa; full-or-nothing con rollback.
- **Picking y despacho** — pick list, confirmación de picking, despacho paquetería (B2C) / transporte (B2B).
- **Estrategia de picking configurable por seller** — FIFO / FEFO / lote-serie dirigido.
- **Conteo cíclico configurable por seller** — planificador ABC / ubicación / aleatorio + ejecución con reconciliación (ajustes al ledger) y reporte de varianzas.

## 🔜 Pendiente (priorizado)

### UI (pendiente de iterar)
- [ ] **Panel, consola y PWA con conmutador de operación** — hoy las interfaces muestran una sola operación; falta reflejar el selector de operación (para PLATFORM_ADMIN) y acotar la vista de cada administrador a la suya.

### P1 — Control y seguridad
- [x] **Perfiles de usuario, roles y mantenedor de usuarios** — hecho.
- [x] **Autorización** — permisos por acción + guard; el usuario autenticado es el `actor` del ledger — hecho.
- [ ] **Autenticación real** — hoy el token es el id/email del usuario (skeleton). Falta login con contraseña (hash bcrypt/argon2) y **JWT firmado** con expiración/refresh, sobre HTTPS. Cambio acotado: solo toca login + guard, no el dominio.
  - Decisión pendiente con Andrés: **auth propia** (login+JWT dentro del WMS) vs. **proveedor de identidad / SSO** (Google/Microsoft, Auth0/Cognito/Keycloak/Clerk). Probable: SSO para staff del operador + cuentas propias para clientes. Extras: 2FA, bloqueo por intentos, reset de contraseña.
- [ ] **Bitácora de auditoría no-stock** — registrar logins, cambios de configuración y de usuarios (el ledger ya audita los movimientos de stock).
- [ ] **RLS en PostgreSQL** — reforzar el aislamiento por seller a nivel de base de datos.

### P2 — Integraciones reales (requieren credenciales / ambientes del lado de Ninja Hubs)
- [ ] **OMS** — webhooks de estado de fulfillment; adopción del contrato de órdenes.
- [ ] **ERP** (Bsale / Defontana / Odoo) — sincronización de productos, compras y valorización.
- [ ] **Courier / transporte** (Chilexpress / Starken / Blue Express) — cotización, guía y tracking.

### P3 — Operación avanzada
- [ ] **Conteo por evento (opportunity counting)** — disparar conteo automático al llegar a cero/negativo o ante descuadres en picking.
- [ ] **Reposición automática** de ubicaciones de picking desde reserva cuando bajan del mínimo.
- [ ] **Rastreo serial** unidad-por-unidad (hoy la trazabilidad es por lote).
- [ ] **Ajustes con aprobación** — flujo de autorización para varianzas de conteo sobre un umbral.

### P4 — Cliente y facturación 3PL
- [ ] **Portal / reportería por seller** — cada cliente ve sus KPIs (exactitud, líneas/hora, ocupación, dock-to-stock).
- [ ] **Base de facturación 3PL** — cargos por almacenaje, picking y despacho por seller.
- [ ] **B2B avanzado** — ASN al destino, cita de entrega (campos ya previstos en el contrato de órdenes).

### P5 — Operación en piso
- [x] **PWA operador con lector de código** — app instalable (`pwa/`) con cámara vía `BarcodeDetector` (+ ingreso manual), login, recepción/guardado/picking/consulta y conversión de unidades. Pendiente de endurecer: pruebas en dispositivos reales, íconos PNG maskable, modo offline de operaciones (cola de reintento), y lector con librería propia para navegadores sin `BarcodeDetector` (ej. iOS Safari).
- [ ] **Endurecimiento** — rendimiento, observabilidad, backups del ledger, despliegue productivo.
