/** Token de inyección para la fachada del WMS. */
export const WMS_FACADE = Symbol('WMS_FACADE');
/** Token del contexto completo (fachada + reloj + persistencia). */
export const WMS_CONTEXT = Symbol('WMS_CONTEXT');
/** Token del reloj mutable (la semilla lo usa para retro-fechar historia). */
export const WMS_CLOCK = Symbol('WMS_CLOCK');
