/**
 * Avisa una sola vez cuando un elemento entra (o está por entrar) en pantalla, con un único
 * IntersectionObserver para toda la app. Se usa para pedir recién ahí lo que el elemento necesita
 * (p. ej. el trazado de cada circuito de una lista larga).
 */
const callbacks = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;

/** Devuelve la función para dejar de observar (al desmontar el componente). */
export function whenVisible(el: Element, callback: () => void): () => void {
  // Sin IntersectionObserver (navegadores muy viejos, pruebas): se considera visible.
  if (typeof IntersectionObserver === 'undefined') {
    callback();
    return () => undefined;
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer?.unobserve(entry.target);
        const fn = callbacks.get(entry.target);
        callbacks.delete(entry.target);
        fn?.();
      }
    },
    // Un poco antes de que aparezca, para que al llegar ya esté dibujado.
    { rootMargin: '300px 0px' },
  );
  callbacks.set(el, callback);
  observer.observe(el);
  return () => {
    callbacks.delete(el);
    observer?.unobserve(el);
  };
}
