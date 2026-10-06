import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: ".",
  resolve: {
    alias: {
      "@": "src",
    },
  },
  plugins: [tailwindcss()],
  build: {
    target: "esnext",
    lib: {
      entry: "./src/index.ts",
      name: "index",
      formats: ["es"],
    },
    rollupOptions: {
      external: [/^node:.+$/, /^web-push$/],
    },
  },

  test: {
    watch: !process.env.CI,
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov"],
    },
  },
});
