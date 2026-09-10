# Tutoriales guiados por sección (v81)

Cada sección del panel (`/admin/`) tiene un **tutorial auto-explicativo** en dos formatos:

1. **Tour interactivo con voz** — se reproduce como un video *sobre la interfaz real*: resalta cada
   elemento paso a paso, lo narra por voz (Web Speech API del navegador, voz en español), avanza
   solo, y permite pausar, retroceder, saltar o silenciar. Siempre refleja la versión actual de la
   app porque se dibuja en vivo.
2. **Video MP4 (sin voz)** — grabación silenciosa de ese mismo tour, con el texto de cada paso en
   pantalla, para verlo desde el Centro de aprendizaje o compartirlo fuera de la plataforma
   (`webadmin/videos/<seccion>.mp4`).

## Cómo lo ve el usuario

- **Primera vez** en una sección → el tutorial se abre solo (tarjeta de bienvenida con «Empezar»,
  «Ver video» y «Ahora no»). Se recuerda por navegador (`localStorage`), por sección.
- **Siempre disponible** → botón **▶ Tutorial** junto al título de la sección (con un punto
  naranja si aún no lo vio) y **🎓 Centro de aprendizaje** al pie del menú lateral, con el
  progreso (secciones recorridas), todos los tours y videos, y dos ajustes: abrir automáticamente
  la primera vez y narración por voz.
- Atajos durante el tour: `→` siguiente, `←` anterior, `espacio` pausa, `Esc` salir.
- Los pasos se adaptan al **rol** (un cliente no ve pasos de staff) y a lo que existe en pantalla
  (si un botón no está disponible para ese usuario, el paso se omite solo). Los módulos con
  candado por plan no muestran tutorial.

## Archivos

| Archivo | Qué es |
|---|---|
| `webadmin/tutorial.js` | Motor: overlay con foco, tarjeta, narración, auto-avance, centro de aprendizaje, reproductor de video, modo grabación. Autocontenido (inyecta su CSS). |
| `webadmin/tutorial-guides.js` | **Contenido** de cada tutorial (texto por paso, selector del elemento a resaltar, acciones previas como abrir una pestaña). Es el único archivo que hay que tocar para cambiar lo que se dice. |
| `webadmin/videos/*.mp4` + `manifest.json` | Videos grabados y su índice (el Centro de aprendizaje habilita el botón 🎬 solo si el video existe en el manifest). |
| `scripts/record-tutorials.js` | Graba los MP4 con Playwright + TTS + ffmpeg. |
| `scripts/prepare-demo-for-videos.js` | Rellena datos demo (cola de preparación, devoluciones, embalajes, auditoría IA, conteo) para no grabar pantallas vacías. |
| `app.js` (3 líneas) | Avisa al motor en cada cambio de sección (`NinjaTour.onPage`) y le pasa `go()` y el rol. |

## Editar el contenido de un tutorial

En `webadmin/tutorial-guides.js`, cada sección es una entrada:

```js
orders: {
  icon:'🗎', title:'Órdenes',
  summary:'Texto de la tarjeta de bienvenida (y primera frase narrada).',
  steps:[
    { el:'#ord-filters', title:'Filtra por estado', text:'Texto del paso. Admite <b>negritas</b>.', place:'bottom' },
    { el:'#drawer .panel', title:'Detalle', text:'…',
      before:function(h){ h.click('#ord-body tr.click'); return function(){ /* limpieza al salir */ }; } },
    { el:'#bd-kpis', title:'Solo staff', text:'…', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN'] }
  ],
  tips:['Consejos que aparecen en la tarjeta final.']
}
```

- `el` acepta un selector o una lista de alternativas (`['#a','#b']`); si nada es visible, el paso se salta.
- `place` sugiere dónde poner la tarjeta (`top|bottom|left|right`); si no cabe, se recoloca sola.
- Después de editar textos, **vuelve a grabar** el video de esa sección (abajo) para que coincida.

## Volver a grabar los videos

```bash
npm run build && npm run start:demo            # servidor con datos demo en memoria (otra terminal)
node scripts/prepare-demo-for-videos.js        # enriquece los datos demo
node scripts/record-tutorials.js               # todos; o --only=orders,inbound
```

Requisitos en la máquina que graba: `ffmpeg` y Chromium de Playwright (`npx playwright install chromium`).

Por defecto los videos se graban **sin voz** (`TTS=none`): cada paso dura un tiempo de lectura
cómodo según el largo de su texto. Si algún día quieres narración:

- `TTS=espeak` → `espeak-ng` + voces MBROLA en español (offline, gratis, voz sintética).
- `TTS=openai` + `OPENAI_API_KEY` → OpenAI TTS (`gpt-4o-mini-tts`, voz `nova`; cambia con
  `OPENAI_TTS_VOICE`), voz natural por centavos de dólar. Otro TTS se integra en `synth()`.

Los videos se graban a 1440×900, 20 fps, H.264 sin pista de audio, ~1 MB por minuto (≈33 MB los 34). Se sirven
como archivos estáticos desde `/admin/videos/` y van dentro de la imagen Docker.
Si prefieres no incluirlos en la imagen, súbelos a un bucket y cambia la ruta en `openVideo()`.

## Notas de producto

- La narración del tour interactivo usa la voz del navegador del usuario (Chrome/Edge en escritorio
  traen voces en español de buena calidad; Safari también). Si el navegador no tiene voz en español,
  el tour avanza por tiempo de lectura, sin audio.
- El botón **▶ Tutorial** muestra solo el ícono en pantallas de menos de 1560 px de ancho.
- La app móvil del operario (`/app/`) no tiene tutoriales todavía; es un buen siguiente paso.
