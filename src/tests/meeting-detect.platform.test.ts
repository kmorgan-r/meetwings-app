import { describe, expect, it, vi } from "vitest";

// A three-state platform mock. Task 8 moves the hook tests onto this shape; the
// matcher only needs isWindows and isMacOS today, but every factory export is
// derived from the same `platform` let so a test flips it in one place.
let platform: "windows" | "macos" | "linux" = "windows";

vi.mock("@/lib/platform", () => ({
  getPlatform: () => platform,
  isWindows: () => platform === "windows",
  isMacOS: () => platform === "macos",
  isLinux: () => platform === "linux",
}));

import { MEETING_DETECT_PROCESSES } from "@/config/constants";
import {
  currentWatchLists,
  isMeetingDetectionPlatform,
} from "@/lib/meeting-detect";

describe("currentWatchLists on a Mac", () => {
  it("watches Chrome by bundle ID and nothing else", async () => {
    platform = "macos";
    await expect(currentWatchLists()).resolves.toEqual({
      direct: [],
      gated: ["com.google.Chrome"],
    });
  });
});

describe("currentWatchLists on Windows", () => {
  it("keeps today's lists", async () => {
    platform = "windows";
    await expect(currentWatchLists()).resolves.toEqual({
      direct: MEETING_DETECT_PROCESSES,
      gated: ["chrome.exe"],
    });
  });
});

describe("isMeetingDetectionPlatform", () => {
  it("is true on Windows", () => {
    platform = "windows";
    expect(isMeetingDetectionPlatform()).toBe(true);
  });
  it("is true on macOS", () => {
    platform = "macos";
    expect(isMeetingDetectionPlatform()).toBe(true);
  });
  it("is false on Linux", () => {
    platform = "linux";
    expect(isMeetingDetectionPlatform()).toBe(false);
  });
});
