import { defineConfig, loadEnv } from "vite";
import { mockApi } from "./mock/plugin";

// Dev: the mock API is on by default. `VITE_API=http://localhost:8090 npm run dev` proxies /api to a real backend.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const api = env.VITE_API;
  return {
    plugins: api ? [] : [mockApi()],
    server: api ? { proxy: { "/api": { target: api, changeOrigin: true } } } : {},
    build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 1200 },
    test: { include: ["src/**/*.test.ts"] },
  };
});
