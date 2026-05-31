import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const apiTarget = process.env.STEELMAN_API_TARGET || "http://127.0.0.1:45210";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
  },
});
