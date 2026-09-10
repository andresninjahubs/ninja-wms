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
| `ROOT_PASSWORD` | una clave fuerte para el super-admin |
| `SEED_DEMO` | `false` |
| `CORS_ORIGIN` | `https://TU-DOMINIO` |

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
- Usuario: `root@ninjahubs.cl`
- Clave: la que pusiste en `ROOT_PASSWORD`

Cambia la clave, crea tu primera operación, clientes y usuarios.

## Actualizar la plataforma
Cuando cambie el código, desde la carpeta:
```bash
railway up
```

## Notas de seguridad (antes de cobrar a clientes reales)
- `SEED_DEMO=false` (sin usuarios de ejemplo con clave `demo1234`).
- `AUTH_REQUIRED=true`, `AUTH_SECRET` y `ROOT_PASSWORD` únicos y fuertes.
- Respaldos de la base (Railway ofrece backups del servicio Postgres — actívalos).
- Considera una revisión de seguridad y tus obligaciones de datos personales
  (en Chile, Ley 19.628) antes de operar comercialmente.
