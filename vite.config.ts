import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // GitHub Pages serves this repo under /browser-4k-cam/
  base: mode === "production" ? "/browser-4k-cam/" : "/",
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
  optimizeDeps: {
    // FFmpeg uses worker-based ESM loading that can break under Vite pre-bundling.
    // Excluding these packages prevents missing `worker.js` errors at runtime.
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/core", "@ffmpeg/util"],
  },
}));
