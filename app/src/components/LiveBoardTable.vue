<template>
  <div class="live-board">
    <div class="live-board-head">
      <span v-if="board.flag && board.flag !== 'none'" class="flag-chip" :class="`flag-${board.flag}`">{{ flagLabel }}</span>
      <span class="grow small">
        <strong>{{ board.sessionName }}</strong>
        <span v-if="lapText" class="dim"> · {{ lapText }}</span>
        <span v-if="board.remaining" class="dim"> · quedan {{ board.remaining }}</span>
      </span>
      <span class="small dim">{{ updated }}</span>
    </div>
    <p v-if="!board.rows.length" class="small dim live-empty">Sin tiempos todavía.</p>
    <table v-else class="data live-table">
      <thead>
        <tr>
          <th class="num">#</th>
          <th class="name-col">Piloto</th>
          <th class="num">{{ hasGap ? 'Dif.' : 'Mejor' }}</th>
          <th v-if="hasLast" class="num hide-narrow">Últ.</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in board.rows" :key="`${r.pos}-${r.number ?? r.driver}`" :class="{ pit: r.inPit }">
          <td class="num pos">{{ r.pos }}</td>
          <td>
            <div class="name-cell">
              <span v-if="r.number" class="car-number">{{ r.number }}</span>
              <span class="grow">
                {{ r.driver }}
                <span v-if="r.status || r.inPit" class="small warn-text"> {{ r.status ?? 'Boxes' }}</span>
                <span v-if="r.team || r.vehicle" class="small dim team">{{ r.team ?? r.vehicle }}</span>
              </span>
            </div>
          </td>
          <td class="num small">{{ hasGap ? (r.pos === 1 ? leaderCell(r) : r.gap ?? '') : r.bestLap ?? '' }}</td>
          <td v-if="hasLast" class="num small hide-narrow">{{ r.lastLap ?? '' }}</td>
        </tr>
      </tbody>
    </table>
    <div class="card-foot small">
      <a :href="board.sourceUrl" target="_blank" rel="noopener noreferrer">Tiempos oficiales</a>
      <span class="dim"> · datos del cronometraje oficial, pueden demorar unos segundos</span>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { LiveBoard, LiveRow } from '@dm/shared';

const FLAGS: Record<string, string> = {
  green: 'Verde',
  yellow: 'Amarilla',
  red: 'Roja',
  'safety-car': 'Auto de seguridad',
  checkered: 'Final',
};

/** Tabla de posiciones en vivo (formato común LiveBoard). */
export default defineComponent({
  name: 'LiveBoardTable',
  props: {
    board: { type: Object as PropType<LiveBoard>, required: true },
    now: { type: String, required: true },
  },
  computed: {
    flagLabel(): string {
      return FLAGS[this.board.flag ?? ''] ?? '';
    },
    lapText(): string {
      if (!this.board.lap) return '';
      return this.board.totalLaps ? `Vuelta ${this.board.lap}/${this.board.totalLaps}` : `Vuelta ${this.board.lap}`;
    },
    hasGap(): boolean {
      return this.board.rows.some((r) => r.gap);
    },
    hasLast(): boolean {
      return this.board.rows.some((r) => r.lastLap);
    },
    updated(): string {
      const s = Math.max(0, Math.round((Date.parse(this.now) - Date.parse(this.board.updatedAt)) / 1000));
      return s < 60 ? `hace ${s} s` : `hace ${Math.round(s / 60)} min`;
    },
  },
  methods: {
    leaderCell(r: LiveRow): string {
      return r.laps !== undefined ? `${r.laps} v` : (r.bestLap ?? 'Líder');
    },
  },
});
</script>

<style>
.live-board-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
}

.flag-chip {
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  font-size: 0.72rem;
  font-weight: 800;
  color: #000;
  background: var(--bg-elev-2);
}

.flag-green {
  background: #19c26b;
}

.flag-yellow,
.flag-safety-car {
  background: #f5c518;
}

.flag-red {
  background: #ff4d4d;
  color: #fff;
}

.flag-checkered {
  background: repeating-conic-gradient(#fff 0 25%, #000 0 50%) 0 0 / 10px 10px;
  color: transparent;
  min-width: 2rem;
}

.live-empty {
  padding: 0.75rem 0.85rem;
}

table.data.live-table td,
table.data.live-table th {
  padding: 0.45rem 0.55rem;
}

table.data.live-table tr.pit td {
  opacity: 0.7;
}

@media (max-width: 380px) {
  .hide-narrow {
    display: none;
  }
}
</style>
