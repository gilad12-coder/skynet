import type { StorageItem } from "@/shared/lib/api";
import { msg, type MessageKey } from "@/shared/lib/messages";
import { ChatText, Database, FileText, Sparkle, Tag, type Icon } from "@/shared/ui/icons";

/** Storage categories, mirroring the backend ``STORAGE_CATEGORIES``. */
export type StorageCategory =
  | "optimizations"
  | "datasets"
  | "tagging_sessions"
  | "agent_chats"
  | "staged_uploads";

interface StorageCategoryMeta {
  label: MessageKey;
  /** One-line "what is this category" shown under the drawer title. */
  description: MessageKey;
  /** The category's homogeneous item type, used to route the bulk-delete batch. */
  itemType: StorageItem["type"];
  icon: Icon;
  /** Background class for the category's swatch and its slice of the usage bar. */
  swatch: string;
}

export const CATEGORY_META: Record<StorageCategory, StorageCategoryMeta> = {
  optimizations: {
    label: "storage.category.optimizations",
    description: "storage.category.desc.optimizations",
    itemType: "optimization",
    icon: Sparkle,
    swatch: "bg-chart-1",
  },
  datasets: {
    label: "storage.category.datasets",
    description: "storage.category.desc.datasets",
    itemType: "dataset",
    icon: Database,
    swatch: "bg-chart-2",
  },
  tagging_sessions: {
    label: "storage.category.tagging_sessions",
    description: "storage.category.desc.tagging_sessions",
    itemType: "tagging_session",
    icon: Tag,
    swatch: "bg-chart-4",
  },
  agent_chats: {
    label: "storage.category.agent_chats",
    description: "storage.category.desc.agent_chats",
    itemType: "chat",
    icon: ChatText,
    swatch: "bg-chart-3",
  },
  staged_uploads: {
    label: "storage.category.staged_uploads",
    description: "storage.category.desc.staged_uploads",
    itemType: "staged_upload",
    icon: FileText,
    swatch: "bg-chart-5",
  },
};

/** Every category, in the order the storage page lists them when sizes tie. */
export const STORAGE_CATEGORY_ORDER = Object.keys(CATEGORY_META) as StorageCategory[];

/** Metadata for a category key from the API; ``undefined`` for one this build doesn't know. */
export function categoryMeta(key: string | null | undefined): StorageCategoryMeta | undefined {
  return key && Object.hasOwn(CATEGORY_META, key)
    ? CATEGORY_META[key as StorageCategory]
    : undefined;
}

/** Display label for a category key, falling back to the raw key. */
export function categoryLabel(key: string): string {
  const meta = categoryMeta(key);
  return meta ? msg(meta.label) : key;
}
