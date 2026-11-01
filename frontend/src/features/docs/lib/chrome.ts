/**
 * The docs chrome text (search, table of contents, page actions), in the two
 * docs languages.
 *
 * These strings are not in the app catalogs on purpose: a docs page shows the
 * language of its URL (/docs or /docs/he), not the language of the reader's
 * app cookie, and the docs exist only in English and Hebrew.
 */

import type { DocsLocale } from "./nav";

export interface DocsChrome {
  docs: string;
  home: string;
  skip: string;
  menu: string;
  search: string;
  searchPlaceholder: string;
  searchEmpty: string;
  searchLoading: string;
  searchError: string;
  onThisPage: string;
  previous: string;
  next: string;
  lastUpdated: string;
  copyPage: string;
  copied: string;
  viewMarkdown: string;
  openInChatGpt: string;
  openInClaude: string;
  askPrompt: string;
  copyCode: string;
  openApp: string;
  apiReference: string;
  otherLanguage: string;
  otherLanguageName: string;
  theme: string;
  themeLight: string;
  themeDark: string;
  themeSystem: string;
  note: string;
  tip: string;
  warning: string;
}

export const DOCS_CHROME: Record<DocsLocale, DocsChrome> = {
  en: {
    docs: "Docs",
    home: "Skynet docs home",
    skip: "Skip to content",
    menu: "Pages",
    search: "Search",
    searchPlaceholder: "Search the docs",
    searchEmpty: "No pages match.",
    searchLoading: "Loading…",
    searchError: "Search is not available. Try again.",
    onThisPage: "On this page",
    previous: "Previous",
    next: "Next",
    lastUpdated: "Last updated {date}",
    copyPage: "Copy page as Markdown",
    copied: "Copied",
    viewMarkdown: "View as Markdown",
    openInChatGpt: "Open in ChatGPT",
    openInClaude: "Open in Claude",
    askPrompt: "Read {url} and answer my questions about Skynet.",
    copyCode: "Copy code",
    openApp: "Open Skynet",
    apiReference: "API reference",
    otherLanguage: "Read this page in Hebrew",
    otherLanguageName: "עברית",
    theme: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "System",
    note: "Note",
    tip: "Tip",
    warning: "Warning",
  },
  he: {
    docs: "תיעוד",
    home: "דף הבית של תיעוד Skynet",
    skip: "דילוג לתוכן",
    menu: "דפים",
    search: "חיפוש",
    searchPlaceholder: "חיפוש בתיעוד",
    searchEmpty: "אין דפים מתאימים.",
    searchLoading: "טוען…",
    searchError: "החיפוש לא זמין. נסה/י שוב.",
    onThisPage: "בדף הזה",
    previous: "הקודם",
    next: "הבא",
    lastUpdated: "עודכן לאחרונה ב-{date}",
    copyPage: "העתקת הדף כ-Markdown",
    copied: "הועתק",
    viewMarkdown: "הצגה כ-Markdown",
    openInChatGpt: "פתיחה ב-ChatGPT",
    openInClaude: "פתיחה ב-Claude",
    askPrompt: "קרא את {url} וענה על השאלות שלי על Skynet.",
    copyCode: "העתקת הקוד",
    openApp: "פתיחת Skynet",
    apiReference: "עיון ב-API",
    otherLanguage: "Read this page in English",
    otherLanguageName: "English",
    theme: "ערכת צבעים",
    themeLight: "בהירה",
    themeDark: "כהה",
    themeSystem: "לפי המערכת",
    note: "הערה",
    tip: "טיפ",
    warning: "אזהרה",
  },
};

/** Fill `{name}` slots in a chrome string. */
export function fillChrome(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (slot, name: string) => values[name] ?? slot);
}
