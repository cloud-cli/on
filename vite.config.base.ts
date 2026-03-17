import { defineConfig } from "vite";
import path from "path";

export default (projectRoot: string) => {
  const name = path.basename(projectRoot);

  return defineConfig({
    root: projectRoot,
    resolve: {
      alias: {
        "@": "src",
      },
    },
    build: {
      target: "esnext",
      lib: {
        entry: path.resolve(projectRoot, "src/index.ts"),
        name,
        formats: ["es"],
      },
      rollupOptions: {
        external: [/^node:.+$/],
      },
    },
  });
};
