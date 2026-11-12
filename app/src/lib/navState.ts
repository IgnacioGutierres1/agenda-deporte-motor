import { reactive } from 'vue';

/**
 * Estado compartido con la barra inferior: en la ficha de un piloto o equipo que no existe no se
 * marca ninguna pestaña (la ficha de un piloto normalmente marca "Siguiendo").
 */
export const navState = reactive({ notFound: false });
