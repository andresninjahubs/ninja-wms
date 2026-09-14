# Correr el WMS en tu Mac (guía sin tecnicismos)

La idea: dejar el sistema funcionando en **tu propio computador**, para verlo en el
navegador en `http://localhost:3000/admin/`. Solo tú lo ves (no es una URL pública),
pero es perfecto para revisarlo cuando quieras, sin depender de nadie.

Son **dos pasos la primera vez**, y después es un solo doble clic.

---

## Paso 1 — Instalar "Node.js" (una sola vez, 2 minutos)

Node.js es el motor que hace funcionar el sistema. Es gratis y oficial.

1. Abre en tu navegador: **https://nodejs.org**
2. Descarga el botón grande que dice **"LTS"** (es la versión recomendada).
3. Abre el archivo descargado (`.pkg`) y dale **Continuar → Instalar**. Te pedirá tu
   contraseña de Mac; es normal.
4. Cuando diga que terminó, listo. No hay que configurar nada.

> ¿Cómo sé si ya lo tengo? No pasa nada si lo instalas igual; si ya estaba, simplemente
> lo actualiza. El lanzador del Paso 2 también te avisa si falta.

---

## Paso 2 — Descomprimir el proyecto y encenderlo

1. Descarga el archivo **`ninjahubs-wms-skeleton.zip`** que te envié y haz **doble clic**
   para descomprimirlo. Se crea una carpeta llamada **`wms`**.
2. Entra a la carpeta `wms`. Adentro busca el archivo **`INICIAR-WMS-mac.command`**.
3. Haz **doble clic** en ese archivo.
   - La **primera vez**, macOS puede decir que "no se puede abrir porque es de un
     desarrollador no identificado". Si pasa: haz **clic derecho** sobre el archivo →
     **Abrir** → en la ventana que aparece, **Abrir** de nuevo. (Esto solo se pide una vez.)
4. Se abrirá una ventana negra (la Terminal) que va mostrando el avance. La primera vez
   tarda 1-2 minutos porque descarga componentes. **Es normal, déjala trabajar.**
5. Cuando esté listo, **se abre solo tu navegador** en el panel. 🎉

---

## Entrar al sistema

El ingreso ahora es con **email y contraseña** (autenticación real). Usa uno de estos:

| Email                  | Contraseña  | Qué ve                                              |
|------------------------|-------------|-----------------------------------------------------|
| `admin@ninjahubs.cl`    | `admin1234` | **Todo** — las dos operaciones (super-admin)        |
| `ana@ninjahubs.cl`     | `demo1234`  | Administradora de **Bodega Ninja Hubs**             |
| `nora@andes.cl`        | `demo1234`  | Administradora de **Bodega Andes** (aislada)        |
| `carla@acme.cl`        | `demo1234`  | **Cliente**: solo ve su empresa (ACME)              |

Dentro del panel puedes **cambiar tu propia contraseña** (botón 🔑 arriba a la derecha),
**cerrar sesión** (botón Salir), y —si eres admin— crear usuarios con contraseña inicial
o **restablecer** la de cualquiera desde el mantenedor de Usuarios (botón "Clave").

- Panel de administración: **http://localhost:3000/admin/**
- App de bodega (con escáner, pensada para el celular): **http://localhost:3000/app/**

---

## Apagar y volver a encender

- **Apagar:** cierra la ventana negra (la Terminal), o presiona **Control + C** dentro
  de ella. El sistema se detiene.
- **Volver a encender:** vuelve a hacer doble clic en `INICIAR-WMS-mac.command`. De la
  segunda vez en adelante arranca en segundos.

---

## Cosas normales que NO son errores

- Los datos son de **demostración** y viven mientras el sistema está encendido. Si lo
  apagas y lo prendes, vuelven al estado inicial (sirve para probar sin miedo).
- La ventana negra debe quedar **abierta** mientras uses el sistema; es la que lo
  mantiene encendido. Minimízala si molesta, pero no la cierres hasta terminar.
- `localhost` significa "este mismo computador". Por eso la dirección solo funciona en
  tu Mac; para que lo vean desde otros dispositivos, es el despliegue en Render (ver
  `DESPLIEGUE-URL-PUBLICA.md`).

¿Se te complica algún paso? Dime en cuál quedaste y te ayudo.
