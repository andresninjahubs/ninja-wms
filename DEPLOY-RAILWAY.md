# Desplegar Ninja WMS en Railway (plataforma pública)

Guía para publicar el WMS en Internet con **Railway** (plataforma administrada: HTTPS,
base de datos con respaldos y reinicios automáticos). No necesitas cuenta de GitHub:
el código se sube desde tu computador con la CLI de Railway.

## Requisitos
- El proyecto en tu computador (esta carpeta).
- Node.js instalado (para la CLI): https://nodejs.org
- Una tarjeta (Railway es post-pago; plan Hobby ≈ USD 5/mes + uso).
- Un dominio (opcional pero recomendado para una plataforma pública).

## 1) Instala la CLI e inicia sesión
```bash
npm i -g @railway/cli
railway login          # abre el navegador para autenticarte
```

## 2) Crea el proyecto y súbelo
Desde la carpeta del proyecto:
```bash
railway init           # crea un proyecto nuevo (ponle nombre: ninja-wms)
railway up             # sube el código y lo construye con el Dockerfile
```

## 3) Agrega la base de datos PostgreSQL
En el panel de Railway (railway.com) → tu proyecto → **New → Database → Add PostgreSQL**.
Railway crea la base y su variable `DATABASE_URL`.

## 4) Configura las variables del servicio del WMS
En el panel → servicio del WMS → pestaña **Variables**. Agrega:

| Variable | Valor |
|---|---|
| `PERSISTENCE` | `prisma` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referencia a la base) |
| `AUTH_REQUIRED` | `true` |
| `AUTH_SECRET` | un secreto largo (genera con `openssl rand -hex 32`) |
| `ROOT_EMAIL` | email del super-admin (por defecto `admin@ninjahubs.cl`) |
| `ROOT_PASSWORD` | una clave fuerte para el super-admin |
| `SEED_DEMO` | `false` |
| `CORS_ORIGIN` | `https://TU-DOMINIO` |
| `AGENT_SCHEDULER` | `false` apaga el reloj del agente autónomo (por defecto corre cada `AGENT_INTERVAL_SEC`, 120 s). Nivel de autonomía, sombra, límites y correo de alertas se fijan en el panel → Agente |
| `HIDDEN_MODULES` | módulos ocultos al cliente; si no la defines aplica el default de la versión (`voz,costos,plan,aiaudit,asignaciones,agente`). `""` muestra todo |

(Opcionales: `BRAND_APP_NAME`, `BRAND_PRIMARY_COLOR`, `SMTP_URL`, `SMTP_FROM`.)

Railway reconstruye al guardar. El arranque aplica el esquema a la base
automáticamente (`prisma db push`, ver `docker-entrypoint.sh`).

## 5) Publica el dominio
Servicio del WMS → **Settings → Networking → Generate Domain** (te da una URL
`*.up.railway.app`). Para tu dominio propio: **Custom Domain** e ingresa
`wms.tudominio.cl`; Railway te muestra el registro **CNAME** que debes crear en tu
proveedor de dominio. El HTTPS es automático.

## 6) Primer ingreso
Abre `https://TU-DOMINIO/admin/` e inicia sesión como:
- Usuario: `admin@ninjahubs.cl` (o el `ROOT_EMAIL` que definiste)
- Clave: la que pusiste en `ROOT_PASSWORD`

Cambia la clave, crea tu primera operación, clientes y usuarios.

## Actualizar la plataforma
Cuando cambie el código, desde la carpeta:
```bash
railway up
```

### Subir una versión nueva sobre una instalación antigua
El arranque ejecuta `prisma db push`, que adapta el esquema de la base a la versión nueva.
Si entre versiones se eliminaron columnas o tablas, Prisma **se detiene** y el servicio no
arranca (en los logs verás "data loss"). Tienes dos caminos:

1. **Base nueva para la prueba (recomendado para que un cliente pruebe):** en Railway agrega
   otro PostgreSQL (o un servicio nuevo completo) y apunta `DATABASE_URL` a él. Entras con el
   super-admin, creas la operación del cliente y sus usuarios; desde el Dashboard el cliente
   puede cargar datos de ejemplo con un clic.
2. **Conservar la base actual:** haz un respaldo en Railway (Postgres → Backups) y agrega la
   variable `PRISMA_ACCEPT_DATA_LOSS=true` solo para ese despliegue; quítala después.

### Preparar una prueba con un cliente
- `SEED_DEMO=false` (sin usuarios de ejemplo), `AUTH_REQUIRED=true`.
- Crea la operación del cliente desde **Operaciones** y un usuario ADMIN para él.
- Los tutoriales se abren solos la primera vez que entra a cada sección; los videos están
  incluidos en la imagen (`/admin/videos/`).
- Cuando quieras mostrarle un módulo oculto, edita `HIDDEN_MODULES` y reinicia el servicio.

## Notas de seguridad (antes de cobrar a clientes reales)
- `SEED_DEMO=false` (sin usuarios de ejemplo con clave `demo1234`).
- `AUTH_REQUIRED=true`, `AUTH_SECRET` y `ROOT_PASSWORD` únicos y fuertes.
- Respaldos de la base (Railway ofrece backups del servicio Postgres — actívalos).
- Considera una revisión de seguridad y tus obligaciones de datos personales
  (en Chile, Ley 19.628) antes de operar comercialmente.

## Servidor MCP (v126)

El WMS expone sus herramientas por el protocolo MCP en `POST /mcp`, con
transporte Streamable HTTP **sin sesión** (cada petición es autosuficiente, así
cualquier instancia detrás del balanceador puede responder cualquier llamada).

- **Autenticación**: llave de API (`Authorization: Bearer njw_…`), NO el JWT del
  panel. Se emiten y revocan en *Ninja IA → Conexión MCP*.
- **Esquema**: agrega la tabla `ApiKey`. El `prisma db push` del arranque la crea.
- **Nada que configurar por entorno**: la ruta se monta sola con la app.
- La dirección que se le da a un cliente MCP es `https://<tu-dominio>/mcp`.
