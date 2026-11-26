import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Camera backgrounds: MediaPipe's WebAssembly runtime (from node_modules) and the selfie
// model (models/) are served under /mediapipe/, so nothing is fetched from the internet.
const MEDIAPIPE: Record<string, string> = {
  "vision_wasm_internal.js": "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js",
  "vision_wasm_internal.wasm": "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm",
  "selfie_segmenter.tflite": "models/selfie_segmenter.tflite",
};

function mediapipe(): Plugin {
  return {
    name: "mediapipe-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.match(/^\/mediapipe\/([\w.]+)$/)?.[1];
        const file = name && MEDIAPIPE[name];
        if (!file) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(resolve(__dirname, file)));
      });
    },
    generateBundle() {
      for (const [name, file] of Object.entries(MEDIAPIPE)) {
        this.emitFile({ type: "asset", fileName: `mediapipe/${name}`, source: readFileSync(resolve(__dirname, file)) });
      }
    },
  };
}

// Tauri expects a fixed port and must see Rust compile errors in the terminal.
export default defineConfig({
  plugins: [react(), mediapipe()],
  clearScreen: false,
  // Audio worklets (noise suppression) load as files of their own, not inlined as data: URLs.
  build: { assetsInlineLimit: (file) => (file.endsWith("Worklet.js") ? false : undefined) },
  server: { port: 5173, strictPort: true },
});
