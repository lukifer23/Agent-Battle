import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";

const apiPort = process.env.AGENT_BATTLE_API_PORT ?? process.env.PORT ?? "4173";

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
  build: { outDir: "dist/web", emptyOutDir: true },
});
