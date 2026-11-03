import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  envDir: "..",
  build: { outDir: "../dist", emptyOutDir: true, sourcemap: true, target: "es2022" },
  server: { port: 5173 },
});
