import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";

export { CustomProviders as AICustomProviders } from "./CustomProvider";

export const AIProviders = (settings: UseSettingsReturn) => {
  return (
    <div id="ai-providers" className="space-y-3">
      <Header
        title="AI Providers"
        description="Select your preferred AI service provider to get started."
        isMainTitle
      />

      {/* Providers Selection */}
      <Providers {...settings} />
    </div>
  );
};
