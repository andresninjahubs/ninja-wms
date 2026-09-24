/**
 * Reloj propio del agente (Fase 1 del agente autónomo).
 *
 * Antes, el barrido de reglas lo disparaba el navegador del administrador cada 30 s: con el
 * panel cerrado, el agente no existía. Este scheduler corre en el SERVIDOR: cada
 * AGENT_INTERVAL_SEC (def. 120 s) recorre las operaciones activas y ejecuta un ciclo del
 * agente en cada una, con lock por operación (nunca dos ciclos a la vez) y jitter para no
 * alinear todas las operaciones en el mismo segundo. Además corre el rollup diario de
 * analítica a la hora AGENT_ROLLUP_HOUR_UTC (def. 03:00 UTC) que los comentarios del
 * código prometían y nadie invocaba.
 *
 * Nota: el lock es en memoria del proceso. Con UNA instancia (Railway hoy) es suficiente;
 * con varias réplicas se necesita un lock en base de datos (fase posterior).
 */
import type { WmsFacade } from '../app/wms.facade';

export interface AgentSchedulerHandle { stop(): void; }

export function startAgentScheduler(facade: WmsFacade, log: (msg: string) => void = () => undefined): AgentSchedulerHandle | null {
  if (process.env.AGENT_SCHEDULER === 'false') { log('Agente: scheduler desactivado (AGENT_SCHEDULER=false).'); return null; }
  const intervalSec = Math.max(30, Number(process.env.AGENT_INTERVAL_SEC || 120));
  const rollupHour = Number(process.env.AGENT_ROLLUP_HOUR_UTC ?? 3);
  let lastRollupDay = '';
  let ticking = false;

  const tick = async () => {
    if (ticking) return; // el tick anterior sigue corriendo (muchas operaciones o LLM lento)
    ticking = true;
    try {
      const ops = (await facade.listOperations()).filter((o) => o.active !== false);
      for (const op of ops) {
        try {
          const r = await facade.runAgentCycle(op.id, { by: 'scheduler' });
          if (r.barrido && (r.barrido.nuevas || r.barrido.ejecutadas || r.barrido.sombra)) {
            log(`Agente [${op.name || op.id}]: ${r.barrido.nuevas} alerta(s), ${r.barrido.ejecutadas} ejecutada(s), ${r.barrido.propuestas} propuesta(s), ${r.barrido.sombra} sombra${r.llm?.ran ? ', LLM' : ''}.`);
          }
        } catch (e) {
          log(`Agente [${op.id}]: ciclo falló: ${(e as Error).message}`);
        }
        // jitter pequeño entre operaciones
        await new Promise((r) => setTimeout(r, 250));
      }
      // Rollup diario de analítica (una vez al día, a la hora configurada).
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (now.getUTCHours() >= rollupHour && lastRollupDay !== day) {
        lastRollupDay = day;
        for (const op of ops) {
          try { await facade.runRollups(op.id, {}); } catch (e) { log(`Rollup [${op.id}] falló: ${(e as Error).message}`); }
        }
        log(`Rollup diario de analítica ejecutado para ${ops.length} operación(es).`);

        // Reajuste de los tiempos de tarea, después del rollup y una vez al día.
        // De noche y no en caliente porque recorre el ledger completo y porque los
        // coeficientes no deben moverse a mitad de turno: un supervisor que ve la
        // carga cambiar sola mientras reparte trabajo deja de confiar en la pantalla.
        for (const op of ops) {
          try {
            const r = await facade.learnTaskTimes(op.id);
            const ok = r.etapas.filter((e) => e.ajustado);
            if (ok.length) {
              log(`Tiempos [${op.name || op.id}]: ${ok.map((e) => `${e.stage} (${e.samples} tareas, error ${e.errorMedioMin} min)`).join(', ')}`);
            }
          } catch (e) { log(`Tiempos [${op.id}] falló: ${(e as Error).message}`); }
        }
        // Y el modelo global, que es el que hereda una bodega nueva sin datos propios.
        try {
          const g = await facade.learnPlatformTaskTimes();
          const ok = g.etapas.filter((e) => e.ajustado);
          if (ok.length) log(`Tiempos de plataforma: ${ok.map((e) => `${e.stage} (${e.samples})`).join(', ')}`);
        } catch (e) { log(`Tiempos de plataforma falló: ${(e as Error).message}`); }
      }
    } finally {
      ticking = false;
    }
  };

  const first = setTimeout(() => { void tick(); }, 15000); // primer ciclo 15 s tras el arranque
  const timer = setInterval(() => { void tick(); }, intervalSec * 1000);
  // No mantener vivo el proceso solo por el timer (tests / cierres limpios).
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  if (typeof (first as any).unref === 'function') (first as any).unref();
  log(`Agente: scheduler activo cada ${intervalSec} s (rollup diario a las ${String(rollupHour).padStart(2, '0')}:00 UTC).`);
  return { stop: () => { clearInterval(timer); clearTimeout(first); } };
}
