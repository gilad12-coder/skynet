"use client";

import { Desktop, Moon, Sun } from "@/shared/ui/icons";
import { useColorTheme } from "@/shared/providers/theme-provider";
import { cn } from "@/shared/lib/utils";
import type { ColorTheme } from "@/shared/lib/color-theme";

/** Light, dark or system colours. Shares the app's stored choice. */
export function DocsThemeToggle({
  labels,
}: {
  labels: { theme: string; themeLight: string; themeDark: string; themeSystem: string };
}) {
  const { theme, setTheme } = useColorTheme();
  const options: Array<{ value: ColorTheme; label: string; Icon: typeof Sun }> = [
    { value: "light", label: labels.themeLight, Icon: Sun },
    { value: "dark", label: labels.themeDark, Icon: Moon },
    { value: "system", label: labels.themeSystem, Icon: Desktop },
  ];
  return (
    <div role="radiogroup" aria-label={labels.theme} className="flex items-center rounded-md border border-border p-0.5">
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={cn(
            "inline-flex size-7 cursor-pointer items-center justify-center rounded transition-colors",
            theme === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
