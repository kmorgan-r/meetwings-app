import {
  Header,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import { useApp } from "@/contexts";
import { emit } from "@tauri-apps/api/event";
import type { OverlayPillStyle } from "@/lib/storage";

interface OverlayPillStyleSelectProps {
  className?: string;
}

export const OverlayPillStyleSelect = ({
  className,
}: OverlayPillStyleSelectProps) => {
  const { customizable, setOverlayPillStyle } = useApp();

  const handleStyleChange = async (style: string) => {
    setOverlayPillStyle(style as OverlayPillStyle);
    // The pill renders in the `main` window and this settings page renders
    // in `dashboard`; both share localStorage, but main's React state will
    // not re-read it on its own. Same pattern MeetingAutoRecordToggle uses
    // for meeting-detection-setting-changed.
    try {
      await emit("overlay-pill-style-changed", { style });
    } catch (error) {
      console.error("Failed to announce the pill style change:", error);
    }
  };

  return (
    <div id="overlay-pill-style" className={`space-y-2 ${className}`}>
      <Header
        title="Minimized Pill Style"
        description="Choose what the overlay shows while minimized to the corner"
        isMainTitle
        rightSlot={
          <Select
            value={customizable.overlayPill.style}
            onValueChange={handleStyleChange}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a pill style" />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="status-count">Status and count</SelectItem>
              <SelectItem value="icon-only">Icon only</SelectItem>
              <SelectItem value="status-last-line">Status and last line</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </div>
  );
};
