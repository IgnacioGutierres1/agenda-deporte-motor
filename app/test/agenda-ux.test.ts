import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  WEEKEND,
  emptyDayText,
  groupSessionsByDay,
  isLateNight,
  nextSessionFrom,
  pendingTitle,
  relativeDay,
  shortDayLabel,
} from '../src/lib/agenda.ts';
import { sessionsInPeriod } from '../src/lib/grid.ts';
import { zoneDisplayName } from '../src/lib/format.ts';
import { centeredScrollLeft } from '../src/lib/tabStrip.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { NOW, scheduleFixture } from './helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';
const all = () => true;

describe('días dentro de una tarjeta (vista Finde)', () => {
  it('agrupa por día local con subtítulos "Viernes 13"', () => {
    const items = sessionsInPeriod(
      scheduleFixture(),
      { startUtc: '2026-11-13T03:00:00Z', endUtc: '2026-11-16T03:00:00Z' },
      (s) => s.id === 'tc',
      NOW,
    );
    const groups = groupSessionsByDay(items, AR);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.session.name)])).toEqual([
      ['Viernes 13', ['Entrenamiento 1']],
      ['Sábado 14', ['Clasificación']],
      ['Domingo 15', ['Final']],
    ]);
  });

  it('el día depende de la zona elegida (una sesión de madrugada cambia de día)', () => {
    const schedule = scheduleFixture();
    // MotoGP Q2 es 09:50Z: sábado 06:50 en Argentina, sábado 18:50 en Tokio.
    const items = sessionsInPeriod(schedule, { startUtc: '2026-11-14T00:00:00Z', endUtc: '2026-11-14T12:00:00Z' }, (s) => s.id === 'motogp', NOW);
    expect(groupSessionsByDay(items, AR)[0]!.date).toBe('2026-11-14');
    expect(groupSessionsByDay(items, 'Pacific/Auckland')[0]!.label).toBe('Sábado 14');
    expect(shortDayLabel('2026-11-15', AR)).toBe('Domingo 15');
  });
});

describe('madrugada', () => {
  it('00:00 a 06:59 en la zona del usuario', () => {
    expect(isLateNight('2026-11-14T03:00:00Z', AR)).toBe(true); // 00:00
    expect(isLateNight('2026-11-14T09:59:00Z', AR)).toBe(true); // 06:59
    expect(isLateNight('2026-11-14T10:00:00Z', AR)).toBe(false); // 07:00
    expect(isLateNight('2026-11-14T02:59:00Z', AR)).toBe(false); // 23:59 del viernes
    // La misma sesión no es de madrugada en otra zona.
    expect(isLateNight('2026-11-14T05:15:00Z', AR)).toBe(true);
    expect(isLateNight('2026-11-14T05:15:00Z', 'Asia/Tokyo')).toBe(false);
  });
});

describe('estado vacío de un día', () => {
  it('textos según el día elegido', () => {
    const today = '2026-11-12';
    expect(emptyDayText(today, today, AR)).toBe('Hoy no hay sesiones');
    expect(emptyDayText('2026-11-13', today, AR)).toBe('Mañana no hay sesiones');
    expect(emptyDayText('2026-11-11', today, AR)).toBe('Ayer no hay sesiones');
    expect(emptyDayText('2026-11-16', today, AR)).toBe('No hay sesiones el lunes 16');
    expect(emptyDayText(WEEKEND, today, AR)).toBe('Este fin de semana no hay sesiones');
  });

  it('día relativo para la próxima sesión', () => {
    const today = '2026-11-12';
    expect(relativeDay('2026-11-12', today, AR)).toBe('hoy');
    expect(relativeDay('2026-11-13', today, AR)).toBe('mañana');
    expect(relativeDay('2026-11-15', today, AR)).toBe('el domingo 15');
    expect(relativeDay('2026-11-27', today, AR)).toBe('el vie 27 nov');
  });

  it('próxima sesión desde un instante, solo de categorías visibles', () => {
    const schedule = scheduleFixture();
    const next = nextSessionFrom(schedule, '2026-11-15T17:30:00Z', all)!;
    expect(next.series.id).toBe('f1');
    expect(next.session.name).toBe('Práctica 1');
    expect(next.event?.id).toBe('ev-f1-qatar');
    expect(nextSessionFrom(schedule, '2026-11-15T17:30:00Z', (s) => s.id !== 'f1')!.session.name).toBe('Carrera Sprint');
    expect(nextSessionFrom(schedule, '2027-01-01T00:00:00Z', all)).toBeNull();
    expect(nextSessionFrom(null, NOW, all)).toBeNull();
  });

  it('título de los eventos sin horarios: "Este fin de semana" solo dentro del finde', () => {
    const jueves = '2026-11-12T15:00:00Z';
    expect(pendingTitle(WEEKEND, jueves, AR)).toBe('Este fin de semana, horarios a confirmar');
    expect(pendingTitle('2026-11-14', jueves, AR)).toBe('Este fin de semana, horarios a confirmar');
    expect(pendingTitle('2026-11-20', jueves, AR)).toBe('Horarios a confirmar');
  });
});

describe('store: día vacío y pendientes', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('un día sin sesiones ofrece la próxima; los pendientes solo aparecen en sus fechas', () => {
    const store = useScheduleStore();
    // Jueves 12/11 a la tarde: TC Pista (13–15/11, sin horarios) no corre hoy.
    store.$patch({ schedule: scheduleFixture(), now: '2026-11-12T18:00:00Z' });
    expect(store.selectedDay).toBe('2026-11-12');
    expect(store.agendaCards).toEqual([]);
    expect(store.agendaPending).toEqual([]);
    expect(store.agendaNext?.session.id).toBe('a1b2c3d4e5f60001'); // TC Entrenamiento 1, viernes 14:00

    store.setAgendaDay('2026-11-13');
    expect(store.agendaPending.map((p) => p.event.id)).toEqual(['ev-tcp-sannicolas']);
    store.setAgendaDay('2026-11-16');
    expect(store.agendaPending).toEqual([]);
    // Día futuro vacío: la próxima es desde el comienzo de ese día.
    expect(store.agendaNext?.series.id).toBe('f1');
  });
});

describe('zona horaria en la Agenda', () => {
  it('nombre legible', () => {
    expect(zoneDisplayName(AR)).toBe('Hora Argentina');
    expect(zoneDisplayName('America/Santiago')).toBe('Hora de Chile');
    expect(zoneDisplayName('UTC')).toBe('Hora UTC');
    expect(zoneDisplayName('Asia/Tokyo')).toBe('Hora de Tokyo');
  });
});

describe('franjas deslizables', () => {
  function fakeStrip(scrollLeft: number) {
    const el = {
      scrollLeft,
      scrollWidth: 800,
      clientWidth: 300,
      getBoundingClientRect: () => ({ left: 0, width: 300 }),
    } as unknown as HTMLElement;
    return el;
  }
  const child = (left: number, width: number) => ({ getBoundingClientRect: () => ({ left, width }) }) as unknown as HTMLElement;

  it('centra la pestaña activa sin pasarse de los bordes', () => {
    // Pestaña en x=500 del contenido (visible en -100 con scroll 600): queda centrada.
    expect(centeredScrollLeft(fakeStrip(600), child(-100, 100))).toBe(400);
    // La primera pestaña ("Resumen") vuelve a 0 aunque la franja venga con scroll de otra categoría.
    expect(centeredScrollLeft(fakeStrip(500), child(-500, 90))).toBe(0);
    // La última no pasa del máximo.
    expect(centeredScrollLeft(fakeStrip(0), child(780, 20))).toBe(500);
  });
});
