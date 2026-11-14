<template>
  <span
    class="driver-avatar"
    :class="{ 'has-photo': showPhoto }"
    :style="{ background: color, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` }"
    aria-hidden="true"
  >
    <img v-if="showPhoto" :src="photo" alt="" class="driver-avatar-photo" decoding="async" :width="size" :height="size" @error="photoFailed = true" />
    <template v-else>{{ initials }}</template>
    <span v-if="number && size >= 40" class="driver-avatar-number">{{ number }}</span>
  </span>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { driverInitials } from '@dm/shared';

/**
 * Avatar de un piloto: iniciales sobre el color de su categoría. Con `photo` (la del historial, solo en la cabecera
 * de la ficha: en listas largas no, por rendimiento) muestra la foto recortada; si no carga, vuelve a las iniciales.
 */
export default defineComponent({
  name: 'DriverAvatar',
  props: {
    name: { type: String, required: true },
    color: { type: String, default: 'var(--bg-elev-2)' },
    number: { type: String, default: '' },
    size: { type: Number, default: 36 },
    photo: { type: String, default: '' },
  },
  data() {
    return { photoFailed: false };
  },
  computed: {
    initials(): string {
      return driverInitials(this.name);
    },
    showPhoto(): boolean {
      return !!this.photo && !this.photoFailed;
    },
  },
  watch: {
    photo() {
      this.photoFailed = false;
    },
  },
});
</script>

<style>
.driver-avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: 50%;
  color: #fff;
  font-weight: 800;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35);
}

.driver-avatar.has-photo {
  box-shadow: 0 0 0 2px var(--series-color, var(--border));
}

.driver-avatar-photo {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  object-position: 50% 20%;
  background: var(--bg-elev-2);
}

.driver-avatar-number {
  position: absolute;
  right: -4px;
  bottom: -4px;
  min-width: 22px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--text);
  font-size: 0.7rem;
  font-weight: 800;
  text-align: center;
  text-shadow: none;
  box-shadow: 0 0 0 2px var(--bg-header);
}
</style>
