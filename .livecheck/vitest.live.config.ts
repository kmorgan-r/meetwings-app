import { defineConfig } from "vitest/config";
import path from "path";

// Root is wherever this file lives, so a worktree copy runs against the
// worktree's src, never the primary checkout (whose tree is someone else's).
const REPO = path.resolve(__dirname, "..");

const LIVE_FILES = ["odoo-live-smoke.live.ts", "notion-live.live.ts"].map(
  (file) => path.resolve(__dirname, file).split(path.sep).join("/"),
);

export default defineConfig({
  root: REPO,
  test: {
    globals: true,
    environment: "node",
    include: LIVE_FILES,
    testTimeout: 180000,
    hookTimeout: 180000,
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(REPO, "src") },
  },
});
