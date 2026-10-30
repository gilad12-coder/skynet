/**
 * The app's light and dark colour themes for the IDE's VS Code workbench,
 * built from the app's design tokens (`app/globals.css`). Only the
 * workbench's colours change: syntax colours come from the default Modern
 * themes each one includes.
 */
import {
  registerExtension,
  type IExtensionManifest,
  type RegisterLocalExtensionResult,
} from "@codingame/monaco-vscode-api/extensions";
import darkModern from "@codingame/monaco-vscode-theme-defaults-default-extension/resources/dark_modern.json";
import darkPlus from "@codingame/monaco-vscode-theme-defaults-default-extension/resources/dark_plus.json";
import darkVs from "@codingame/monaco-vscode-theme-defaults-default-extension/resources/dark_vs.json";
import lightModern from "@codingame/monaco-vscode-theme-defaults-default-extension/resources/light_modern.json";
import lightPlus from "@codingame/monaco-vscode-theme-defaults-default-extension/resources/light_plus.json";
import lightVs from "@codingame/monaco-vscode-theme-defaults-default-extension/resources/light_vs.json";
import { APP_NAME } from "@/shared/lib/brand";

// The values are the names shown in the IDE's theme picker, so they carry the brand.
export const APP_LIGHT_THEME = `${APP_NAME} Light`;
export const APP_DARK_THEME = `${APP_NAME} Dark`;

/** The design tokens a theme is drawn from, as hex. */
interface Tokens {
  /** `--background`: the editor. */
  editor: string;
  /** `--sidebar`: the explorer, activity bar, tabs strip, panel, status and title bars. */
  chrome: string;
  /** `--popover`: menus, quick input, widgets, notifications. */
  popover: string;
  /** `--muted`. */
  muted: string;
  /** `--accent`: the selected row. */
  accent: string;
  /** `--accent-muted`: the hovered row. */
  hover: string;
  border: string;
  borderSubtle: string;
  /** `--input`: input borders. */
  input: string;
  foreground: string;
  /** `--text-2`. */
  softForeground: string;
  mutedForeground: string;
  /** `--primary`: focus rings, active markers, links. */
  primary: string;
  /** `--primary-fill`: filled buttons and badges. */
  fill: string;
  fillHover: string;
  onFill: string;
  /** The editor's selection: `--primary` at low alpha. */
  selection: string;
  danger: string;
  success: string;
  warning: string;
  scrollbar: string;
  scrollbarHover: string;
}

const LIGHT: Tokens = {
  editor: "#fcfaf7",
  chrome: "#f5f0ea",
  popover: "#ffffff",
  muted: "#f3eee8",
  accent: "#ede6dd",
  hover: "#b4521f0d",
  border: "#e6ded4",
  borderSubtle: "#ece5dc",
  input: "#d8cdc0",
  foreground: "#1c1612",
  softForeground: "#574a3f",
  mutedForeground: "#706356",
  primary: "#b4521f",
  fill: "#b4521f",
  fillHover: "#8f4318",
  onFill: "#ffffff",
  selection: "#b4521f33",
  danger: "#d03b3b",
  success: "#2f7565",
  warning: "#9a6510",
  scrollbar: "#1c16122e",
  scrollbarHover: "#1c161252",
};

const DARK: Tokens = {
  editor: "#221d19",
  chrome: "#1c1814",
  popover: "#312a24",
  muted: "#382f28",
  accent: "#3e342c",
  hover: "#e0935a0f",
  border: "#483d34",
  borderSubtle: "#3a312a",
  input: "#54483d",
  foreground: "#f3ede6",
  softForeground: "#cdbfb1",
  mutedForeground: "#a89a8c",
  primary: "#e0935a",
  fill: "#b4521f",
  fillHover: "#c9622a",
  onFill: "#ffffff",
  selection: "#e0935a40",
  danger: "#e66767",
  success: "#6cc0a8",
  warning: "#e0a84a",
  scrollbar: "#ffffff29",
  scrollbarHover: "#ffffff4d",
};

/** VS Code's workbench colours for a token table. */
function colors(t: Tokens): Record<string, string> {
  return {
    foreground: t.foreground,
    descriptionForeground: t.mutedForeground,
    errorForeground: t.danger,
    "icon.foreground": t.softForeground,
    focusBorder: t.primary,
    "selection.background": t.selection,
    "textLink.foreground": t.primary,
    "textLink.activeForeground": t.primary,
    "progressBar.background": t.primary,
    "widget.border": t.border,
    "widget.shadow": "#00000029",

    "editor.background": t.editor,
    "editor.foreground": t.foreground,
    "editor.selectionBackground": t.selection,
    "editor.inactiveSelectionBackground": t.accent,
    "editor.selectionHighlightBackground": t.hover,
    "editor.lineHighlightBackground": t.muted,
    "editor.lineHighlightBorder": t.muted,
    "editorCursor.foreground": t.primary,
    "editorGutter.background": t.editor,
    "editorGutter.modifiedBackground": t.primary,
    "editorGutter.addedBackground": t.success,
    "editorGutter.deletedBackground": t.danger,
    "editorLineNumber.foreground": t.mutedForeground,
    "editorLineNumber.activeForeground": t.foreground,
    "editorIndentGuide.background1": t.borderSubtle,
    "editorIndentGuide.activeBackground1": t.input,
    "editorError.foreground": t.danger,
    "editorWarning.foreground": t.warning,
    "editorWidget.background": t.popover,
    "editorWidget.border": t.border,
    "editorSuggestWidget.background": t.popover,
    "editorSuggestWidget.border": t.border,
    "editorSuggestWidget.selectedBackground": t.accent,
    "editorHoverWidget.background": t.popover,
    "editorHoverWidget.border": t.border,
    "editorGroup.border": t.border,
    "editorGroupHeader.tabsBackground": t.chrome,
    "editorGroupHeader.tabsBorder": t.border,
    "editorOverviewRuler.border": t.border,

    "tab.activeBackground": t.editor,
    "tab.activeForeground": t.foreground,
    "tab.activeBorder": t.editor,
    "tab.activeBorderTop": t.primary,
    "tab.selectedBorderTop": t.primary,
    "tab.unfocusedActiveBorder": t.editor,
    "tab.unfocusedActiveBorderTop": t.border,
    "tab.inactiveBackground": t.chrome,
    "tab.inactiveForeground": t.mutedForeground,
    "tab.hoverBackground": t.editor,
    "tab.unfocusedHoverBackground": t.chrome,
    "tab.border": t.border,
    "tab.lastPinnedBorder": t.border,

    "sideBar.background": t.chrome,
    "sideBar.foreground": t.softForeground,
    "sideBar.border": t.border,
    "sideBarTitle.foreground": t.foreground,
    "sideBarSectionHeader.background": t.chrome,
    "sideBarSectionHeader.foreground": t.foreground,
    "sideBarSectionHeader.border": t.border,

    "activityBar.background": t.chrome,
    "activityBar.foreground": t.foreground,
    "activityBar.inactiveForeground": t.mutedForeground,
    "activityBar.border": t.border,
    "activityBar.activeBorder": t.primary,
    "activityBarBadge.background": t.fill,
    "activityBarBadge.foreground": t.onFill,

    "statusBar.background": t.chrome,
    "statusBar.foreground": t.softForeground,
    "statusBar.border": t.border,
    "statusBar.inactiveBackground": t.chrome,
    "statusBar.noFolderBackground": t.chrome,
    "statusBar.focusBorder": t.primary,
    "statusBarItem.focusBorder": t.primary,
    "statusBarItem.hoverBackground": t.accent,
    "statusBarItem.remoteBackground": t.fill,
    "statusBarItem.remoteForeground": t.onFill,

    "titleBar.activeBackground": t.chrome,
    "titleBar.activeForeground": t.foreground,
    "titleBar.inactiveBackground": t.chrome,
    "titleBar.inactiveForeground": t.mutedForeground,
    "titleBar.border": t.border,

    "panel.background": t.chrome,
    "panel.border": t.border,
    "panelTitle.activeBorder": t.primary,
    "panelTitle.activeForeground": t.foreground,
    "panelTitle.inactiveForeground": t.mutedForeground,
    "panelInput.border": t.border,

    "button.background": t.fill,
    "button.foreground": t.onFill,
    "button.hoverBackground": t.fillHover,
    "button.border": "#00000000",
    "button.secondaryBackground": t.muted,
    "button.secondaryForeground": t.foreground,
    "button.secondaryHoverBackground": t.accent,
    "badge.background": t.muted,
    "badge.foreground": t.foreground,
    "checkbox.background": t.popover,
    "checkbox.border": t.input,

    "list.activeSelectionBackground": t.accent,
    "list.activeSelectionForeground": t.foreground,
    "list.activeSelectionIconForeground": t.foreground,
    "list.inactiveSelectionBackground": t.muted,
    "list.inactiveSelectionForeground": t.foreground,
    "list.hoverBackground": t.hover,
    "list.focusOutline": t.primary,
    "list.focusAndSelectionOutline": t.primary,
    "list.highlightForeground": t.primary,
    "list.errorForeground": t.danger,
    "list.warningForeground": t.warning,

    "input.background": t.popover,
    "input.border": t.input,
    "input.foreground": t.foreground,
    "input.placeholderForeground": t.mutedForeground,
    "inputOption.activeBackground": t.selection,
    "inputOption.activeBorder": t.primary,
    "inputOption.activeForeground": t.foreground,
    "dropdown.background": t.popover,
    "dropdown.listBackground": t.popover,
    "dropdown.border": t.input,
    "dropdown.foreground": t.foreground,
    "settings.modifiedItemIndicator": t.primary,

    "quickInput.background": t.popover,
    "quickInput.foreground": t.foreground,
    "quickInputList.focusBackground": t.accent,
    "quickInputList.focusForeground": t.foreground,
    "pickerGroup.border": t.border,
    "pickerGroup.foreground": t.mutedForeground,

    "scrollbarSlider.background": t.scrollbar,
    "scrollbarSlider.hoverBackground": t.scrollbarHover,
    "scrollbarSlider.activeBackground": t.scrollbarHover,

    "notifications.background": t.popover,
    "notifications.foreground": t.foreground,
    "notifications.border": t.border,
    "notificationCenterHeader.background": t.popover,
    "notificationCenterHeader.foreground": t.foreground,
    "notificationToast.border": t.border,
    "notificationsErrorIcon.foreground": t.danger,
    "notificationsWarningIcon.foreground": t.warning,
    "notificationsInfoIcon.foreground": t.primary,

    "menu.background": t.popover,
    "menu.foreground": t.foreground,
    "menu.border": t.border,
    "menu.selectionBackground": t.accent,
    "menu.selectionForeground": t.foreground,
    "menu.separatorBackground": t.border,
  };
}

function jsonUrl(value: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
}

/**
 * Contribute both themes as a built-in extension. Call before `initialize`:
 * the workbench then loads them with the default themes, so the
 * `workbench.colorTheme` setting resolves to them on its first read.
 */
export function registerAppThemes(): void {
  const manifest: IExtensionManifest = {
    name: "app-themes",
    publisher: "app",
    version: "1.0.0",
    engines: { vscode: "*" },
    contributes: {
      themes: [
        {
          id: APP_LIGHT_THEME,
          label: APP_LIGHT_THEME,
          uiTheme: "vs",
          path: "./themes/app-light.json",
        },
        {
          id: APP_DARK_THEME,
          label: APP_DARK_THEME,
          uiTheme: "vs-dark",
          path: "./themes/app-dark.json",
        },
      ],
    },
  };
  // Without a host kind the result still has `registerFileUrl` (the default
  // theme extension relies on it), but the overload types it without.
  const { registerFileUrl } = registerExtension(manifest, undefined, {
    system: true,
  }) as RegisterLocalExtensionResult;
  // A theme's `include` resolves inside its own extension, so the Modern
  // themes and the chains they include are registered here again.
  const files: Record<string, unknown> = {
    "themes/dark_modern.json": darkModern,
    "themes/dark_plus.json": darkPlus,
    "themes/dark_vs.json": darkVs,
    "themes/light_modern.json": lightModern,
    "themes/light_plus.json": lightPlus,
    "themes/light_vs.json": lightVs,
    "themes/app-light.json": {
      name: APP_LIGHT_THEME,
      include: "./light_modern.json",
      colors: colors(LIGHT),
    },
    "themes/app-dark.json": {
      name: APP_DARK_THEME,
      include: "./dark_modern.json",
      colors: colors(DARK),
    },
  };
  for (const [path, value] of Object.entries(files)) {
    registerFileUrl(path, jsonUrl(value), "application/json");
  }
}
