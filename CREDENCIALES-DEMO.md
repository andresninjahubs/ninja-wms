# Credenciales de demostración — WMS Ninja Hubs

Todos los usuarios de demo usan la contraseña **`demo1234`**, salvo el super-admin
de plataforma que usa **`admin1234`**. El login (panel `/admin/` y PWA `/app/`) es con
**email + contraseña**.

> Para probar **movimientos** (recepción, guardado, picking) con el escáner, entra a la
> PWA (`/app/`) con un **Operario** de la operación y elige el **cliente (seller)**
> correspondiente; escanea con la hoja de códigos de ese cliente.

---

## Plataforma (ve TODO)

| Email                | Contraseña  | Rol            |
|----------------------|-------------|----------------|
| `admin@ninjahubs.cl` | `admin1234` | PLATFORM_ADMIN |

---

## Operación 1 — Bodega Ninja Hubs (`op-ninja`)
Clientes (sellers): **acme** (ACME Retail), **globex** (Globex Store).
Hoja de códigos para escanear: **acme**.

| Email                | Contraseña | Rol         | Alcance / uso                          |
|----------------------|------------|-------------|----------------------------------------|
| `ana@ninjahubs.cl`   | `demo1234` | ADMIN       | Administra toda la operación           |
| `ninja-u2@ninja.cl`  | `demo1234` | SUPERVISOR  | Supervisión                            |
| `pedro@ninjahubs.cl` | `demo1234` | OPERATOR    | **Movimientos/escáner** (cualquier seller) |
| `ninja-u1@ninja.cl`  | `demo1234` | OPERATOR    | Movimientos/escáner                    |
| `carla@acme.cl`      | `demo1234` | CLIENT      | Solo **acme** (ve su stock, recepción) |
| `ignacio@acme.cl`    | `demo1234` | CLIENT      | Solo **acme**                          |
| `nora@globex.cl`     | `demo1234` | CLIENT      | Solo **globex**                        |

**Probar movimientos aquí:** PWA → Servidor `http://localhost:3000`, Cliente `acme`,
usuario `pedro@ninjahubs.cl` / `demo1234`. Escanea con la hoja **codigos-acme-ninja.png**.

---

## Operación 2 — Bodega Andes (`op-andes`)  *(aislada de la anterior)*
Clientes (sellers): **zeta** (Zeta SpA), **kappa** (Kappa Logística).
Hoja de códigos para escanear: **zeta**.

| Email                | Contraseña | Rol         | Alcance / uso                          |
|----------------------|------------|-------------|----------------------------------------|
| `nora@andes.cl`      | `demo1234` | ADMIN       | Administra toda la operación           |
| `andes-u1@andes.cl`  | `demo1234` | SUPERVISOR  | Supervisión                            |
| `andes-u5@andes.cl`  | `demo1234` | OPERATOR    | **Movimientos/escáner** (cualquier seller) |
| `andes-u6@andes.cl`  | `demo1234` | OPERATOR    | Movimientos/escáner                    |
| `ignacio@zeta.cl`    | `demo1234` | CLIENT      | Solo **zeta**                          |
| `valentina@kappa.cl` | `demo1234` | CLIENT      | Solo **kappa**                         |

**Probar movimientos aquí:** PWA → Servidor `http://localhost:3000`, Cliente `zeta`,
usuario `andes-u5@andes.cl` / `demo1234`. Escanea con la hoja **codigos-zeta-andes.png**.

---

### Notas
- Las dos operaciones están **aisladas**: un usuario de `op-ninja` no ve ni actúa sobre
  `op-andes` (y viceversa). El `root` es el único que ve ambas.
- Un **Operario** puede operar cualquier cliente de su operación; un **Cliente** solo el
  suyo. Un **Cliente** también puede registrar recepciones de su propia mercadería.
- Estos datos son de la semilla de demostración (deterministas): se repiten igual cada vez
  que enciendes el WMS, y se reinician si lo apagas y lo prendes.
