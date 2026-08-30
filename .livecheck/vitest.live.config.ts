import { defineConfig } from "vitest/config";
import path from "path";

const REPO = "C:/Users/kmorg/meetwings-app";

const LIVE_FILE = path
  .resolve(__dirname, "odoo-live-smoke.live.ts")
  .split(path.sep)
  .join("/");

export default defineConfig({
  root: REPO,
  test: {
    globals: true,
    environment: "node",
    include: [LIVE_FILE],
    testTimeout: 180000,
    hookTimeout: 180000,
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(REPO, "src") },
  },
});
