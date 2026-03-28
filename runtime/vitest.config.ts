import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // createRequire("../package.json") in src/handlers/ resolves from CWD in
      // vitest but from src/ in production. This alias ensures it finds the file.
      "../package.json": resolve(__dirname, "package.json"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
