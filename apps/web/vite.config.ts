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
    // Two dev-proxy modes (see docs/wizz-contracts.md §0/§4):
    //   1. Default (VITE_DEV_GATEWAY unset) — pre-gateway dev: only
    //      /api/proxy/* (director LLM + cloud vision + Groq STT + Suno
    //      music) forwards, straight to the deployed nginx on abacus
    //      (tailnet), which injects the OpenAI/OpenRouter/Groq/Suno keys
    //      server-side — no key ever exists on this machine. The newer
    //      /api/auth|preset|quota|telemetry|admin/* routes are NOT proxied
    //      in this mode (there's no gateway to answer them yet); calls to
    //      those fall through to this dev server's own SPA fallback, which
    //      gatewayFetch (src/services/gateway.ts) maps to a clear
    //      upstream_error instead of a cryptic JSON-parse failure.
    //   2. VITE_DEV_GATEWAY=http://127.0.0.1:8792 (or wherever a local
    //      services/gateway is listening) — proxy the WHOLE /api/* surface
    //      (which covers /api/proxy/* too) to it, so auth/preset/quota/
    //      telemetry/admin all work against a real local gateway. The
    //      gateway injects provider keys server-side, same as abacus does
    //      in mode 1.
    proxy: process.env.VITE_DEV_GATEWAY
      ? {
          "/api": {
            target: process.env.VITE_DEV_GATEWAY,
            changeOrigin: true,
          },
        }
      : {
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
