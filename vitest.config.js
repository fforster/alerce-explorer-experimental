import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom gives the scripts a browser-like `window`/`document` so the
    // IIFE modules under src/static/js/ attach themselves exactly as in
    // the browser (see tests-js/helpers/load.js).
    environment: "jsdom",
    include: ["tests-js/**/*.test.js"],
    globals: false,
  },
});
