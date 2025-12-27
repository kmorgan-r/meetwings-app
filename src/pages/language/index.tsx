import { Header, Selection, Switch } from "@/components";
import { STT_LANGUAGES, TRANSLATION_LANGUAGES } from "@/config";
import { LANGUAGES } from "@/lib";
import { useApp } from "@/contexts";
import { updateLanguage } from "@/lib/storage/response-settings.storage";
import { useState, useEffect, useMemo } from "react";
import { getResponseSettings } from "@/lib";
import { PageLayout } from "@/layouts";

const Language = () => {
  const {
    hasActiveLicense,
    sttLanguage,
    setSttLanguage,
    sttTranslationEnabled,
    setSttTranslationEnabled,
    sttTranslationLanguage,
    setSttTranslationLanguage,
  } = useApp();

  // Response language state
  const [selectedLanguage, setSelectedLanguage] = useState<string>("english");

  useEffect(() => {
    const settings = getResponseSettings();
    setSelectedLanguage(settings.language);
  }, []);

  const handleLanguageChange = (languageId: string) => {
    if (!hasActiveLicense) {
      return;
    }
    setSelectedLanguage(languageId);
    updateLanguage(languageId);
  };

  const languageOptions = useMemo(() => {
    return LANGUAGES.map((lang) => ({
      label: `${lang.flag} ${lang.name}`,
      value: lang.id,
    }));
  }, []);

  return (
    <PageLayout
      title="Language"
      description="Configure language settings for responses and speech translation"
    >
      {!hasActiveLicense && (
        <div className="p-4 bg-primary/10 border border-primary/20 rounded-lg">
          <p className="text-[10px] lg:text-sm text-foreground font-medium mb-2">
            🔒 Premium Features
          </p>
          <p className="text-[10px] lg:text-sm text-muted-foreground">
            Response language customization requires an active license to use.
          </p>
        </div>
      )}

      {/* Speech Recognition Language Section */}
      <div className="space-y-4">
        <Header
          title="Speech Recognition Language"
          description="Select the language for speech-to-text recognition. Choose 'Auto-detect' to let the STT provider automatically identify the spoken language, or select a specific language for improved accuracy."
          isMainTitle
        />
        <div className="max-w-md">
          <Selection
            selected={sttLanguage}
            options={[
              { label: "Auto-detect (any language)", value: "auto" },
              ...STT_LANGUAGES.map((lang) => ({
                label: lang.name,
                value: lang.code,
              })),
            ]}
            placeholder="Choose language"
            onChange={(value) => {
              setSttLanguage(value);
            }}
          />
        </div>
      </div>

      {/* Response Language Section */}
      <div className="space-y-4">
        <Header
          title="Response Language"
          description="Select the language for AI responses. Setting applies globally to all providers and conversations. Language support may vary depending on your selected LLM provider"
          isMainTitle
        />

        <div className="max-w-md">
          <Selection
            selected={selectedLanguage}
            onChange={handleLanguageChange}
            options={languageOptions}
            placeholder="Select a language"
            disabled={!hasActiveLicense}
          />
        </div>
      </div>

      {/* Speech Translation Section */}
      <div className="space-y-4 pt-4 border-t">
        <Header
          title="Speech Translation"
          description="Enable real-time translation of your speech transcriptions to a second language."
          isMainTitle
        />

        <div className="flex items-center justify-between py-2">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Enable Translation</span>
            <span className="text-xs text-muted-foreground">
              Show translated version alongside original speech
            </span>
          </div>
          <Switch
            checked={sttTranslationEnabled}
            onCheckedChange={setSttTranslationEnabled}
          />
        </div>

        {sttTranslationEnabled && (
          <div className="space-y-2">
            <Header
              title="Target Language"
              description="Select the language to translate your speech into."
            />
            <Selection
              selected={sttTranslationLanguage}
              options={TRANSLATION_LANGUAGES.map((lang) => ({
                label: lang.name,
                value: lang.code,
              }))}
              placeholder="Choose target language"
              onChange={(value) => {
                setSttTranslationLanguage(value);
              }}
            />
          </div>
        )}
      </div>
    </PageLayout>
  );
};

export default Language;
