import { Switch, Label, Header } from "@/components";
import { useApp } from "@/contexts";

interface ContentProtectionToggleProps {
  className?: string;
}

export const ContentProtectionToggle = ({
  className,
}: ContentProtectionToggleProps) => {
  const { customizable, toggleContentProtection } = useApp();

  const handleSwitchChange = async (checked: boolean) => {
    await toggleContentProtection(checked);
  };

  return (
    <div id="content-protection" className={`space-y-2 ${className}`}>
      <Header
        title="Screen Capture Protection"
        description="Hide Meetwings windows from screenshots, screen recordings, and screen sharing"
        isMainTitle
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div>
            <Label className="text-sm font-medium">
              {customizable.contentProtection.isEnabled
                ? "Disable Screen Capture Protection"
                : "Enable Screen Capture Protection"}
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              {customizable.contentProtection.isEnabled
                ? "Meetwings windows appear black in screenshots and recordings"
                : "Meetwings windows are visible to capture tools and screen shares"}
            </p>
          </div>
        </div>
        <Switch
          checked={customizable.contentProtection.isEnabled}
          onCheckedChange={handleSwitchChange}
          title={`Toggle to ${
            !customizable.contentProtection.isEnabled ? "enable" : "disable"
          } screen capture protection`}
          aria-label="Toggle screen capture protection"
        />
      </div>
    </div>
  );
};