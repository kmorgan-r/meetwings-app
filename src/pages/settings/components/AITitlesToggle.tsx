import { useEffect, useState } from "react";
import { Switch, Label, Header } from "@/components";
import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "@/lib";
import { isAITitleEnabled } from "@/lib/functions/conversation-title";

interface AITitlesToggleProps {
  className?: string;
}

export const AITitlesToggle = ({ className }: AITitlesToggleProps) => {
  const [enabled, setEnabled] = useState<boolean>(true);

  useEffect(() => {
    setEnabled(isAITitleEnabled());
  }, []);

  const handleSwitchChange = (checked: boolean) => {
    setEnabled(checked);
    safeLocalStorage.setItem(STORAGE_KEYS.AI_TITLES_ENABLED, String(checked));
  };

  return (
    <div id="ai-titles" className={`space-y-2 ${className}`}>
      <Header
        title="AI Conversation Titles"
        description="Control how conversations are named in your chat history"
        isMainTitle
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div>
            <Label className="text-sm font-medium">
              {enabled ? "AI Titles Enabled" : "AI Titles Disabled"}
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              {enabled
                ? "New conversations are named by the AI, which costs one short extra request each"
                : "New conversations are named after their first message"}
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleSwitchChange}
          title={`Toggle to ${!enabled ? "enable" : "disable"} AI titles`}
          aria-label={`Toggle to ${enabled ? "disable" : "enable"} AI titles`}
        />
      </div>
    </div>
  );
};
