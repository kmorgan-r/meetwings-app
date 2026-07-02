import { useState, useEffect, useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Input,
} from "@/components";
import { Header } from "@/components";
import {
  getAIModelsForProvider,
  getSTTModelsForProvider,
  hasModelsForProvider,
  type ModelOption,
} from "@/config/models.constants";
import { usePricing, formatAIPricing, formatSTTPricing } from "@/hooks/usePricing";
import { Star, Pencil, AlertCircle } from "lucide-react";

interface ModelSelectorProps {
  providerId: string;
  selectedModel: string;
  onModelChange: (model: string) => void;
  type: "ai" | "stt";
  providerDisplayName?: string;
}

const CUSTOM_MODEL_VALUE = "__custom__";

/**
 * Cost estimation display component
 */
function CostEstimation({
  providerId,
  modelId,
  type,
}: {
  providerId: string;
  modelId: string;
  type: "ai" | "stt";
}) {
  const { estimatedCost } = usePricing({ providerId, modelId, type });

  if (!estimatedCost) return null;

  return (
    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
      <span>Estimated: {estimatedCost.text}</span>
      {estimatedCost.isEstimate && (
        <span
          className="inline-flex items-center gap-0.5 text-yellow-600 dark:text-yellow-500"
          title="Using estimated pricing - actual cost may vary"
        >
          <AlertCircle className="h-3 w-3" />
          <span className="text-[10px]">(est.)</span>
        </span>
      )}
    </div>
  );
}

/**
 * Custom model input mode
 */
function CustomModelInput({
  providerId,
  selectedModel,
  onModelChange,
  type,
  providerDisplayName,
  hasModels,
  onBackToList,
}: {
  providerId: string;
  selectedModel: string;
  onModelChange: (model: string) => void;
  type: "ai" | "stt";
  providerDisplayName?: string;
  hasModels: boolean;
  onBackToList: () => void;
}) {
  return (
    <div className="space-y-2">
      <Header
        title="MODEL"
        description={`Enter the model identifier for ${
          providerDisplayName || providerId
        }`}
      />
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder={`Enter model name (e.g., ${
            type === "ai" ? "gpt-4o" : "whisper-1"
          })`}
          value={selectedModel}
          onChange={(e) => onModelChange(e.target.value)}
          className="flex-1 h-11 border-1 border-input/50 focus:border-primary/50 transition-colors"
        />
        {hasModels && (
          <button
            onClick={onBackToList}
            className="px-3 h-11 text-sm bg-secondary hover:bg-secondary/80 rounded-md transition-colors"
            title="Back to model list"
          >
            List
          </button>
        )}
      </div>
      {selectedModel && (
        <CostEstimation providerId={providerId} modelId={selectedModel} type={type} />
      )}
    </div>
  );
}

/**
 * Individual model option in the select dropdown
 */
function ModelSelectItem({
  model,
  providerId,
  type,
  showStar = false,
}: {
  model: ModelOption;
  providerId: string;
  type: "ai" | "stt";
  showStar?: boolean;
}) {
  const pricing =
    type === "ai"
      ? formatAIPricing(providerId, model.id)
      : formatSTTPricing(providerId, model.id);

  return (
    <SelectItem
      value={model.id}
      className="cursor-pointer hover:bg-accent/50"
    >
      <div className="flex items-center justify-between w-full gap-4">
        <div className="flex items-center gap-2 min-w-0">
          {showStar && <Star className="h-3 w-3 text-yellow-500 flex-shrink-0" />}
          <span className="font-medium truncate">{model.name}</span>
        </div>
        <span className="text-xs text-muted-foreground flex-shrink-0 flex items-center gap-1">
          {pricing.text}
          {pricing.isEstimate && (
            <AlertCircle className="h-3 w-3 text-yellow-600 dark:text-yellow-500" />
          )}
        </span>
      </div>
    </SelectItem>
  );
}

/**
 * Section header for model groups
 */
function ModelGroupHeader({ title }: { title: string }) {
  return (
    <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
      {title}
    </div>
  );
}

/**
 * Divider between model groups
 */
function GroupDivider() {
  return <div className="border-t border-input/50 my-1" />;
}

/**
 * Selected model display in the select trigger
 */
function SelectedModelDisplay({
  selectedModel,
  isSelectedModelPredefined,
  models,
}: {
  selectedModel: string;
  isSelectedModelPredefined: boolean;
  models: ModelOption[];
}) {
  if (!selectedModel) return null;

  // If it's a custom model (not in predefined list)
  if (!isSelectedModelPredefined) {
    return (
      <span className="flex items-center gap-2">
        <Pencil className="h-3 w-3" />
        {selectedModel}
      </span>
    );
  }

  // Find the model in the predefined list
  const modelInfo = models.find((m) => m.id === selectedModel);
  if (modelInfo) {
    return (
      <span className="flex items-center gap-2">
        {modelInfo.recommended && <Star className="h-3 w-3 text-yellow-500" />}
        {modelInfo.name}
      </span>
    );
  }

  return <span>{selectedModel}</span>;
}

/**
 * ModelSelector Component
 *
 * A dropdown component for selecting AI or STT models with:
 * - Predefined model lists for known providers
 * - Custom model input option
 * - Pricing display per model
 * - Cost estimation
 */
export const ModelSelector = ({
  providerId,
  selectedModel,
  onModelChange,
  type,
  providerDisplayName,
}: ModelSelectorProps) => {
  const [isCustomMode, setIsCustomMode] = useState(false);

  const models = useMemo(
    () =>
      type === "ai"
        ? getAIModelsForProvider(providerId)
        : getSTTModelsForProvider(providerId),
    [providerId, type]
  );

  const hasModels = hasModelsForProvider(providerId, type);

  // Check if the current selected model is in the predefined list
  const isSelectedModelPredefined = useMemo(
    () => hasModels && models.some((m) => m.id === selectedModel),
    [hasModels, models, selectedModel]
  );

  // Sync custom mode state: exit custom mode if user selects a predefined model
  useEffect(() => {
    if (isSelectedModelPredefined && isCustomMode) {
      setIsCustomMode(false);
    }
  }, [isSelectedModelPredefined, isCustomMode]);

  // If no predefined models, or we're in custom mode, show text input
  if (!hasModels || isCustomMode) {
    return (
      <CustomModelInput
        providerId={providerId}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        type={type}
        providerDisplayName={providerDisplayName}
        hasModels={hasModels}
        onBackToList={() => setIsCustomMode(false)}
      />
    );
  }

  // If selected model is not in predefined list but we have models, show as custom
  const displayValue =
    !isSelectedModelPredefined && selectedModel
      ? CUSTOM_MODEL_VALUE
      : selectedModel;

  const recommendedModels = models.filter((m) => m.recommended);
  const otherModels = models.filter((m) => !m.recommended);

  return (
    <div className="space-y-2">
      <Header
        title="MODEL"
        description={`Select a model for ${
          providerDisplayName || providerId
        } or enter a custom model name`}
      />
      <Select
        value={displayValue || ""}
        onValueChange={(value) => {
          if (value === CUSTOM_MODEL_VALUE) {
            setIsCustomMode(true);
          } else {
            onModelChange(value);
          }
        }}
      >
        <SelectTrigger className="w-full h-11 border-1 border-input/50 focus:border-primary/50 transition-colors">
          <SelectValue placeholder="Select a model">
            <SelectedModelDisplay
              selectedModel={selectedModel}
              isSelectedModelPredefined={isSelectedModelPredefined}
              models={models}
            />
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {/* Recommended models first */}
          {recommendedModels.length > 0 && (
            <>
              <ModelGroupHeader title="Recommended" />
              {recommendedModels.map((model) => (
                <ModelSelectItem
                  key={model.id}
                  model={model}
                  providerId={providerId}
                  type={type}
                  showStar
                />
              ))}
            </>
          )}

          {/* Other models */}
          {otherModels.length > 0 && (
            <>
              {recommendedModels.length > 0 && <GroupDivider />}
              <ModelGroupHeader title="All Models" />
              {otherModels.map((model) => (
                <ModelSelectItem
                  key={model.id}
                  model={model}
                  providerId={providerId}
                  type={type}
                />
              ))}
            </>
          )}

          {/* Custom model option */}
          <GroupDivider />
          <SelectItem
            value={CUSTOM_MODEL_VALUE}
            className="cursor-pointer hover:bg-accent/50"
          >
            <span className="flex items-center gap-2">
              <Pencil className="h-3 w-3" />
              <span>Custom model...</span>
            </span>
          </SelectItem>
        </SelectContent>
      </Select>

      {/* Cost estimation */}
      {selectedModel && (
        <CostEstimation providerId={providerId} modelId={selectedModel} type={type} />
      )}
    </div>
  );
};
