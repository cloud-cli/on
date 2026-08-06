import { defineConfig } from 'vite';
import path from 'path';

const projectRoot = '.';

export default defineConfig({
  root: projectRoot,
  resolve: {
    alias: {
      '@': 'src',
    },
  },
  build: {
    target: 'esnext',
    lib: {
      entry: path.resolve(projectRoot, 'src/index.ts'),
      name: 'on',
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^node:.+$/],
    },
  },

  test: {
     watch: !process.env.CI,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'lcov'],
    },
  },
});
