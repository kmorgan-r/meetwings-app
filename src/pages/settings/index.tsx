import {
  Theme,
  AITitlesToggle,
  AlwaysOnTopToggle,
  AppIconToggle,
  AutostartToggle,
} from "./components";
import { PageLayout } from "@/layouts";

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
    </PageLayout>
  );
};

export default Settings;
