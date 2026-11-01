/**
 * The public docs manifest: every page, its section, its titles and the date
 * someone last checked it against the code. The sidebar, prev/next links,
 * search, sitemap and llms.txt all read this one list, in this order.
 *
 * Kept free of `@/` imports so `node --test` can load it.
 */

export const DOCS_LOCALES = ["en", "he"] as const;
export type DocsLocale = (typeof DOCS_LOCALES)[number];

export type DocsSectionId = "start" | "concepts" | "guides" | "integrations" | "reference";

export interface DocsPage {
  /** The page path under /docs; "" is the introduction at /docs itself. */
  slug: string;
  section: DocsSectionId;
  title: Record<DocsLocale, string>;
  description: Record<DocsLocale, string>;
  /** The day someone last checked the page against the code (YYYY-MM-DD). */
  updated: string;
}

export const DOCS_SECTIONS: Array<{ id: DocsSectionId; title: Record<DocsLocale, string> }> = [
  { id: "start", title: { en: "Get started", he: "תחילת עבודה" } },
  { id: "concepts", title: { en: "Concepts", he: "מושגים" } },
  { id: "guides", title: { en: "Guides", he: "מדריכים" } },
  { id: "integrations", title: { en: "Integrations", he: "חיבורים" } },
  { id: "reference", title: { en: "Reference", he: "עיון" } },
];

const UPDATED = "2026-11-01";

export const DOCS_PAGES: DocsPage[] = [
  {
    slug: "",
    section: "start",
    title: { en: "Introduction", he: "מבוא" },
    description: {
      en: "What Skynet is, what it optimizes, and where to start.",
      he: "מה זה Skynet, מה הוא משפר, ואיפה להתחיל.",
    },
    updated: UPDATED,
  },
  {
    slug: "quickstart",
    section: "start",
    title: { en: "Quickstart", he: "התחלה מהירה" },
    description: {
      en: "Start your first optimization run in about ten minutes.",
      he: "הפעל/י את ריצת האופטימיזציה הראשונה שלך בכעשר דקות.",
    },
    updated: UPDATED,
  },
  {
    slug: "concepts/optimization",
    section: "concepts",
    title: { en: "How optimization works", he: "איך האופטימיזציה עובדת" },
    description: {
      en: "The run and score contract, the artifact kinds, and the engines for each kind.",
      he: "חוזה הריצה והציון, סוגי הארטיפקטים, והמנועים לכל סוג.",
    },
    updated: UPDATED,
  },
  {
    slug: "concepts/engines",
    section: "concepts",
    title: { en: "Engines", he: "מנועים" },
    description: {
      en: "GEPA, Best-of-N, Meta-Harness, AutoResearch, AutoSaddler, ShinkaEvolve and Auto.",
      he: "GEPA, Best-of-N, Meta-Harness, AutoResearch, AutoSaddler, ShinkaEvolve ו-Auto.",
    },
    updated: UPDATED,
  },
  {
    slug: "concepts/datasets",
    section: "concepts",
    title: { en: "Datasets and splits", he: "דאטאסטים וחלוקה" },
    description: {
      en: "How Skynet reads your cases and splits them into train, validation and test.",
      he: "איך Skynet קורא את המקרים שלך ומחלק אותם לאימון, אימות ובדיקה.",
    },
    updated: UPDATED,
  },
  {
    slug: "concepts/scorers",
    section: "concepts",
    title: { en: "Metrics and scorers", he: "פונקציות מדידה ופונקציות ציון" },
    description: {
      en: "Write the score function that tells the engine what better means.",
      he: "כתוב/כתבי את פונקציית המדידה שאומרת למנוע מה נחשב טוב יותר.",
    },
    updated: UPDATED,
  },
  {
    slug: "concepts/runs",
    section: "concepts",
    title: { en: "Runs", he: "ריצות" },
    description: {
      en: "Run states, the actions you can take on a run, and how a run stops.",
      he: "מצבי ריצה, הפעולות שאפשר לבצע על ריצה, ואיך ריצה נעצרת.",
    },
    updated: UPDATED,
  },
  {
    slug: "concepts/billing",
    section: "concepts",
    title: { en: "Budgets and billing", he: "תקציבים וחיוב" },
    description: {
      en: "Balance, run budgets, fees, and bring-your-own-key (BYOK) model routes.",
      he: "יתרה, תקציבי ריצה, עמלות, ומפתחות API משלך (BYOK).",
    },
    updated: UPDATED,
  },
  {
    slug: "guides/datasets",
    section: "guides",
    title: { en: "Prepare a dataset", he: "הכנת דאטאסט" },
    description: {
      en: "Upload a CSV, JSON or Excel file, check its columns, and edit rows.",
      he: "העלה/י קובץ CSV, JSON או Excel, בדוק/בדקי את העמודות וערוך/ערכי שורות.",
    },
    updated: UPDATED,
  },
  {
    slug: "guides/submit",
    section: "guides",
    title: { en: "Start a run with the wizard", he: "הפעלת ריצה עם האשף" },
    description: {
      en: "Each step of the submit wizard, from the task to the contract check.",
      he: "כל שלב באשף ההגשה, מהמשימה ועד בדיקת החוזה.",
    },
    updated: UPDATED,
  },
  {
    slug: "guides/results",
    section: "guides",
    title: { en: "Read the results", he: "קריאת התוצאות" },
    description: {
      en: "The run page tabs, the scores, and how to export or serve the winner.",
      he: "לשוניות דף הריצה, הציונים, ואיך לייצא או להגיש את הגרסה המנצחת.",
    },
    updated: UPDATED,
  },
  {
    slug: "guides/sharing",
    section: "guides",
    title: { en: "Share and publish", he: "שיתוף ופרסום" },
    description: {
      en: "Run visibility, share links, roles, and the Explore gallery.",
      he: "נראות ריצות, קישורי שיתוף, תפקידים וגלריית Explore.",
    },
    updated: UPDATED,
  },
  {
    slug: "guides/tagger",
    section: "guides",
    title: { en: "Label data with the tagger", he: "תיוג נתונים עם כלי התיוג" },
    description: {
      en: "Manual, Co-pilot and Autopilot labeling, review rounds, and export.",
      he: "תיוג ידני, Co-pilot ו-Autopilot, סבבי בדיקה וייצוא.",
    },
    updated: UPDATED,
  },
  {
    slug: "guides/mac-app",
    section: "guides",
    title: { en: "Mac app", he: "אפליקציית Mac" },
    description: {
      en: "Run Skynet on your Mac with your own coding agent and Docker.",
      he: "הרץ/י את Skynet על ה-Mac שלך עם סוכן הקוד שלך ו-Docker.",
    },
    updated: UPDATED,
  },
  {
    slug: "guides/agent-panel",
    section: "guides",
    title: { en: "Agent panel", he: "פאנל הסוכן" },
    description: {
      en: "Ask the assistant to set up, start and explain runs, and control what it may do.",
      he: "בקש/י מהעוזר להגדיר, להפעיל ולהסביר ריצות, וקבע/י מה מותר לו לעשות.",
    },
    updated: UPDATED,
  },
  {
    slug: "mcp",
    section: "integrations",
    title: { en: "MCP server", he: "שרת MCP" },
    description: {
      en: "Connect Claude, ChatGPT, Codex, Cursor, VS Code and other clients to Skynet.",
      he: "חבר/י את Claude, ChatGPT, Codex, Cursor, VS Code ולקוחות נוספים ל-Skynet.",
    },
    updated: UPDATED,
  },
  {
    slug: "api",
    section: "integrations",
    title: { en: "API", he: "API" },
    description: {
      en: "Authenticate, start a run, and read results with the HTTP API.",
      he: "התחברות, הפעלת ריצה וקריאת תוצאות דרך ה-API.",
    },
    updated: UPDATED,
  },
  {
    slug: "security",
    section: "reference",
    title: { en: "Security", he: "אבטחה" },
    description: {
      en: "Where your code runs, how credentials are kept, and how to report a problem.",
      he: "איפה הקוד שלך רץ, איך נשמרים פרטי גישה, ואיך לדווח על בעיה.",
    },
    updated: UPDATED,
  },
  {
    slug: "limits",
    section: "reference",
    title: { en: "Limits", he: "מגבלות" },
    description: {
      en: "Default limits for runs, files, datasets, storage and request rates.",
      he: "מגבלות ברירת המחדל לריצות, קבצים, דאטאסטים, אחסון וקצב בקשות.",
    },
    updated: UPDATED,
  },
  {
    slug: "faq",
    section: "reference",
    title: { en: "FAQ", he: "שאלות נפוצות" },
    description: {
      en: "Short answers to common questions.",
      he: "תשובות קצרות לשאלות נפוצות.",
    },
    updated: UPDATED,
  },
];

/** Whether a string names a docs locale. */
export function isDocsLocale(value: string | undefined): value is DocsLocale {
  return value === "en" || value === "he";
}

/**
 * Split a docs URL path into its locale and page slug.
 *
 * English pages have no prefix (/docs/quickstart); Hebrew pages start with
 * /docs/he. Returns null when no page matches.
 */
export function resolveDocsPath(segments: readonly string[]): { locale: DocsLocale; page: DocsPage } | null {
  const [first, ...rest] = segments;
  const locale: DocsLocale = first === "he" ? "he" : "en";
  const slug = (first === "he" ? rest : segments).join("/");
  const page = DOCS_PAGES.find((p) => p.slug === slug);
  return page ? { locale, page } : null;
}

/** The site-relative URL of a page in a locale. */
export function docsHref(slug: string, locale: DocsLocale): string {
  const base = locale === "he" ? "/docs/he" : "/docs";
  return slug ? `${base}/${slug}` : base;
}

/**
 * Point the docs links in a page body at the page's locale. The Hebrew pages
 * link to `/docs/...` like the English ones, so readers stay in their language.
 */
export function localizeDocsLinks(markdown: string, locale: DocsLocale): string {
  if (locale === "en") return markdown;
  return markdown.replace(/\]\(\/docs(?=[/)#])(?!\/he(?=[/)#]))/g, "](/docs/he");
}

/** The site-relative URL of a page's Markdown twin. */
export function docsMarkdownHref(slug: string, locale: DocsLocale): string {
  return `${docsHref(slug, locale)}.md`;
}

/** The pages before and after a page in reading order. */
export function docsNeighbors(slug: string): { prev: DocsPage | null; next: DocsPage | null } {
  const i = DOCS_PAGES.findIndex((p) => p.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: DOCS_PAGES[i - 1] ?? null, next: DOCS_PAGES[i + 1] ?? null };
}
