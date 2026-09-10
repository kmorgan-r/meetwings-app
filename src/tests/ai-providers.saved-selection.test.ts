import { describe, expect, it } from "vitest";
import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import { parseSavedAiSelection } from "@/lib/storage/ai-providers";
import { TYPE_PROVIDER } from "@/types";

const custom = {
  id: "custom-1",
  curl: "curl https://example.test/v1/chat",
  responseContentPath: "choices[0].message.content",
  streaming: true,
  isCustom: true,
} as unknown as TYPE_PROVIDER;

const providers = [...AI_PROVIDERS, custom] as unknown as TYPE_PROVIDER[];

describe("parseSavedAiSelection", () => {
  it("restores a selection whose built-in provider exists", () => {
    const saved = { provider: "openrouter", variables: { model: "openrouter/free" } };

    expect(parseSavedAiSelection(JSON.stringify(saved), providers)).toEqual(saved);
  });

  it("restores a selection whose custom provider exists", () => {
    const saved = { provider: "custom-1", variables: { model: "m" } };

    expect(parseSavedAiSelection(JSON.stringify(saved), providers)).toEqual(saved);
  });

  it("drops a selection whose provider was removed", () => {
    // Perplexity was a built-in until its Sonar endpoint was retired.
    const saved = { provider: "perplexity", variables: { model: "sonar-pro" } };

    expect(parseSavedAiSelection(JSON.stringify(saved), providers)).toBeNull();
  });

  it("drops a saved value that isn't JSON", () => {
    expect(parseSavedAiSelection("{not json", providers)).toBeNull();
  });
});
