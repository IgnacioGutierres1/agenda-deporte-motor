import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import AgendaView from './views/AgendaView.vue';

/** meta.root: pantalla de la barra inferior (título grande, sin botón Volver). */
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'agenda', component: AgendaView, meta: { title: 'Agenda', root: true } },
  {
    path: '/categorias',
    name: 'categorias',
    component: () => import('./views/CategoriesView.vue'),
    meta: { title: 'Categorías', root: true },
  },
  {
    path: '/categoria/:seriesId',
    name: 'categoria',
    component: () => import('./views/CategoryView.vue'),
    meta: { title: 'Categoría' },
  },
  {
    path: '/evento/:eventId',
    name: 'evento',
    component: () => import('./views/EventView.vue'),
    meta: { title: 'Evento' },
  },
  {
    path: '/piloto/:driverId',
    name: 'piloto',
    component: () => import('./views/DriverView.vue'),
    meta: { title: 'Piloto' },
  },
  {
    path: '/siguiendo',
    name: 'siguiendo',
    component: () => import('./views/FollowingView.vue'),
    meta: { title: 'Siguiendo', root: true },
  },
  { path: '/exportar', name: 'exportar', component: () => import('./views/ExportView.vue'), meta: { title: 'Exportar' } },
  { path: '/auditoria', name: 'auditoria', component: () => import('./views/AuditView.vue'), meta: { title: 'Auditoría' } },
  { path: '/ajustes', name: 'ajustes', component: () => import('./views/SettingsView.vue'), meta: { title: 'Ajustes' } },
  // Direcciones de la versión anterior.
  {
    path: '/campeonatos/:seriesId?',
    redirect: (to) =>
      to.params.seriesId
        ? { path: `/categoria/${String(to.params.seriesId)}`, query: { tab: to.query.tab === 'resultados' ? 'resultados' : 'tabla' } }
        : { path: '/categorias' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

/** Historial con hash: funciona en GitHub Pages bajo sub-ruta y al recargar cualquier pantalla. */
export function createAppRouter() {
  return createRouter({
    history: createWebHashHistory(import.meta.env.BASE_URL),
    routes,
    scrollBehavior(_to, _from, saved) {
      return saved ?? { top: 0 };
    },
  });
}
