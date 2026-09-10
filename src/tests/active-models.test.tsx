import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

const app = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("@/contexts", () => ({ useApp: () => app.current }));

import { ActiveModels } from "@/pages/app/components/completion/ActiveModels";
import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import { SPEECH_TO_TEXT_PROVIDERS } from "@/config/stt.constants";

type Selection = { provider: string; variables: Record<string, string> };

const NONE: Selection = { provider: "", variables: {} };
const pick = (provider: string, model: string): Selection => ({
  provider,
  variables: { api_key: "key", model },
});

function renderChips(
  { ai = NONE, stt = NONE }: { ai?: Selection; stt?: Selection },
  props: Partial<ComponentProps<typeof ActiveModels>> = {}
) {
  app.current = {
    selectedAIProvider: ai,
    selectedSttProvider: stt,
    allAiProviders: AI_PROVIDERS,
    allSttProviders: SPEECH_TO_TEXT_PROVIDERS,
  };
  return render(
    <ActiveModels
      respondedModel={null}
      isLoading={false}
      cloudMode={false}
      listening={false}
      {...props}
    />
  );
}

describe("ActiveModels", () => {
  afterEach(cleanup);

  it("names the picked AI model and speech model", () => {
    renderChips({
      ai: pick("openai", "gpt-5.6-luna"),
      stt: pick("groq", "whisper-large-v3-turbo"),
    });

    expect(screen.getByText("GPT-5.6 Luna")).toBeInTheDocument();
    expect(screen.getByTitle("OpenAI · gpt-5.6-luna")).toBeInTheDocument();
    expect(screen.getByText("Whisper Large V3 Turbo")).toBeInTheDocument();
  });

  it("shows the model the free router picked instead of the router", () => {
    renderChips(
      { ai: pick("openrouter", "openrouter/free") },
      {
        respondedModel: {
          requested: "openrouter/free",
          model: "upstage/solar-pro-3:free",
        },
      }
    );

    expect(screen.getByText("upstage/solar-pro-3:free")).toBeInTheDocument();
    expect(screen.queryByText(/Free Models Router/)).toBeNull();
  });

  it("uses the list name when the router picks a listed model", () => {
    renderChips(
      { ai: pick("openrouter", "openrouter/free") },
      {
        respondedModel: {
          requested: "openrouter/free",
          model: "nvidia/nemotron-3.5-lightning:free",
        },
      }
    );

    expect(
      screen.getByText("Nemotron 3.5 Lightning (free, text only)")
    ).toBeInTheDocument();
  });

  it("says the router is choosing until its first answer arrives", () => {
    renderChips(
      { ai: pick("openrouter", "openrouter/free") },
      { isLoading: true }
    );

    expect(screen.getByText("Choosing model…")).toBeInTheDocument();
    expect(screen.queryByText(/Free Models Router/)).toBeNull();
  });

  it("ignores an answer from a model the user has since switched away from", () => {
    renderChips(
      { ai: pick("openai", "gpt-5.6-terra") },
      {
        respondedModel: {
          requested: "openrouter/free",
          model: "upstage/solar-pro-3:free",
        },
      }
    );

    expect(screen.getByText("GPT-5.6 Terra")).toBeInTheDocument();
    expect(screen.queryByText("upstage/solar-pro-3:free")).toBeNull();
  });

  it("keeps the picked name when the provider answers with a dated snapshot", () => {
    renderChips(
      { ai: pick("openai", "gpt-5.6-terra") },
      {
        respondedModel: {
          requested: "gpt-5.6-terra",
          model: "gpt-5.6-terra-2026-08-01",
        },
      }
    );

    expect(screen.getByText("GPT-5.6 Terra")).toBeInTheDocument();
  });

  it("shows a custom model id as typed", () => {
    renderChips({ ai: pick("openrouter", "acme/house-model:beta") });

    expect(screen.getByText("acme/house-model:beta")).toBeInTheDocument();
  });

  it("names the speech provider when its template sends no model", () => {
    renderChips({ stt: pick("google-stt", "default") });

    expect(screen.getByText("Google Cloud Speech")).toBeInTheDocument();
    expect(screen.queryByText("Default")).toBeNull();
  });

  it("shows a single Meetwings Cloud chip in cloud mode", () => {
    renderChips(
      {
        ai: pick("openai", "gpt-5.6-luna"),
        stt: pick("groq", "whisper-large-v3-turbo"),
      },
      { cloudMode: true }
    );

    expect(screen.getByText("Meetwings Cloud")).toBeInTheDocument();
    expect(screen.queryByText("GPT-5.6 Luna")).toBeNull();
    expect(screen.queryByText("Whisper Large V3 Turbo")).toBeNull();
  });

  it("pulses the speech chip only while listening", () => {
    const { container, rerender } = renderChips({
      stt: pick("groq", "whisper-large-v3-turbo"),
    });
    expect(container.querySelector(".animate-pulse")).toBeNull();

    rerender(
      <ActiveModels
        respondedModel={null}
        isLoading={false}
        cloudMode={false}
        listening
      />
    );

    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("renders nothing when no provider is set", () => {
    const { container } = renderChips({});

    expect(container.textContent).toBe("");
  });
});
