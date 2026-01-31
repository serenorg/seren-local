import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), solid()],

  // Path aliases
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },

  // Optimize Monaco Editor
  optimizeDeps: {
    include: ["monaco-editor"],
  },

  // Build configuration for Monaco workers
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "monaco-editor": ["monaco-editor"],
        },
      },
    },
  },

  server: {
    port: 3000,
  },

  test: {
    environment: "happy-dom",
  },
});
