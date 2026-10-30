import {
  CheckCircle,
  Envelope,
  GoogleChromeLogo,
  HandPalm,
  Hourglass,
  Megaphone,
  ShareNetwork,
  SlackLogo,
  Tray,
  Trophy,
  Wallet,
  XCircle,
  type Icon,
} from "@/shared/ui/icons";
import type { NotificationChannel, NotificationEventType } from "@/shared/lib/api";

export const EVENT_ICONS: Record<NotificationEventType, Icon> = {
  needs_input: HandPalm,
  budget_near: Wallet,
  failed: XCircle,
  finished: CheckCircle,
  new_best: Trophy,
  stuck: Hourglass,
  shared: ShareNetwork,
  product_news: Megaphone,
};

export const CHANNEL_ICONS: Record<NotificationChannel, Icon> = {
  inbox: Tray,
  email: Envelope,
  chrome: GoogleChromeLogo,
  slack: SlackLogo,
};
