import {
  Theme,
  AITitlesToggle,
  AlwaysOnTopToggle,
  AppIconToggle,
  AutostartToggle,
  MeetingDetectionToggle,
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

      {/* AI Conversation Titles Toggle */}
      <AITitlesToggle />

      {/* Meeting Detection Toggle - Windows only */}
      {isWindows() && <MeetingDetectionToggle />}
    </PageLayout>
  );
};

export default Settings;
