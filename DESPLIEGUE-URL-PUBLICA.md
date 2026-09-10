# Poner el WMS en una URL pública

Objetivo: que el panel y la app queden en una dirección `https://...` accesible
desde cualquier teléfono o computador. Una sola URL sirve todo (panel + PWA + API):

```
https://<tu-servicio>.onrender.com/admin/   ← panel de administración (back-office)
https://<tu-servicio>.onrender.com/app/     ← PWA de operador (bodega, con escáner)
```

> **Nota honesta:** este despliegue lo haces con **tu propia cuenta** (yo no puedo
> crear hosting con tus credenciales). Dejé todo preparado —`Dockerfile` y
> `render.yaml`— para que sea casi automático. En la fase de prueba los datos son de
> demostración y viven en memoria: se reinician cuando el servicio se duerme por
> inactividad (capa gratuita). Perfecto para validar desde el teléfono.

---

## Opción A — Render (recomendada, durable, la más simple)

**Paso 1 — Subir el proyecto a GitHub.**
Descomprime `ninjahubs-wms-skeleton.zip`. Necesitas que la carpeta `wms/` quede en un
repositorio de GitHub (con el `Dockerfile` y el `render.yaml` en la raíz de esa carpeta).
- Si tienes equipo técnico: es el mismo repo que ya iban a versionar.
- Si lo haces tú: en https://github.com → **New repository** → luego **uploading an
  existing file** y arrastra el contenido de la carpeta `wms/`. GitHub acepta carpetas.

**Paso 2 — Crear el servicio en Render.**
1. Entra a **https://render.com** y crea una cuenta gratis (puedes usar tu cuenta de GitHub).
2. Botón **New +** → **Blueprint**.
3. Conecta tu repositorio. Render leerá el `render.yaml` y propondrá crear el servicio
   **`wms-ninjahubs`**. Confirma con **Apply**.
4. Espera unos minutos (construye la imagen Docker y arranca). Render te da la URL pública.

**Paso 3 — Entrar.**
Abre **`https://<esa-url>/admin/`** e inicia sesión con **email y contraseña** (auth real):

| Email                | Contraseña  | Rol / Qué ve                                       |
|----------------------|-------------|----------------------------------------------------|
| `root@ninjahubs.cl`  | `admin1234` | PLATFORM_ADMIN — todo, incluida **Operaciones**    |
| `ana@ninjahubs.cl`   | `demo1234`  | ADMIN — **Bodega Ninja Hubs** completa             |
| `pedro@ninjahubs.cl` | `demo1234`  | OPERATOR — Ninja Hubs (sin administración)          |
| `carla@acme.cl`      | `demo1234`  | CLIENT — solo su cliente **ACME**                  |
| `nora@andes.cl`      | `demo1234`  | ADMIN — **Bodega Andes** (aislada de la anterior)  |

La PWA de operador está en **`https://<esa-url>/app/`** (ingresa servidor = la misma
URL, cliente = `acme`, y email/contraseña, p.ej. `pedro@ninjahubs.cl` / `demo1234`).

---

## Opción B — Railway (alternativa)

1. Sube el proyecto a GitHub (igual que arriba).
2. Entra a **https://railway.app** → **New Project** → **Deploy from GitHub repo**.
3. Railway detecta el `Dockerfile` y despliega. En *Settings → Networking* genera un
   **dominio público**. El panel queda en `https://<dominio>/admin/`.

---

## Opción C — Túnel rápido desde Claude (temporal, para probar hoy)

Puedo levantar un túnel y darte una URL en minutos, **pero** el entorno de Claude
bloquea por defecto las conexiones de red hacia los proveedores de túnel. Para
habilitarlo, tú (como dueño de la organización) tendrías que permitir el host en
**Ajustes de administrador → Capacidades → Acceso de red** y agregar:

```
api.trycloudflare.com
```

Advertencia honesta: aun habilitándolo, el túnel usa un puerto de datos (7844) que el
proxy de red del entorno podría seguir bloqueando, así que **no está garantizado**.
Además la URL solo vive mientras la sesión de Claude esté activa. Por eso, para algo
estable, la Opción A (Render) es la recomendada. Si habilitas el host, avísame y lo
intento en vivo.

---

## Datos de prueba ya sembrados

Dos operaciones aisladas, cada una con sus sellers, ~5 ubicaciones, ~12 SKUs, ~20
órdenes en distintos estados (Ingresada → Reservada → Pickeada → Despachada) y 10
usuarios de diversos roles. Los valores se generan sembrados por cuenta: estables
entre reinicios pero **distintos entre una operación/seller y otra**.

- **Bodega Ninja Hubs** (`op-ninja`): sellers `acme`, `globex`.
- **Bodega Andes** (`op-andes`): sellers `zeta`, `kappa`.

---

## Cuando pasemos de "prueba" a "real"

- **Datos persistentes**: cambiar `PERSISTENCE=prisma` y agregar una base PostgreSQL
  (Render/Railway ofrecen una gestionada) con su `DATABASE_URL`; correr las migraciones.
- **Autenticación real**: cerrar el login con contraseña/JWT o SSO (hoy el token es el
  id/email del usuario). Está en `BACKLOG.md` como prioridad.
- **Dominio propio**: apuntar `wms.ninjahubs.cl` al servicio con su certificado HTTPS.
