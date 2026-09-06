import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      '@': 'src',
    },
  },
  build: {
    target: 'esnext',
    lib: {
      entry: './src/index.ts',
      name: 'index',
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^node:.+$/, /^web-push$/],
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
