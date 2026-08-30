import { defineConfig } from "vitest/config";
import path from "path";

const REPO = path.resolve(__dirname, "..");

const LIVE_FILE = path
  .resolve(__dirname, "odoo-scratch.live.ts")
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
