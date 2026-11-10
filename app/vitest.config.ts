import { defineProject } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineProject({
  plugins: [vue()],
  test: {
    name: 'app',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'jsdom',
  },
});
