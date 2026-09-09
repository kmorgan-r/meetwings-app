import {
  Theme,
  AITitlesToggle,
  AlwaysOnTopToggle,
  AppIconToggle,
  AutostartToggle,
  ContentProtectionToggle,
  MeetingAutoRecordToggle,
  OverlayPillStyleSelect,
} from "./components";
import { PageLayout } from "@/layouts";
import { isWindows } from "@/lib/platform";

const Settings = () => {
  return (
    <PageLayout title="Settings" description="Manage your settings">
      {/* Theme */}
      <Theme />

      {/* Autostart Toggle */}
      <AutostartToggle />

      {/* App Icon Toggle */}
      <AppIconToggle />

      {/* Always On Top Toggle */}
      <AlwaysOnTopToggle />

      {/* Screen Capture Protection Toggle */}
      <ContentProtectionToggle />

      {/* Minimized Pill Style Select */}
      <OverlayPillStyleSelect />

      {/* AI Conversation Titles Toggle */}
      <AITitlesToggle />

      {/* Auto-record Meetings Toggle - Windows only */}
      {isWindows() && <MeetingAutoRecordToggle />}
    </PageLayout>
  );
};

export default Settings;
