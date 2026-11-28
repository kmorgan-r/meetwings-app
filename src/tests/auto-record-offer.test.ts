import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn(async (_cmd?: unknown, _args?: unknown) => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: Parameters<typeof invoke>) => invoke(...a),
}));

let platform: "windows" | "macos" | "linux" = "windows";
vi.mock("@/lib/platform", () => ({
  getPlatform: () => platform,
  isWindows: () => platform === "windows",
  isMacOS: () => platform === "macos",
  isLinux: () => platform === "linux",
}));

const turnOn = vi.fn();
vi.mock("@/lib/auto-record-setting", () => ({
  turnOnAutoRecord: (...a: unknown[]) => turnOn(...a),
  announceAutoRecordSetting: vi.fn(),
}));

let stored: Record<string, string> = {};
vi.mock("@/lib", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    safeLocalStorage: {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
      removeItem: (k: string) => {
        delete stored[k];
      },
    },
  };
});

import {
  acceptAutoRecordOffer,
  answerOfferFromSettings,
  declineAutoRecordOffer,
  maybeShowAutoRecordOffer,
  OFFER_FAILED_MESSAGE,
  shouldOfferAutoRecord,
} from "@/lib/auto-record-offer";
import {
  getMeetingCard,
  resetMeetingCardsForTests,
  setOfferState,
  showOffer,
  showStopNotice,
} from "@/lib/meeting-cards.store";
import { detectionLog } from "@/lib/detection-log";
import { STORAGE_KEYS as K } from "@/config/constants";
import { MIC_DENIED_MESSAGE } from "@/lib/meeting-start-failure";

beforeEach(() => {
  stored = {};
  platform = "windows";
  invoke.mockReset().mockResolvedValue(undefined);
  turnOn.mockReset();
  vi.mocked(detectionLog).mockClear();
  resetMeetingCardsForTests();
});

const logged = (line: string) =>
  vi.mocked(detectionLog).mock.calls.filter(([l]) => l === line).length;

describe("shouldOfferAutoRecord", () => {
  it.each([
    ["linux", {}, false],
    ["windows", {}, true],
    ["windows", { [K.MEETING_AUTO_RECORD_ENABLED]: "false" }, false],
    ["windows", { [K.MEETING_AUTO_RECORD_ENABLED]: "true" }, false],
    ["windows", { [K.MEETING_AUTO_RECORD_OFFER]: "later" }, false],
  ])("%s %j -> %s", async (p, s, want) => {
    platform = p as typeof platform;
    stored = { ...(s as Record<string, string>) };
    expect(await shouldOfferAutoRecord()).toBe(want);
  });

  it("windows never runs the Mac probe", async () => {
    await shouldOfferAutoRecord();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("mac: true only when the probe resolves", async () => {
    platform = "macos";
    invoke.mockResolvedValueOnce([]);
    expect(await shouldOfferAutoRecord()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("list_capture_sessions", expect.anything());
    invoke.mockRejectedValueOnce("Auto-record needs macOS 14.2 or later");
    expect(await shouldOfferAutoRecord()).toBe(false);
  });
});

describe("maybeShowAutoRecordOffer", () => {
  it("shows and logs once", async () => {
    await maybeShowAutoRecordOffer();
    await maybeShowAutoRecordOffer();
    expect(getMeetingCard()).toEqual({ kind: "offer", busy: false, error: null });
    expect(logged("offer shown")).toBe(1);
  });

  it("does nothing when another card is up", async () => {
    showStopNotice("silence");
    await maybeShowAutoRecordOffer();
    expect(getMeetingCard()?.kind).toBe("ended");
    expect(detectionLog).not.toHaveBeenCalled();
  });

  it("does nothing when the user already chose", async () => {
    stored[K.MEETING_AUTO_RECORD_ENABLED] = "false";
    await maybeShowAutoRecordOffer();
    expect(getMeetingCard()).toBeNull();
  });
});

describe("acceptAutoRecordOffer", () => {
  it("ok: key on, card gone, logged", async () => {
    showOffer();
    turnOn.mockResolvedValue(null);
    await acceptAutoRecordOffer();
    expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBe("on");
    expect(getMeetingCard()).toBeNull();
    expect(logged("offer answer=on")).toBe(1);
  });

  it("is busy while turning on", async () => {
    showOffer();
    let release!: (v: null) => void;
    turnOn.mockReturnValue(new Promise((r) => (release = r)));
    const p = acceptAutoRecordOffer();
    expect(getMeetingCard()).toEqual({ kind: "offer", busy: true, error: null });
    release(null);
    await p;
  });

  it("failure: card stays with the message, not busy, key unset", async () => {
    showOffer();
    turnOn.mockResolvedValue({ kind: "mic-denied", message: MIC_DENIED_MESSAGE });
    await acceptAutoRecordOffer();
    expect(getMeetingCard()).toEqual({ kind: "offer", busy: false, error: MIC_DENIED_MESSAGE });
    expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBeUndefined();
    expect(logged("offer answer=failed:mic-denied")).toBe(1);
  });

  it("an unexpected throw does not leave the card stuck busy", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    showOffer();
    turnOn.mockRejectedValue(new Error("boom"));
    await acceptAutoRecordOffer();
    expect(getMeetingCard()).toEqual({ kind: "offer", busy: false, error: OFFER_FAILED_MESSAGE });
    expect(logged("offer answer=failed:start-error")).toBe(1);
    err.mockRestore();
  });

  it("a double click runs one turn-on", async () => {
    showOffer();
    let release!: (v: null) => void;
    turnOn.mockReturnValue(new Promise((r) => (release = r)));
    const a = acceptAutoRecordOffer();
    const b = acceptAutoRecordOffer();
    release(null);
    await Promise.all([a, b]);
    expect(turnOn).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no offer is up", async () => {
    await acceptAutoRecordOffer();
    expect(turnOn).not.toHaveBeenCalled();
  });
});

describe("declineAutoRecordOffer", () => {
  it("key later, card gone, enabled untouched", () => {
    showOffer();
    declineAutoRecordOffer();
    expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBe("later");
    expect(stored[K.MEETING_AUTO_RECORD_ENABLED]).toBeUndefined();
    expect(getMeetingCard()).toBeNull();
    expect(logged("offer answer=later")).toBe(1);
  });
});

describe("answerOfferFromSettings", () => {
  it("is ignored when no offer is up", () => {
    answerOfferFromSettings();
    expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBeUndefined();
  });

  it("is ignored while our own turn-on is running", () => {
    showOffer();
    setOfferState({ busy: true, error: null });
    answerOfferFromSettings();
    expect(getMeetingCard()?.kind).toBe("offer");
    expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBeUndefined();
  });

  it("records settings and clears an idle offer", () => {
    showOffer();
    answerOfferFromSettings();
    expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBe("settings");
    expect(getMeetingCard()).toBeNull();
    expect(logged("offer answer=settings")).toBe(1);
  });
});
