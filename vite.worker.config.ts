import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    lib: {
      entry: "./src/worker-entry.ts",
      name: "runnerWorker",
      formats: ["es"],
      fileName: () => "worker.js",
    },
    rollupOptions: {
      external: [/^node:.+$/, /^web-push$/],
    },
    emptyOutDir: true,
  },
});
