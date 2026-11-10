# Agenda Deporte Motor

Grilla de horarios de deporte motor (internacional y argentino) con **la fuente oficial de cada horario**,
resultados y campeonatos, y exportación a calendario (`.ics`, Google Calendar y suscripción).
App web instalable (PWA) en Android e iOS, con costo $0.

## Estructura

| Carpeta | Contenido |
|---|---|
| `shared/` | Tipos, esquemas zod, horas/períodos y generador `.ics` (lo usan app y pipeline). |
| `config/` | Categorías (`series.default.json` = las 22 del gem; `series.user.json` = altas/bajas desde la app), duraciones estimadas, transmisión habitual y fuentes de descubrimiento. |
| `pipeline/` | Recolector Node + TypeScript: lectores directos (`src/adapters`), flujo genérico con IA (`src/generic`), resultados, descubrimiento. |
| `app/` | PWA en Vue 3 (Options API) + Vite. |
| `data/` | Archivos generados por el pipeline. **No editar a mano.** |

## Comandos

```bash
npm install
npm test              # Vitest en shared, pipeline y app
npm run typecheck
npm run pipeline      # corre el recolector y escribe data/  (opciones: --only=f1,tc --skip-results --dry-run)
npm run discovery     # descubrimiento de competencias nuevas
npm run dev           # app en modo desarrollo (sirve data/ en /data/)
npm run build         # build de producción en app/dist (incluye data/)
```

## Convenciones

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/es/) en español
  (`feat(pipeline): …`, `fix(app): …`, `chore: …`, `test: …`, `docs: …`).
- **Ramas**: `main` siempre estable; trabajo en `feat/<tema>` o `fix/<tema>` y merge con `--no-ff`.
- **Datos**: todo lo publicado lleva `source` (URL, tipo, método directo/IA, fecha de lectura). Las horas se guardan en UTC.
- **Vue**: Options API (`defineComponent({ data, computed, methods })`), sin `<script setup>`.
