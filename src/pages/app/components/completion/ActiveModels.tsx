import { Mic, Sparkles, type LucideIcon } from "lucide-react";
import { useApp } from "@/contexts";
import {
  AI_PROVIDER_INFO,
  STT_PROVIDER_INFO,
  ProviderInfo,
  getAIModelsForProvider,
  getSTTModelsForProvider,
} from "@/config/models.constants";
import {
  isRouterModel,
  isSameModel,
} from "@/lib/functions/active-model.function";
import { cn } from "@/lib/utils";
import { RespondedModel, TYPE_PROVIDER } from "@/types";

interface ActiveModelsProps {
  /** The model that produced the current answer, when the provider said */
  respondedModel: RespondedModel | null;
  isLoading: boolean;
  /** Meetwings Cloud is answering, so its models are not the selected ones */
  cloudMode: boolean;
  /** Auto-listen is on, so speech-to-text is live */
  listening: boolean;
}

interface Selection {
  provider: string;
  variables: Record<string, string>;
}

interface Chip {
  label: string;
  title: string;
}

/**
 * The AI and speech-to-text models in use, for the response panel's header.
 * With a router the AI chip names the model it picked for the current answer,
 * not the router.
 */
export const ActiveModels = ({
  respondedModel,
  isLoading,
  cloudMode,
  listening,
}: ActiveModelsProps) => {
  const {
    selectedAIProvider,
    selectedSttProvider,
    allAiProviders,
    allSttProviders,
  } = useApp();

  if (cloudMode) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <ModelChip
          icon={Sparkles}
          label="Meetwings Cloud"
          title="AI and speech-to-text run on Meetwings Cloud"
        />
      </div>
    );
  }

  const ai = aiChip(selectedAIProvider, allAiProviders, respondedModel, isLoading);
  const stt = sttChip(selectedSttProvider, allSttProviders);

  return (
    <div className="flex min-w-0 items-center gap-1">
      {ai && <ModelChip icon={Sparkles} {...ai} />}
      {stt && <ModelChip icon={Mic} {...stt} pulse={listening} />}
    </div>
  );
};

function aiChip(
  selected: Selection | undefined,
  providers: TYPE_PROVIDER[] | undefined,
  respondedModel: RespondedModel | null,
  isLoading: boolean
): Chip | null {
  const providerId = selected?.provider;
  if (!providerId) return null;
  const name = providerName(providerId, providers, AI_PROVIDER_INFO);
  const modelId = selected.variables?.model ?? "";
  const modelName = (id: string) =>
    getAIModelsForProvider(providerId).find((m) => m.id === id)?.name ?? id;

  // The model that answered when it isn't the one picked: a router's choice,
  // or whatever a provider with no model setting runs. An answer given before
  // the user switched models is ignored.
  if (
    respondedModel &&
    respondedModel.requested === modelId &&
    !isSameModel(modelId, respondedModel.model)
  ) {
    return {
      label: modelName(respondedModel.model),
      title: `${name} · ${respondedModel.model}${modelId ? ` via ${modelId}` : ""}`,
    };
  }
  if (isRouterModel(modelId)) {
    return {
      label: isLoading ? "Choosing model…" : "Picked per answer",
      title: `${name} · ${modelId} picks a model for each answer`,
    };
  }
  if (!modelId) return { label: name, title: name };
  return { label: modelName(modelId), title: `${name} · ${modelId}` };
}

function sttChip(
  selected: Selection | undefined,
  providers: TYPE_PROVIDER[] | undefined
): Chip | null {
  const providerId = selected?.provider;
  if (!providerId) return null;
  const provider = providers?.find((p) => p.id === providerId);
  const name = providerName(providerId, providers, STT_PROVIDER_INFO);
  const modelId = selected.variables?.model ?? "";

  // Only a template that sends {{MODEL}} lets the choice matter. The rest
  // (Google, Azure, AssemblyAI, ...) transcribe with the provider's own
  // model, so the provider is the honest label.
  if (!modelId || !provider?.curl.includes("{{MODEL}}")) {
    return { label: name, title: name };
  }
  const modelName =
    getSTTModelsForProvider(providerId).find((m) => m.id === modelId)?.name ??
    modelId;
  return { label: modelName, title: `${name} · ${modelId}` };
}

function providerName(
  providerId: string,
  providers: TYPE_PROVIDER[] | undefined,
  info: Record<string, ProviderInfo>
): string {
  const provider = providers?.find((p) => p.id === providerId);
  if (provider?.isCustom) return provider.name || "Custom provider";
  return info[providerId]?.name ?? provider?.name ?? providerId;
}

const ModelChip = ({
  icon: Icon,
  label,
  title,
  pulse = false,
}: Chip & { icon: LucideIcon; pulse?: boolean }) => (
  <span
    title={title}
    className="inline-flex min-w-0 max-w-[10rem] items-center gap-1 rounded-full border border-input/50 bg-muted/30 px-1.5 text-[10px] text-muted-foreground select-none"
  >
    <Icon
      className={cn("h-2.5 w-2.5 shrink-0", pulse && "animate-pulse text-primary")}
    />
    <span className="truncate">{label}</span>
  </span>
);
