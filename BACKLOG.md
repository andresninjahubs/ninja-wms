# Backlog del proyecto — WMS 3PL Ninja Hubs

Estado del walking skeleton y pendientes priorizados. Actualizado al avanzar cada fase.

## ✅ Construido y probado (52 tests)

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
