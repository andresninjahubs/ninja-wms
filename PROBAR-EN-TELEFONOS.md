# Probar el WMS en teléfonos hoy (túnel)

Guía para dejar la app funcionando en cualquier teléfono en unos minutos, para una
**prueba interna**. No es producción: los datos viven en memoria y se borran al apagar
el servidor, y la autenticación todavía es de skeleton (el usuario es su id/email).

La app (PWA) y la API se sirven desde **el mismo servidor**, así que un solo túnel HTTPS
alcanza para todo — y la cámara del teléfono funciona porque el túnel entrega HTTPS.

## Requisitos
- Un computador (Mac, Linux o Windows) con **Node.js 18 o superior** instalado.
- Internet.

## Paso 1 — Levantar el WMS con datos de demo
En una terminal, dentro de la carpeta del proyecto:

```bash
npm install
npm run build
npm run start:demo
```

En Windows (PowerShell), si `start:demo` no toma las variables, usa:

```powershell
$env:SEED_DEMO="true"; $env:PERSISTENCE="memory"; node dist/src/main.js
```

Verás en la terminal algo como:

```
PWA operador disponible en  http://localhost:3000/app/
Semilla de demostración cargada (seller acme, usuarios: admin, pedro, carla).
```

Abre en el mismo computador `http://localhost:3000/app/` para confirmar que carga.

## Paso 2 — Abrir un túnel HTTPS
Deja el servidor corriendo y, en **otra** terminal, levanta un túnel. Recomendado
**cloudflared** (gratis, sin cuenta):

```bash
# Instalar una vez:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:3000
```

Imprime una URL pública como `https://algo-al-azar.trycloudflare.com`.
(Alternativa: `ngrok http 3000`, requiere cuenta gratuita.)

## Paso 3 — Abrir en los teléfonos
En cualquier teléfono, abre:

```
https://algo-al-azar.trycloudflare.com/app/
```

En la pantalla de ingreso ya viene el servidor y el cliente (`acme`). Ingresa con un
usuario de prueba:

| Usuario | Rol | Qué puede hacer |
|---|---|---|
| `pedro` | Operario | Recepción, guardado, picking |
| `carla` | Cliente | Solo consultar stock (de ACME) |
| `admin` | Administrador | Todo |

Toca **Recepción → Simular/Escanear** y apunta la cámara al código. Para probar sin
etiquetas físicas, estos son los códigos sembrados:

- Camisa (CAM-AZ-M): unidad **EAN 7801234567890**, caja **DUN 17801234567897** (×12)
- Pantalón (PANT-NG-42): unidad **7809991000015**, caja **17809991000012** (×6)
- Bins para guardado/picking: **RECV-01**, **A-01-1-A**, **G-02-1-A**
- Hay 24 unidades **reservadas** en RECV-01 para probar picking.

Para "instalar" la app: en el navegador del teléfono, menú → *Agregar a pantalla de inicio*.

## Notas importantes
- **Datos temporales**: al detener el servidor se borra todo. Para datos persistentes,
  usa PostgreSQL (`docker compose up -d db`, luego `npm run prisma:migrate` y arranca con
  `PERSISTENCE=prisma`). Ver README.
- **Cámara**: funciona en Chrome/Android. En iPhone (Safari) el lector nativo puede no
  estar; la app cae al **ingreso manual** del código (queda en el backlog un lector
  alternativo para iOS).
- **Seguridad**: esto es una prueba. Cualquiera con la URL y un id de usuario puede operar.
  No lo dejes expuesto de forma permanente; ciérralo (Ctrl+C) al terminar. Para uso real,
  primero cerramos autenticación (JWT/SSO) y lo desplegamos en un servidor fijo.
