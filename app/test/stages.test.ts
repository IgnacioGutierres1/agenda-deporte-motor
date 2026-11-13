import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  eventStagesFileSchema,
  scheduleFileSchema,
  statusFileSchema,
  type EventStagesFile,
  type MotorEvent,
  type RallyStage,
  type ScheduleFile,
  type Series,
} from '@dm/shared';
import {
  eventDays,
  formatKm,
  groupStagesByDay,
  hasStages,
  isCompetitive,
  itineraryKind,
  liveStage,
  liveWindowMs,
  noTimesNote,
  periodDates,
  sortStages,
  stageAgendaCard,
  stageCountText,
  stageDayRows,
  stageDistanceText,
  stageEventsOn,
  stageExtraKmText,
  stageStates,
  stageTime,
  stageTitle,
  stagesEventStatus,
  stagesSummary,
  terrainBars,
} from '../src/lib/stages.ts';
import { agendaPeriod } from '../src/lib/agenda.ts';
import { buildAuditRows } from '../src/lib/grid.ts';
import { stagesKey, useStagesStore } from '../src/stores/stages.ts';
import { fixture } from './helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';
const schedule = () => fixture<ScheduleFile>('rally/schedule.json');
const wrc = () => fixture<EventStagesFile>('rally/stages/wrc/ev-wrc-japon.json');
const dakar = () => fixture<EventStagesFile>('rally/stages/dakar/ev-dakar-2027.json');
const eventOf = (id: string): MotorEvent => schedule().events.find((e) => e.id === id)!;
const visible = (s: Series) => s.enabled;
const codes = (stages: RallyStage[], states: string[], state: string) => stages.filter((_, i) => states[i] === state).map((s) => s.code);

const stage = (over: Partial<RallyStage>): RallyStage => ({ code: 'SS1', name: 'Tramo', kind: 'especial', date: '2026-05-01', ...over });

describe('fixtures de rally', () => {
  it('cumplen el contrato compartido', () => {
    expect(scheduleFileSchema.safeParse(schedule()).success).toBe(true);
    expect(statusFileSchema.safeParse(fixture('rally/status.json')).success).toBe(true);
    expect(eventStagesFileSchema.safeParse(wrc()).success).toBe(true);
    expect(eventStagesFileSchema.safeParse(dakar()).success).toBe(true);
  });

  it('cada itinerario corresponde a un evento con stageCount y sus tramos apuntan a sesiones que existen', () => {
    const s = schedule();
    for (const file of [wrc(), dakar()]) {
      const event = s.events.find((e) => e.id === file.eventId)!;
      expect(event.seriesId).toBe(file.seriesId);
      // Como los lectores: tramos o etapas cronometrados (sin shakedown, traslado ni descanso; los cancelados cuentan).
      expect(event.stageCount).toBe(file.stages.filter(isCompetitive).length);
      for (const st of file.stages) {
        expect(st.date >= event.dateStart && st.date <= event.dateEnd).toBe(true);
        if (st.sessionId) expect(s.sessions.some((x) => x.id === st.sessionId && x.eventId === event.id)).toBe(true);
      }
    }
    // WRC: bloques por día (etapa), shakedown como práctica y Power Stage como carrera. Dakar: sin sesiones.
    expect(s.sessions.filter((x) => x.eventId === 'ev-wrc-japon').map((x) => x.type)).toEqual(['practica', 'etapa', 'etapa', 'etapa', 'etapa', 'carrera']);
    expect(s.sessions.some((x) => x.eventId === 'ev-dakar-2027')).toBe(false);
  });
});

describe('tramos o etapas', () => {
  it('un rally con varios tramos por día es "tramos"; uno con una etapa por día, "etapas"', () => {
    expect(itineraryKind(eventOf('ev-wrc-japon'))).toBe('tramos');
    expect(itineraryKind(eventOf('ev-wrc-japon'), wrc().stages)).toBe('tramos');
    expect(itineraryKind(eventOf('ev-dakar-2027'))).toBe('etapas');
    expect(itineraryKind(eventOf('ev-dakar-2027'), dakar().stages)).toBe('etapas');
  });

  it('sin el archivo se guía por la superficie y por la cantidad de renglones contra los días', () => {
    const base = { dateStart: '2026-06-01', dateEnd: '2026-06-06' };
    expect(itineraryKind({ ...base, stageCount: 6, surface: 'tierra' })).toBe('etapas');
    expect(itineraryKind({ ...base, stageCount: 18, surface: 'tierra' })).toBe('tramos');
    expect(itineraryKind({ ...base, stageCount: 18, surface: 'arena' })).toBe('etapas');
    // Con el archivo manda lo publicado: el shakedown no cuenta como segundo tramo del día.
    expect(itineraryKind({ ...base, stageCount: 2 }, [stage({ kind: 'shakedown' }), stage({ code: 'SS1' })])).toBe('etapas');
    expect(itineraryKind({ ...base, stageCount: 2 }, [stage({ code: 'SS1' }), stage({ code: 'SS2' })])).toBe('tramos');
  });

  it('hasStages, días del evento y textos de cantidad', () => {
    expect(hasStages(eventOf('ev-dakar-2027'))).toBe(true);
    expect(hasStages(eventOf('ev-wrc-arabia'))).toBe(false);
    expect(hasStages({ stageCount: 0 })).toBe(false);
    expect(hasStages(undefined)).toBe(false);
    expect(eventDays(eventOf('ev-dakar-2027'))).toBe(15);
    expect(eventDays(eventOf('ev-wrc-japon'))).toBe(4);
    expect(stageCountText(1, 'tramos')).toBe('1 tramo');
    expect(stageCountText(20, 'tramos')).toBe('20 tramos');
    expect(stageCountText(1, 'etapas')).toBe('1 etapa');
    expect(stageCountText(13, 'etapas')).toBe('13 etapas');
  });

  it('formatea los kilómetros con coma decimal y menos decimales en distancias largas', () => {
    expect(formatKm(2.1)).toBe('2,1 km');
    expect(formatKm(23.67)).toBe('23,67 km');
    expect(formatKm(319.87)).toBe('319,9 km');
    expect(formatKm(356)).toBe('356 km');
    expect(formatKm(4429)).toBe('4.429 km');
  });
});

describe('resumen del recorrido', () => {
  it('WRC: superficie, kilómetros de la fuente y tramos sin el shakedown ni los cancelados', () => {
    expect(stagesSummary(wrc(), eventOf('ev-wrc-japon'))).toEqual({
      kind: 'tramos',
      surface: 'asfalto',
      surfaceNote: 'Asfalto angosto de montaña, con hojas y humedad a la sombra',
      count: 20,
      cancelled: 1,
      competitiveKm: 319.87,
      totalKm: 967.14,
      days: 4,
    });
  });

  it('si la fuente no da los totales, suma los tramos que se corren', () => {
    const file = wrc();
    delete file.competitiveKm;
    delete file.totalKm;
    delete file.surface;
    const s = stagesSummary(file, eventOf('ev-wrc-japon'));
    // 319,87 km menos el SS7 cancelado (22,44).
    expect(s.competitiveKm).toBe(297.43);
    expect(s.totalKm).toBeUndefined();
    // Sin superficie en el archivo, vale la del evento.
    expect(s.surface).toBe('asfalto');
  });

  it('Dakar: prólogo y etapas cuentan; descanso y traslado no', () => {
    const file = dakar();
    const s = stagesSummary(file, eventOf('ev-dakar-2027'));
    expect(s).toMatchObject({ kind: 'etapas', surface: 'arena', count: 13, cancelled: 0, competitiveKm: 4429, days: 15 });
    // Como en dakar.com, el traslado no publica kilómetros: no hay total con enlaces.
    expect(s.totalKm).toBeUndefined();
    delete file.competitiveKm;
    // El total cronometrado del organizador coincide con la suma día por día.
    expect(stagesSummary(file, eventOf('ev-dakar-2027')).competitiveKm).toBe(4429);
    // Con todos los días informados, el total sale de la suma.
    const traslado = file.stages.find((x) => x.kind === 'enlace')!;
    traslado.liaisonKm = 647;
    traslado.totalKm = 647;
    expect(stagesSummary(file, eventOf('ev-dakar-2027')).totalKm).toBe(7877);
  });
});

describe('estado de cada tramo (con horas de largada)', () => {
  const stages = () => sortStages(wrc().stages);

  it('marca el tramo en curso, los que ya largaron y el próximo', () => {
    const list = stages();
    // Viernes 09:45 en Japón: el SS4 largó hace 9 minutos.
    const states = stageStates(list, '2026-11-13T00:45:00Z', '2026-11-12');
    expect(codes(list, states, 'past')).toEqual(['Shakedown', 'SS1', 'SS2', 'SS3']);
    expect(codes(list, states, 'live')).toEqual(['SS4']);
    expect(codes(list, states, 'next')).toEqual(['SS5']);
    expect(codes(list, states, 'upcoming')).toHaveLength(16);
    expect(liveStage(wrc().stages, '2026-11-13T00:45:00Z')?.code).toBe('SS4');
  });

  it('pasada la ventana del tramo, no hay ninguno en curso hasta que largue el siguiente', () => {
    const list = stages();
    // El SS4 largó a las 00:36Z; el SS5 larga a las 04:19Z (asistencia del mediodía).
    const states = stageStates(list, '2026-11-13T02:30:00Z', '2026-11-12');
    expect(codes(list, states, 'live')).toEqual([]);
    expect(codes(list, states, 'next')).toEqual(['SS5']);
    expect(liveStage(wrc().stages, '2026-11-13T02:30:00Z')).toBeUndefined();
  });

  it('un tramo cancelado no está en curso ni es el próximo', () => {
    const list = stages();
    // 06:30Z: ya pasó la hora del SS7 (cancelado); sigue en curso el SS6 y el próximo es el SS8.
    const states = stageStates(list, '2026-11-13T06:30:00Z', '2026-11-13');
    expect(codes(list, states, 'live')).toEqual(['SS6']);
    expect(codes(list, states, 'next')).toEqual(['SS8']);
    expect(states[list.findIndex((s) => s.code === 'SS7')]).toBe('past');
    // 05:30Z: el SS7 todavía no "largó", pero el próximo es el SS8.
    const before = stageStates(list, '2026-11-13T05:30:00Z', '2026-11-13');
    expect(codes(list, before, 'next')).toEqual(['SS8']);
    expect(before[list.findIndex((s) => s.code === 'SS7')]).toBe('upcoming');
  });

  it('antes del rally el próximo es el shakedown; al terminar, todo quedó atrás', () => {
    const list = stages();
    const before = stageStates(list, '2026-11-10T12:00:00Z', '2026-11-10');
    expect(codes(list, before, 'next')).toEqual(['Shakedown']);
    expect(codes(list, before, 'past')).toEqual([]);
    const after = stageStates(list, '2026-11-16T12:00:00Z', '2026-11-16');
    expect(new Set(after)).toEqual(new Set(['past']));
  });

  it('la ventana "en curso" depende del tipo de tramo', () => {
    expect(liveWindowMs(stage({ kind: 'shakedown' }))).toBe(180 * 60_000);
    expect(liveWindowMs(stage({ distanceKm: 23.67 }))).toBe(90 * 60_000);
    expect(liveWindowMs(stage({ distanceKm: 356 }))).toBe(600 * 60_000);
    // El shakedown (varias pasadas) sigue en curso dos horas después de largar.
    const list = stages();
    expect(codes(list, stageStates(list, '2026-11-12T02:00:00Z', '2026-11-11'), 'live')).toEqual(['Shakedown']);
  });
});

describe('estado de cada etapa (sin horas, por fecha)', () => {
  const stages = () => sortStages(dakar().stages);

  it('resalta la etapa de hoy y deja las demás por fecha', () => {
    const list = stages();
    const states = stageStates(list, '2027-01-08T15:00:00Z', '2027-01-08');
    expect(codes(list, states, 'today')).toEqual(['Etapa 6']);
    expect(codes(list, states, 'past')).toEqual(['Prólogo', 'Etapa 1', 'Etapa 2', 'Etapa 3', 'Etapa 4', 'Etapa 5']);
    // El descanso no es "la próxima": la próxima etapa es la 7.
    expect(codes(list, states, 'next')).toEqual(['Etapa 7']);
    expect(states[list.findIndex((s) => s.kind === 'descanso')]).toBe('upcoming');
    expect(codes(list, states, 'live')).toEqual([]);
  });

  it('el día de descanso y el de traslado también se resaltan cuando son hoy', () => {
    const list = stages();
    const rest = stageStates(list, '2027-01-09T15:00:00Z', '2027-01-09');
    expect(codes(list, rest, 'today')).toEqual(['Descanso']);
    expect(codes(list, rest, 'next')).toEqual(['Etapa 7']);
    const liaison = stageStates(list, '2027-01-13T15:00:00Z', '2027-01-13');
    expect(codes(list, liaison, 'today')).toEqual(['Traslado']);
    expect(codes(list, liaison, 'next')).toEqual(['Etapa 10']);
  });

  it('antes de empezar, lo próximo es el prólogo', () => {
    const list = stages();
    const states = stageStates(list, '2026-12-30T15:00:00Z', '2026-12-30');
    expect(codes(list, states, 'next')).toEqual(['Prólogo']);
    expect(codes(list, states, 'today')).toEqual([]);
  });

  it('una etapa de rally raid con hora de largada sigue en curso varias horas', () => {
    const list = [stage({ code: 'Etapa 1', date: '2027-01-03', distanceKm: 305, startUtc: '2027-01-03T02:30:00Z' }), stage({ code: 'Etapa 2', date: '2027-01-04', distanceKm: 400 })];
    expect(stageStates(list, '2027-01-03T09:00:00Z', '2027-01-03')).toEqual(['live', 'next']);
    expect(stageStates(list, '2027-01-03T13:00:00Z', '2027-01-03')).toEqual(['past', 'next']);
  });
});

describe('itinerario por día', () => {
  it('agrupa por la fecha del rally, con la cantidad y los kilómetros que se corren', () => {
    const days = groupStagesByDay(wrc().stages);
    expect(days.map((d) => [d.label, d.stages.length, d.count, d.competitiveKm])).toEqual([
      ['Jueves 12 de noviembre', 2, 1, 2.1],
      // 7 tramos publicados, 6 se corren: el SS7 está cancelado.
      ['Viernes 13 de noviembre', 7, 6, 111.08],
      ['Sábado 14 de noviembre', 9, 9, 138.47],
      ['Domingo 15 de noviembre', 4, 4, 45.78],
    ]);
    expect(days[0]!.stages.map((s) => s.code)).toEqual(['Shakedown', 'SS1']);
  });

  it('ordena por hora de largada aunque la fuente venga desordenada, y respeta su orden si no hay horas', () => {
    const shuffled = [...wrc().stages].reverse();
    expect(sortStages(shuffled).map((s) => s.code).slice(0, 4)).toEqual(['Shakedown', 'SS1', 'SS2', 'SS3']);
    const noTimes = [stage({ code: 'B', date: '2027-01-03' }), stage({ code: 'A', date: '2027-01-03' }), stage({ code: 'Prólogo', date: '2027-01-02' })];
    expect(sortStages(noTimes).map((s) => s.code)).toEqual(['Prólogo', 'B', 'A']);
  });

  it('Dakar: una etapa por día, incluidos el descanso y el traslado', () => {
    const days = groupStagesByDay(dakar().stages);
    expect(days).toHaveLength(15);
    expect(days.every((d) => d.stages.length === 1)).toBe(true);
    expect(days[7]).toMatchObject({ date: '2027-01-09', label: 'Sábado 9 de enero', count: 0 });
    expect(days[7]!.competitiveKm).toBeUndefined();
  });
});

describe('hora de largada', () => {
  const ss2 = () => wrc().stages.find((s) => s.code === 'SS2')!;

  it('muestra la hora del usuario y, si difiere, la del rally y el día en que cae', () => {
    // 07:33 del viernes en Japón es jueves 19:33 en Argentina.
    expect(stageTime(ss2(), 'Asia/Tokyo', AR)).toEqual({ user: '19:33', userDay: 'jue', local: '07:33' });
    // Con el usuario en la zona del rally no hace falta aclarar nada.
    expect(stageTime(ss2(), 'Asia/Tokyo', 'Asia/Tokyo')).toEqual({ user: '07:33' });
  });

  it('si la fuente no publica la hora textual, la calcula con la zona del evento', () => {
    const s = ss2();
    delete s.localStartText;
    expect(stageTime(s, 'Asia/Tokyo', AR)?.local).toBe('07:33');
  });

  it('sin hora de largada no hay nada que mostrar', () => {
    expect(stageTime(dakar().stages[1]!, 'Asia/Riyadh', AR)).toBeNull();
    expect(stageTime(stage({ localStartText: '08:30' }), 'Asia/Riyadh', AR)).toEqual({ user: '', local: '08:30' });
  });
});

describe('textos de un tramo o etapa', () => {
  const byCode = (file: EventStagesFile, code: string) => file.stages.find((s) => s.code === code)!;

  it('título', () => {
    expect(stageTitle(byCode(dakar(), 'Etapa 5'))).toBe('Etapa 5 · Campamento maratón > Hail');
    expect(stageTitle(byCode(wrc(), 'SS2'))).toBe("SS2 · Isegami's Tunnel 1");
    expect(stageTitle(byCode(dakar(), 'Descanso'))).toBe('Día de descanso · Riad');
    expect(stageTitle(stage({ code: 'Prólogo', name: '' }))).toBe('Prólogo');
    expect(stageTitle(stage({ code: 'Shakedown', name: 'shakedown' }))).toBe('Shakedown');
  });

  it('distancias', () => {
    const e6 = byCode(dakar(), 'Etapa 6');
    expect(stageDistanceText(e6, 'etapas')).toBe('331 km de especial');
    expect(stageExtraKmText(e6)).toBe('Enlace 589 km · Total 920 km');
    expect(stageDistanceText(byCode(wrc(), 'SS2'), 'tramos')).toBe('23,67 km');
    expect(stageExtraKmText(byCode(wrc(), 'SS2'))).toBe('');
    expect(stageDistanceText(byCode(dakar(), 'Traslado'), 'etapas')).toBe('');
    const liaison = stage({ kind: 'enlace', liaisonKm: 647, totalKm: 647 });
    expect(stageDistanceText(liaison, 'etapas')).toBe('647 km de enlace');
    expect(stageExtraKmText(liaison)).toBe('');
    expect(stageDistanceText(byCode(dakar(), 'Descanso'), 'etapas')).toBe('');
  });
});

describe('barras de terreno', () => {
  const byCode = (code: string) => dakar().stages.find((s) => s.code === code)!;

  it('ordena de mayor a menor con el porcentaje de la fuente', () => {
    expect(terrainBars(byCode('Etapa 4')).map((t) => [t.label, t.text])).toEqual([
      ['Arena', '40 %'],
      ['Tierra', '28 %'],
      ['Dunas', '22 %'],
      ['Piedras', '10 %'],
    ]);
  });

  it('si la fuente da kilómetros, calcula el porcentaje sobre el sector cronometrado', () => {
    expect(terrainBars(byCode('Etapa 2'))).toEqual([
      { label: 'Piedras', percent: 42, km: 168, text: '42 %' },
      { label: 'Tierra', percent: 38, km: 152, text: '38 %' },
      { label: 'Arena', percent: 20, km: 80, text: '20 %' },
    ]);
    // Sin la distancia de la etapa, sobre la suma de lo informado.
    expect(terrainBars({ terrain: [{ label: 'Arena', km: 30 }, { label: 'Tierra', km: 10 }] }).map((t) => t.text)).toEqual(['75 %', '25 %']);
  });

  it('sin datos de terreno no hay barras, y descarta lo que no se puede dibujar', () => {
    expect(terrainBars(byCode('Etapa 5'))).toEqual([]);
    expect(terrainBars(byCode('Descanso'))).toEqual([]);
    expect(terrainBars({ terrain: [{ label: 'Arena' }, { label: ' ', percent: 50 }, { label: 'Tierra', percent: 0 }] })).toEqual([]);
    expect(terrainBars({ terrain: [{ label: 'Arena', percent: 140 }, { label: 'Agua', percent: 0.4 }] })).toEqual([
      { label: 'Arena', percent: 100, text: '100 %' },
      { label: 'Agua', percent: 0.4, text: '<1 %' },
    ]);
  });
});

describe('Agenda: la etapa del día', () => {
  const day = (d: string) => agendaPeriod(d, `${d}T15:00:00Z`, AR);

  it('fechas de un período en la zona del usuario', () => {
    expect(periodDates(day('2027-01-08'), AR)).toEqual(['2027-01-08']);
    expect(periodDates(agendaPeriod('finde', '2027-01-08T15:00:00Z', AR), AR)).toEqual(['2027-01-08', '2027-01-09', '2027-01-10']);
  });

  it('toma los eventos con itinerario que ese día no tienen sesiones con horario', () => {
    const s = schedule();
    expect(stageEventsOn(s, ['2027-01-08'], day('2027-01-08'), visible).map((x) => x.event.id)).toEqual(['ev-dakar-2027']);
    // El WRC de Japón tiene sesiones ese día: va con sus horarios, como cualquier evento.
    expect(stageEventsOn(s, ['2026-11-13'], day('2026-11-13'), visible)).toEqual([]);
    // Categoría oculta o desactivada: no aparece.
    expect(stageEventsOn(s, ['2027-01-08'], day('2027-01-08'), (x) => x.id !== 'dakar')).toEqual([]);
    expect(stageEventsOn(null, ['2027-01-08'], day('2027-01-08'), visible)).toEqual([]);
    // Lejos del evento, tampoco.
    expect(stageEventsOn(s, ['2027-02-08'], day('2027-02-08'), visible)).toEqual([]);
  });

  it('arma el renglón de día completo: etapa, recorrido y kilómetros', () => {
    expect(stageDayRows(dakar(), ['2027-01-07'], '2027-01-08', AR)).toEqual([
      { date: '2027-01-07', title: 'Etapa 5 · Campamento maratón > Hail', detail: '372 km de especial · 433 km en total', state: 'past', cancelled: false },
    ]);
    expect(stageDayRows(dakar(), ['2027-01-08', '2027-01-09', '2027-01-10'], '2027-01-08', AR)).toEqual([
      { date: '2027-01-08', title: 'Etapa 6 · Hail > Riad', detail: '331 km de especial · 920 km en total', state: 'today', cancelled: false },
      { date: '2027-01-09', title: 'Día de descanso · Riad', detail: '', state: 'upcoming', cancelled: false },
      { date: '2027-01-10', title: 'Etapa 7 · Riad > Wadi Ad-Dawasir', detail: '462 km de especial · 876 km en total', state: 'upcoming', cancelled: false },
    ]);
    expect(stageDayRows(dakar(), ['2027-01-13'], '2027-01-08', AR)[0]).toMatchObject({ title: 'Traslado · Bisha > Al Henakiyah', detail: '' });
    expect(stageDayRows(dakar(), ['2027-01-01'], '2027-01-08', AR)).toEqual([]);
  });

  it('con horas de largada, cada tramo va al día en que cae para el usuario y se resumen los del día', () => {
    // Jueves 12 en Argentina: el SS1 (07:05) y los tres primeros del viernes japonés (19:33 a 21:36).
    expect(stageDayRows(wrc(), ['2026-11-12'], '2026-11-12', AR)).toEqual([
      { date: '2026-11-12', title: 'SS1 a SS4 · 4 tramos', detail: '67,59 km cronometrados', time: '07:05', state: 'today', cancelled: false },
    ]);
    // Un solo tramo ese día: va con su nombre.
    const file: EventStagesFile = { ...wrc(), stages: wrc().stages.filter((x) => x.code === 'SS21' || x.code === 'SS20') };
    expect(stageDayRows(file, ['2026-11-15'], '2026-11-12', AR)[0]).toMatchObject({ title: 'SS21 · Obara 2', detail: '15,37 km de especial', time: '02:15' });
  });

  it('la tarjeta del día: si el itinerario no trae nada para un día del evento, queda un renglón genérico', () => {
    const item = { event: eventOf('ev-dakar-2027'), series: schedule().series.find((x) => x.id === 'dakar')! };
    expect(stageAgendaCard(item, dakar(), ['2027-01-08'], '2027-01-08', AR)).toMatchObject({ key: 'etapas:ev-dakar-2027', rows: [{ title: 'Etapa 6 · Hail > Riad' }] });
    // El día anterior a la largada (entra por el margen de un día) no le toca nada.
    expect(stageAgendaCard(item, dakar(), ['2027-01-01'], '2027-01-01', AR)).toBeNull();
    const partial = { stages: dakar().stages.filter((x) => x.date !== '2027-01-09') };
    expect(stageAgendaCard(item, partial, ['2027-01-09'], '2027-01-08', AR)?.rows).toEqual([
      { date: '2027-01-09', title: 'Sin etapa publicada para este día', detail: '', state: 'upcoming', cancelled: false },
    ]);
  });
});

describe('textos de un evento con recorrido y sin horarios', () => {
  it('estado para la cabecera', () => {
    const ev = eventOf('ev-dakar-2027');
    expect(stagesEventStatus(ev, '2026-12-20')).toEqual({ kind: 'next', text: 'Empieza el sáb 2 de ene' });
    expect(stagesEventStatus(ev, '2027-01-02')).toEqual({ kind: 'next', text: 'En disputa · día 1 de 15' });
    expect(stagesEventStatus(ev, '2027-01-08')).toEqual({ kind: 'next', text: 'En disputa · día 7 de 15' });
    expect(stagesEventStatus(ev, '2027-01-17')).toEqual({ kind: 'done', text: 'Finalizado' });
  });

  it('no es "horarios a confirmar"', () => {
    expect(noTimesNote(eventOf('ev-dakar-2027'))).toBe('recorrido publicado');
    expect(noTimesNote(eventOf('ev-wrc-arabia'))).toBe('horarios a confirmar');
  });

  it('en la auditoría el Dakar figura activo y sin horarios pendientes', () => {
    const period = { startUtc: '2027-01-08T03:00:00Z', endUtc: '2027-01-11T03:00:00Z' };
    const rows = buildAuditRows(schedule(), null, period);
    const row = rows.find((r) => r.series.id === 'dakar')!;
    expect(row).toMatchObject({ state: 'activa', sessionCount: 0, pendingEvents: [] });
    expect(row.stageEvents.map((e) => e.id)).toEqual(['ev-dakar-2027']);
    // Un evento sin cronograma ni recorrido sigue pendiente.
    expect(rows.find((r) => r.series.id === 'tc')).toMatchObject({ state: 'pendiente' });
  });
});

describe('store de itinerarios', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
  });

  it('descarga el archivo recién cuando se pide y lo guarda por evento', async () => {
    const fetchMock = vi.fn(async (_url: string) => json(dakar()));
    vi.stubGlobal('fetch', fetchMock);
    const store = useStagesStore();
    expect(fetchMock).not.toHaveBeenCalled();
    const pending = store.load('dakar', 'ev-dakar-2027');
    expect(store.files[stagesKey('dakar', 'ev-dakar-2027')]).toEqual({ status: 'loading' });
    await pending;
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/data\/stages\/dakar\/ev-dakar-2027\.json$/);
    expect(store.files['dakar/ev-dakar-2027']).toMatchObject({ status: 'ok' });
    expect(store.files['dakar/ev-dakar-2027']!.data!.stages).toHaveLength(15);
    // Segunda vez: sale de la memoria.
    await store.load('dakar', 'ev-dakar-2027');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dos pantallas que lo piden a la vez generan un solo pedido', async () => {
    const fetchMock = vi.fn(async (_url: string) => json(wrc()));
    vi.stubGlobal('fetch', fetchMock);
    const store = useStagesStore();
    await Promise.all([store.load('wrc', 'ev-wrc-japon'), store.load('wrc', 'ev-wrc-japon')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('si el archivo no existe queda como faltante y no se vuelve a pedir', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const store = useStagesStore();
    await store.load('wrc', 'ev-wrc-arabia');
    expect(store.files['wrc/ev-wrc-arabia']).toEqual({ status: 'missing' });
    await store.load('wrc', 'ev-wrc-arabia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Un servidor estático que devuelve index.html para lo que no existe también cuenta como faltante.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await store.load('dakar', 'ev-dakar-2026');
    expect(store.files['dakar/ev-dakar-2026']).toEqual({ status: 'missing' });
  });

  it('un error de red se puede reintentar, y un archivo con otro formato no rompe la pantalla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const store = useStagesStore();
    await store.load('dakar', 'ev-dakar-2027');
    expect(store.files['dakar/ev-dakar-2027']!.status).toBe('error');
    vi.stubGlobal('fetch', vi.fn(async () => json(dakar())));
    await store.load('dakar', 'ev-dakar-2027');
    expect(store.files['dakar/ev-dakar-2027']!.status).toBe('ok');

    vi.stubGlobal('fetch', vi.fn(async () => json({ seriesId: 'wrc', eventId: 'x' })));
    await store.load('wrc', 'x');
    expect(store.files['wrc/x']!.status).toBe('error');
  });

  it('"Actualizar" vuelve a pedir lo abierto y conserva lo que había si falla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(dakar())));
    const store = useStagesStore();
    await store.load('dakar', 'ev-dakar-2027');
    const updated = { ...dakar(), updatedAt: '2027-01-08T10:00:00Z' };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(updated));
    vi.stubGlobal('fetch', fetchMock);
    await store.reloadLoaded();
    expect(fetchMock.mock.calls[0]![1]?.cache).toBe('reload');
    expect(store.files['dakar/ev-dakar-2027']!.data!.updatedAt).toBe('2027-01-08T10:00:00Z');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await store.reloadLoaded();
    expect(store.files['dakar/ev-dakar-2027']).toMatchObject({ status: 'ok', data: { updatedAt: '2027-01-08T10:00:00Z' } });
  });
});
