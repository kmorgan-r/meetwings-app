import { describe, expect, it } from "vitest";
import {
  isRouterModel,
  isSameModel,
} from "@/lib/functions/active-model.function";

describe("isSameModel", () => {
  it("treats a dated snapshot of the requested id as the same model", () => {
    expect(isSameModel("gpt-5.6-terra", "gpt-5.6-terra-2026-08-01")).toBe(true);
    expect(isSameModel("claude-sonnet-5", "claude-sonnet-5")).toBe(true);
  });

  it("ignores a variant suffix such as :free on the requested id", () => {
    expect(
      isSameModel(
        "nvidia/nemotron-3.5-lightning:free",
        "nvidia/nemotron-3.5-lightning-20260807"
      )
    ).toBe(true);
  });

  it("treats a router's pick as a different model", () => {
    expect(isSameModel("openrouter/free", "upstage/solar-pro-3:free")).toBe(
      false
    );
  });

  it("treats any answer as different when no model was requested", () => {
    expect(isSameModel("", "gpt-5.6-terra")).toBe(false);
  });
});

describe("isRouterModel", () => {
  it("recognises OpenRouter's routers", () => {
    expect(isRouterModel("openrouter/free")).toBe(true);
    expect(isRouterModel("openrouter/auto")).toBe(true);
  });

  it("does not flag a concrete model", () => {
    expect(isRouterModel("openai/gpt-5.6-luna")).toBe(false);
    expect(isRouterModel("")).toBe(false);
  });
});
