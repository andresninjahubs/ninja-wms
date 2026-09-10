# Semilla de alto volumen — demo del LLM sobre miles de órdenes

Genera una bodega con **decenas de miles de órdenes reales** (ciclo completo:
ingreso → reserva → picking → empaque → **despacho**), procesadas por **10 operarios
con rendimientos distintos**, más movimiento de stock (recepciones, guardados,
transferencias de re-slotting y re-alocaciones/cancelaciones), a lo largo de los
**últimos 60 días**. Es el escenario ideal para mostrar la potencia del copiloto/LLM
consultando un WMS con historia densa.

## Cómo correrlo (local, en memoria — recomendado)

```bash
npm install
npm run build
npm run start:showcase          # 50.000 órdenes (arranca en ~60-90 s)
# o, para un arranque más rápido:
npm run start:showcase:quick    # 12.000 órdenes (~20 s)
```

Luego abre el panel conectado en `http://localhost:3000/admin/`
(usuario `admin@ninjahubs.cl`, clave `admin1234`) y la PWA de operario en
`http://localhost:3000/app/`.

El volumen se controla con la variable `SEED_VOLUME`:

```bash
SEED_DEMO=true PERSISTENCE=memory SEED_VOLUME=30000 node --max-old-space-size=8192 dist/src/main.js
```

Notas:
- Es **en memoria**: se regenera en cada arranque (por eso es rápido y autocontenido).
  Verás el progreso en consola (`[vol] 2000 órdenes…`).
- Usa `--max-old-space-size=8192` para volúmenes altos (50k caben cómodos en 8 GB).
- Todos los datos se concentran en la operación **Bodega Ninja Hubs** / cliente **ACME**.

## Qué queda poblado (ejemplo con 50.000)

- **~50.300 órdenes**, la mayoría **DESPACHADAS** (ciclo completo), con algunas en
  PACKED/PICKED/RECEIVED y ~1.000 **canceladas** (re-alocaciones que liberan stock).
- **10 operarios** con productividad claramente diferenciada (de ~94 a ~34 unidades/hora)
  — visible en **Reportes** y en `GET /labor/productivity`.
- **~110.000 movimientos de stock/mes**: recepciones, guardados, reservas, picks,
  transferencias de re-slotting.
- **Event store** con el historial de cada orden (paridad viejo/nuevo verificada),
  **rollups diarios** de inventario y demanda (serie lista para forecasting) y
  **snapshots** de inventario por SKU/estado.
- Catálogo amplio de SKUs (se escala con el volumen) para un inventario realista.

## Ideas para la demo del copiloto/LLM

Con una IA conectada (Configuración → IA), prueba preguntas como:
- «¿Cuáles fueron los 5 operarios más productivos el último mes y sus unidades/hora?»
- «Dame la línea de tiempo de la orden V-ACME-100042 y cuántas horas tomó de ingreso a despacho.»
- «¿Qué SKUs concentran la demanda de las últimas 4 semanas? ¿Hay riesgo de quiebre?»
- «¿Cuántas órdenes se despacharon por canal y cómo evolucionó vs. el período anterior?»
- «Muéstrame los tiempos promedio entre estados (reserva → picking → despacho).»

## Producción (Postgres)

La semilla de volumen está pensada para el modo **memoria** (demo instantánea y
autocontenida). Con Postgres cada escritura va a la base, así que poblar 50k órdenes
toma bastante más y conviene hacerlo de forma deliberada una sola vez (los datos
persisten). Para producción real, el volumen entra por el uso normal del sistema.
