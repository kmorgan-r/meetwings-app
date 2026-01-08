import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";

export { CustomProviders as STTCustomProviders } from "./CustomProvider";

export const STTProviders = (settings: UseSettingsReturn) => {
  return (
    <div id="stt-providers" className="space-y-3">
      <Header
        title="STT Providers"
        description="Select your preferred STT service provider to get started."
        isMainTitle
      />

      {/* Providers Selection */}
      <Providers {...settings} />
    </div>
  );
};
