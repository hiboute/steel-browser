import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": {
        target: process.env.STEEL_DEV_API_URL || "http://localhost:3000",
        changeOrigin: true,
        ws: true,
      },
      "/api": {
        target: process.env.STEEL_DEV_API_URL || "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/ws": {
        target: (process.env.STEEL_DEV_API_URL || "http://localhost:3000").replace(/^http/, "ws"),
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, ""),
      },
    },
  },
});
