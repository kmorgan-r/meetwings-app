import { describe, expect, it } from "vitest";
import { speakerLabelFor } from "@/lib/functions/speaker-label.function";

describe("speakerLabelFor", () => {
  it("prefers an explicit speaker label", () => {
    expect(
      speakerLabelFor({ speaker: { speakerId: "diarization_A", speakerLabel: "Sarah Chen" }, audioSource: "system" })
    ).toBe("Sarah Chen");
  });

  it("labels microphone audio You", () => {
    expect(speakerLabelFor({ audioSource: "microphone" })).toBe("You");
  });

  it("labels system audio Guest", () => {
    expect(speakerLabelFor({ audioSource: "system" })).toBe("Guest");
  });

  it("returns null when the source is unknown, rather than defaulting to Guest", () => {
    // A two-way form defaulting to Guest attributes the user's own unattributed
    // lines to the customer, in a note the customer can read.
    expect(speakerLabelFor({})).toBeNull();
  });

  it("accepts a ChatMessage shape, not only a TranscriptEntry", () => {
    expect(
      speakerLabelFor({ speaker: undefined, audioSource: "microphone" })
    ).toBe("You");
  });
});
