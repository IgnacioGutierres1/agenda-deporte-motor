import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import GridView from './views/GridView.vue';

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'grilla', component: GridView, meta: { title: 'Grilla' } },
  { path: '/exportar', name: 'exportar', component: () => import('./views/ExportView.vue'), meta: { title: 'Exportar' } },
  {
    path: '/campeonatos/:seriesId?',
    name: 'campeonatos',
    component: () => import('./views/ChampionshipsView.vue'),
    meta: { title: 'Campeonatos' },
  },
  { path: '/auditoria', name: 'auditoria', component: () => import('./views/AuditView.vue'), meta: { title: 'Auditoría' } },
  { path: '/ajustes', name: 'ajustes', component: () => import('./views/SettingsView.vue'), meta: { title: 'Ajustes' } },
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
