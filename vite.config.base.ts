import { defineConfig } from "vite";
import path from "path";

export function asModule(projectRoot: string) {
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
      outDir: "dist",
      rollupOptions: {
        external: [/^node:.+$/],
      },
    },
  });
}

export function asLib(
  projectRoot: string,
  entrypoints: string[] = ["src/index.ts"],
) {
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
        entry: path.resolve(projectRoot, entrypoints[0]),
        name,
        formats: ["es"],
      },
      rollupOptions: {
        ...(!entrypoints[1]
          ? {}
          : {
              inputs: {
                index: path.resolve(projectRoot, entrypoints[1]),
              },
            }),
        external: [/^node:.+$/],
      },
    },
  });
}
