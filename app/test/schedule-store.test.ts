import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  eventResultsFileSchema,
  scheduleFileSchema,
  standingsFileSchema,
  statusFileSchema,
} from '@dm/shared';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { NOW, fixture, scheduleFixture, statusFixture } from './helpers.ts';

function setup() {
  const store = useScheduleStore();
  store.$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  return store;
}

describe('fixtures', () => {
  it('cumplen los esquemas compartidos', () => {
    expect(scheduleFileSchema.safeParse(scheduleFixture()).success).toBe(true);
    expect(statusFileSchema.safeParse(statusFixture()).success).toBe(true);
    expect(standingsFileSchema.safeParse(fixture('standings/tc.json')).success).toBe(true);
    expect(eventResultsFileSchema.safeParse(fixture('results/tc/ev-tc-sannicolas.json')).success).toBe(true);
  });
});

describe('store de la grilla', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('"Este finde" toma viernes 00:00 a lunes 00:00 en Argentina', () => {
    const store = setup();
    expect(store.period).toEqual({ startUtc: '2026-11-13T03:00:00Z', endUtc: '2026-11-16T03:00:00Z' });
    const ids = store.items.map((i) => i.session.id);
    // TC (3), MotoGP (2) y Copa Truck (1); F1/F2 de Qatar quedan afuera.
    expect(ids).toEqual([
      'a1b2c3d4e5f60001',
      'b1b2c3d4e5f60001',
      'a1b2c3d4e5f60002',
      'c1b2c3d4e5f60001', // 13:00Z, mismo horario que MotoGP: desempata por nombre (Copa Truck < MotoGP)
      'b1b2c3d4e5f60002',
      'a1b2c3d4e5f60003',
    ]);
  });

  it('agrupa por día en la zona de visualización', () => {
    const store = setup();
    expect(store.days.map((d) => [d.date, d.items.length])).toEqual([
      ['2026-11-13', 1],
      ['2026-11-14', 2],
      ['2026-11-15', 3],
    ]);
    expect(store.days[1]!.label).toBe('sábado 14 de noviembre');
  });

  it('cambia el agrupamiento si cambia la zona', () => {
    const store = setup();
    useSettingsStore().timeZone = 'Asia/Tokyo';
    // 17:00Z del viernes es sábado 02:00 en Tokio.
    expect(store.days[0]!.date).toBe('2026-11-14');
  });

  it('marca en vivo y terminadas según "now"', () => {
    const store = setup();
    const byId = new Map(store.items.map((i) => [i.session.id, i]));
    expect(byId.get('a1b2c3d4e5f60002')!.live).toBe(true);
    expect(byId.get('a1b2c3d4e5f60001')!.finished).toBe(true);
    expect(byId.get('a1b2c3d4e5f60003')!.finished).toBe(false);
  });

  it('lista eventos con horarios pendientes del período', () => {
    const store = setup();
    expect(store.pendingEvents.map((p) => p.event.id)).toEqual(['ev-tcp-sannicolas']);
  });

  it('respeta el filtro de categorías del dispositivo y las series desactivadas', () => {
    const store = setup();
    useSettingsStore().setManyVisible(['tc', 'tc-pista'], false);
    expect(store.items.some((i) => i.series.id === 'tc')).toBe(false);
    expect(store.pendingEvents).toEqual([]);
    store.schedule!.series.find((s) => s.id === 'motogp')!.enabled = false;
    expect(store.items.map((i) => i.series.id)).toEqual(['copa-truck']);
  });

  it('"Próximos 4 findes" incluye Qatar', () => {
    const store = setup();
    store.setPreset('proximos-4-findes');
    expect(store.items.filter((i) => i.event?.id === 'ev-f1-qatar')).toHaveLength(2);
    expect(store.items.some((i) => i.session.id === 'e1b2c3d4e5f60001')).toBe(true);
  });

  it('personalizado usa fechas inclusivas e informa errores', () => {
    const store = setup();
    store.$patch({ customFrom: '2026-11-28', customTo: '2026-11-28' });
    store.setPreset('personalizado');
    expect(store.items.map((i) => i.session.id)).toEqual(['e1b2c3d4e5f60001']);
    store.$patch({ customFrom: '2026-11-29', customTo: '2026-11-28' });
    expect(store.periodError).toMatch(/posterior/);
  });

  it('incluir jueves adelanta el inicio del finde', () => {
    const store = setup();
    store.includeThursday = true;
    expect(store.period.startUtc).toBe('2026-11-12T03:00:00Z');
  });

  it('las exclusiones de exportación sacan sesiones', () => {
    const store = setup();
    store.setExcluded('a1b2c3d4e5f60001', true);
    expect(store.exportItems).toHaveLength(store.items.length - 1);
    store.setAllExcluded(true);
    expect(store.exportItems).toHaveLength(0);
    store.setAllExcluded(false);
    expect(store.exportItems).toHaveLength(store.items.length);
  });

  it('auditoría: estados por serie', () => {
    const store = setup();
    const states = Object.fromEntries(store.auditRows.map((r) => [r.series.id, r.state]));
    expect(states).toEqual({
      f1: 'receso',
      f2: 'receso',
      motogp: 'activa',
      'nascar-cup': 'receso',
      tc: 'activa',
      'tc-pista': 'pendiente',
      'turismo-nacional': 'error',
      'top-race': 'desactivada',
      'copa-truck': 'activa',
    });
    const f2 = store.auditRows.find((r) => r.series.id === 'f2')!;
    expect(f2.stale).toBe(true);
    expect(f2.nextEvent?.id).toBe('ev-f2-qatar');
  });
});
