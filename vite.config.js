import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "web",
  envDir: "..",
  build: {
    outDir: "../dist", emptyOutDir: true, sourcemap: true, target: "es2022",
    rollupOptions: { input: { main: fileURLToPath(new URL("web/index.html", import.meta.url)), privacy: fileURLToPath(new URL("web/privacy.html", import.meta.url)) } },
  },
  server: { port: 5173 },
});
