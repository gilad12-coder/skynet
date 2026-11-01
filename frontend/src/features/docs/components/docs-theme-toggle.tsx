"use client";

import { Desktop, Moon, Sun } from "@/shared/ui/icons";
import { useColorTheme } from "@/shared/providers/theme-provider";
import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import type { ColorTheme } from "@/shared/lib/color-theme";
import { useIndicator } from "../lib/use-indicator";

/** Light, dark or system colours. Shares the app's stored choice. */
export function DocsThemeToggle({
  labels,
  inline = false,
}: {
  labels: { theme: string; themeLight: string; themeDark: string; themeSystem: string };
  /** Borderless: a segment inside the header settings group. */
  inline?: boolean;
}) {
  const { theme, setTheme } = useColorTheme();
  const { ref: indicatorRef, box, moved } = useIndicator<HTMLDivElement>(theme);
  const options: Array<{ value: ColorTheme; label: string; Icon: typeof Sun }> = [
    { value: "light", label: labels.themeLight, Icon: Sun },
    { value: "dark", label: labels.themeDark, Icon: Moon },
    { value: "system", label: labels.themeSystem, Icon: Desktop },
  ];
  return (
    <div
      ref={indicatorRef}
      role="radiogroup"
      aria-label={labels.theme}
      className={cn(
        "relative flex items-center",
        !inline && "rounded-md border border-border p-0.5",
      )}
    >
      {box && (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-0 left-0 rounded bg-muted",
            moved && "docs-indicator",
          )}
          style={{
            width: box.width,
            height: box.height,
            transform: `translate(${box.x}px, ${box.y}px)`,
          }}
        />
      )}
      {options.map(({ value, label, Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={theme === value}
              data-active={theme === value}
              aria-label={label}
              onClick={() => setTheme(value)}
              className={cn(
                "relative inline-flex size-7 cursor-pointer items-center justify-center rounded transition-colors duration-200",
                theme === value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
