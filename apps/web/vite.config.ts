import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  assetsInclude: ["**/*.wasm"],
  // Force the build target to a literal so main.tsx's target branch is
  // statically dead in the other bundle (rollup then never emits the other
  // target's chunks — how "public bundle contains no lab code" is achieved,
  // not by hidden routes). Absent env = "admin" = today's app, unchanged.
  define: {
    "import.meta.env.VITE_APP_TARGET": JSON.stringify(
      process.env.VITE_APP_TARGET === "public" ? "public" : "admin",
    ),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@openreel/core": path.resolve(__dirname, "../../packages/core/src"),
      "@wizz/contracts": path.resolve(__dirname, "../../packages/contracts/src"),
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: [
      "@ffmpeg/ffmpeg",
      "@ffmpeg/util",
      "@ffmpeg/core",
      "@ffmpeg/core-mt",
      // Pre-bundling breaks transformers.js dynamic ORT/wasm loading.
      "@huggingface/transformers",
    ],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "react";
          }
          if (id.includes("node_modules/zustand")) {
            return "zustand";
          }
          if (id.includes("node_modules/three")) {
            return "three";
          }
          if (id.includes("node_modules/@radix-ui")) {
            return "radix";
          }
        },
      },
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
      // Director LLM + Suno music calls: forward to the deployed nginx
      // (tailnet), which injects the OpenAI/Suno keys server-side — no key
      // on this machine. One entry covers every /api/proxy/* sub-path
      // (openai, suno, ...) so new proxied services need no vite.config change.
      "/api/proxy": {
        target: "https://openreel.pbrain.dev",
        changeOrigin: true,
      },
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
