import {
  Settings,
  MessagesSquare,
  WandSparkles,
  AudioLinesIcon,
  SquareSlashIcon,
  MonitorIcon,
  HomeIcon,
  PowerIcon,
  MailIcon,
  GlobeIcon,
  BugIcon,
  MessageSquareTextIcon,
  DollarSignIcon,
  BrainIcon,
  UsersIcon,
  LanguagesIcon,
  KeyRound,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useApp } from "@/contexts";
import { GithubIcon } from "@/components";
import { useSetupStatus } from "./useSetupStatus";

export const useMenuItems = () => {
  const { hasActiveLicense } = useApp();
  const { isComplete: setupComplete } = useSetupStatus();

  const menu: {
    icon: React.ElementType;
    label: string;
    href: string;
    count?: number;
    disabled?: boolean;
    showWarning?: boolean;
  }[] = [
    {
      icon: HomeIcon,
      label: "Dashboard",
      href: "/dashboard",
      disabled: !setupComplete,
    },
    {
      icon: KeyRound,
      label: "API Setup",
      href: "/api-setup",
      showWarning: !setupComplete,
    },
    {
      icon: MessagesSquare,
      label: "Chats",
      href: "/chats",
      disabled: !setupComplete,
    },
    {
      icon: WandSparkles,
      label: "System prompts",
      href: "/system-prompts",
      disabled: !setupComplete,
    },
    {
      icon: Settings,
      label: "App Settings",
      href: "/settings",
      disabled: !setupComplete,
    },
    {
      icon: MessageSquareTextIcon,
      label: "Responses",
      href: "/responses",
      disabled: !setupComplete,
    },
    {
      icon: DollarSignIcon,
      label: "Cost Tracking",
      href: "/cost-tracking",
      disabled: !setupComplete,
    },
    {
      icon: BrainIcon,
      label: "Context Memory",
      href: "/context-memory",
      disabled: !setupComplete,
    },
    {
      icon: MonitorIcon,
      label: "Screenshot",
      href: "/screenshot",
      disabled: !setupComplete,
    },
    {
      icon: AudioLinesIcon,
      label: "Audio",
      href: "/audio",
      disabled: !setupComplete,
    },
    {
      icon: UsersIcon,
      label: "Speakers",
      href: "/speakers",
      disabled: !setupComplete,
    },
    {
      icon: LanguagesIcon,
      label: "Language",
      href: "/language",
      disabled: !setupComplete,
    },
    {
      icon: SquareSlashIcon,
      label: "Cursor & Shortcuts",
      href: "/shortcuts",
      disabled: !setupComplete,
    },
  ];

  const footerItems = [
    ...(hasActiveLicense
      ? [
          {
            icon: MailIcon,
            label: "Contact Support",
            action: async () => {
              try {
                await navigator.clipboard.writeText("support@meetwings.com");
                alert("Email copied to clipboard: support@meetwings.com");
              } catch (err) {
                alert("Support email: support@meetwings.com");
              }
            },
          },
        ]
      : []),
    {
      icon: BugIcon,
      label: "Report a bug",
      href: "https://github.com/kmorgan-r/meetwings/issues/new?template=bug-report.yml",
    },
    {
      icon: PowerIcon,
      label: "Quit Meetwings",
      action: async () => {
        await invoke("exit_app");
      },
    },
  ];

  const footerLinks: {
    title: string;
    icon: React.ElementType;
    link: string;
  }[] = [
    {
      title: "Website",
      icon: GlobeIcon,
      link: "https://meetwings.com",
    },
    {
      title: "Github",
      icon: GithubIcon,
      link: "https://github.com/kmorgan-r/meetwings",
    },
  ];

  return {
    menu,
    footerItems,
    footerLinks,
  };
};
