/**
 * Directiva `v-tab-strip` para las franjas de pestañas o chips con scroll horizontal.
 *
 * - Centra la pestaña activa (`.active`, `[aria-selected=true]` o `[aria-current]`) al montarse,
 *   al cambiar de pestaña y cuando cambia el valor de la directiva (p. ej. la ruta: la misma vista
 *   se reutiliza entre categorías y, sin esto, conserva el scroll de la anterior).
 * - Marca con `fade-start` / `fade-end` si queda contenido a la izquierda o a la derecha,
 *   para mostrar un degradé que avisa que la franja se puede deslizar.
 *
 * Con el modificador `.nocenter` solo maneja el degradé (la vista centra por su cuenta).
 */
import type { Directive, DirectiveBinding } from 'vue';

interface StripState {
  active: Element | null;
  key: unknown;
  onScroll: () => void;
  observer?: ResizeObserver;
}

const states = new WeakMap<HTMLElement, StripState>();

const ACTIVE = ':scope > .active, :scope > [aria-selected="true"], :scope > [aria-current]';

export function activeChild(el: HTMLElement): HTMLElement | null {
  try {
    return el.querySelector<HTMLElement>(ACTIVE);
  } catch {
    return null;
  }
}

/** scrollLeft que deja `child` centrado en `el` (sin pasarse de los bordes). */
export function centeredScrollLeft(el: HTMLElement, child: HTMLElement): number {
  const er = el.getBoundingClientRect();
  const cr = child.getBoundingClientRect();
  const target = el.scrollLeft + (cr.left - er.left) - (el.clientWidth - cr.width) / 2;
  const max = Math.max(0, el.scrollWidth - el.clientWidth);
  return Math.min(max, Math.max(0, Math.round(target)));
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

export function centerChild(el: HTMLElement, child: HTMLElement, smooth: boolean): void {
  const left = centeredScrollLeft(el, child);
  if (Math.abs(left - el.scrollLeft) < 1) return;
  if (typeof el.scrollTo === 'function') el.scrollTo({ left, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
  else el.scrollLeft = left;
}

export function updateFade(el: HTMLElement): void {
  const max = el.scrollWidth - el.clientWidth;
  el.classList.toggle('fade-start', el.scrollLeft > 2);
  el.classList.toggle('fade-end', max > 2 && el.scrollLeft < max - 2);
}

function sync(el: HTMLElement, binding: DirectiveBinding, first: boolean): void {
  const state = states.get(el);
  if (!state) return;
  const active = binding.modifiers.nocenter ? null : activeChild(el);
  const keyChanged = !first && binding.value !== state.key;
  const tabChanged = !first && active !== state.active;
  if (active && (first || keyChanged || tabChanged)) centerChild(el, active, tabChanged && !keyChanged);
  state.active = active;
  state.key = binding.value;
  updateFade(el);
}

export const tabStrip: Directive<HTMLElement, unknown> = {
  mounted(el, binding) {
    el.classList.add('tab-strip');
    const onScroll = () => updateFade(el);
    const state: StripState = { active: null, key: binding.value, onScroll };
    el.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      state.observer = new ResizeObserver(() => updateFade(el));
      state.observer.observe(el);
    }
    states.set(el, state);
    sync(el, binding, true);
  },
  updated(el, binding) {
    sync(el, binding, false);
  },
  beforeUnmount(el) {
    const state = states.get(el);
    if (!state) return;
    el.removeEventListener('scroll', state.onScroll);
    state.observer?.disconnect();
    states.delete(el);
  },
};
