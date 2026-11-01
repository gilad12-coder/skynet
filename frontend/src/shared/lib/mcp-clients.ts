/**
 * Setup steps for connecting MCP clients to the hosted Skynet MCP server.
 *
 * This is the one source for every per-client snippet. The public page
 * /docs/mcp (and its Markdown twin) reads it today; the in-app Settings > MCP
 * page should import it too, so the two never drift. Check each client
 * against its own docs (`source`) and move MCP_CLIENTS_LAST_CHECKED when you
 * do. A client with `verified: false` was not checked against official docs.
 *
 * Kept free of `@/` imports so `node --test` can load it.
 */

/** The public MCP endpoint. Clients save this URL, so it must never change. */
export const MCP_SERVER_URL = "https://mcp.skynetml.com/mcp";

/** The day someone last checked every client below against its own docs. */
export const MCP_CLIENTS_LAST_CHECKED = "2026-11-01";

/** The server name that the commands and config files register. */
export const MCP_SERVER_NAME = "skynet";

/** A docs locale code. Text without a translation for it falls back to English. */
export type McpLocale = string;
type Localized<T> = { en: T; he: T } & Partial<Record<McpLocale, T>>;
type Text = Localized<string>;

/** A text in a locale, or in English when it has no translation. */
export function mcpText(text: Text, locale: McpLocale): string {
  return text[locale] ?? text.en;
}

export interface McpSnippet {
  label: Text;
  language: "bash" | "json" | "toml" | "text";
  code: string;
}

export interface McpClient {
  id: string;
  name: Text;
  /** False when the steps come from third-party docs, not the client's own. */
  verified: boolean;
  /** The client's own MCP setup docs. */
  source?: string;
  /** A one-click install link, when the client has one. */
  installUrl?: string;
  steps: Text[];
  snippets: McpSnippet[];
  note?: Text;
}

/** Base64 of a UTF-8 string, in Node and in the browser. */
function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** Cursor's install link: the config is base64 JSON, then URL-encoded. */
export function cursorInstallUrl(url: string = MCP_SERVER_URL): string {
  const config = encodeURIComponent(base64(JSON.stringify({ url })));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${config}`;
}

/** VS Code's install link: the config is URL-encoded JSON. */
export function vscodeInstallUrl(url: string = MCP_SERVER_URL): string {
  const config = encodeURIComponent(JSON.stringify({ type: "http", url }));
  return `https://vscode.dev/redirect/mcp/install?name=${MCP_SERVER_NAME}&config=${config}`;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude-code",
    name: { en: "Claude Code", he: "Claude Code" },
    verified: true,
    source: "https://code.claude.com/docs/en/mcp",
    steps: [
      { en: "Run this command in your terminal.", he: "הרץ/י את הפקודה הזו בטרמינל." },
      {
        en: "In Claude Code, run /mcp, select skynet, and sign in to Skynet in the browser.",
        he: "ב-Claude Code, הרץ/י ‎/mcp, בחר/י ב-skynet והתחבר/י ל-Skynet בדפדפן.",
      },
    ],
    snippets: [
      {
        label: { en: "Add the server", he: "הוספת השרת" },
        language: "bash",
        code: `claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_SERVER_URL}`,
      },
      {
        label: { en: "Add it for every project", he: "הוספה לכל הפרויקטים" },
        language: "bash",
        code: `claude mcp add --transport http --scope user ${MCP_SERVER_NAME} ${MCP_SERVER_URL}`,
      },
    ],
  },
  {
    id: "claude",
    name: { en: "Claude (web and desktop)", he: "Claude (אתר ואפליקציה)" },
    verified: true,
    source: "https://support.claude.com/en/articles/11175166",
    steps: [
      { en: "Open Customize, then Connectors.", he: "פתח/י את Customize ואז את Connectors." },
      {
        en: "Select +, then Add custom connector.",
        he: "בחר/י ב-+ ואז ב-Add custom connector.",
      },
      {
        en: `Enter the name Skynet and the URL ${MCP_SERVER_URL}, then select Add.`,
        he: `הזן/הזיני את השם Skynet ואת הכתובת ${MCP_SERVER_URL}, ואז בחר/י ב-Add.`,
      },
      { en: "Select Connect and sign in to Skynet.", he: "בחר/י ב-Connect והתחבר/י ל-Skynet." },
    ],
    snippets: [],
    note: {
      en: "On Team and Enterprise plans, an owner adds the connector in Organization settings, then Connectors. The Free plan allows one custom connector.",
      he: "בתוכניות Team ו-Enterprise, בעל הארגון מוסיף את המחבר ב-Organization settings ואז ב-Connectors. בתוכנית Free אפשר להוסיף מחבר מותאם אחד.",
    },
  },
  {
    id: "chatgpt",
    name: { en: "ChatGPT", he: "ChatGPT" },
    verified: true,
    source: "https://help.openai.com/en/articles/12584461",
    steps: [
      { en: "Open ChatGPT on the web, then open Plugins.", he: "פתח/י את ChatGPT באתר, ואז את Plugins." },
      {
        en: "Select +, then Add custom MCP server.",
        he: "בחר/י ב-+ ואז ב-Add custom MCP server.",
      },
      {
        en: `Enter the URL ${MCP_SERVER_URL}, choose OAuth, and sign in to Skynet.`,
        he: `הזן/הזיני את הכתובת ${MCP_SERVER_URL}, בחר/י ב-OAuth והתחבר/י ל-Skynet.`,
      },
      { en: "In a chat, type @ and select Skynet.", he: "בצ'אט, הקלד/י @ ובחר/י ב-Skynet." },
    ],
    snippets: [],
    note: {
      en: "Custom MCP servers depend on your ChatGPT plan. In Business workspaces, only admins can add them.",
      he: "שרתי MCP מותאמים תלויים בתוכנית ה-ChatGPT שלך. בסביבות Business, רק מנהלים יכולים להוסיף אותם.",
    },
  },
  {
    id: "codex",
    name: { en: "Codex", he: "Codex" },
    verified: true,
    source: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
    steps: [
      { en: "Add the server, then sign in.", he: "הוסף/י את השרת ואז התחבר/י." },
      {
        en: "Or add the server to ~/.codex/config.toml yourself.",
        he: "או הוסף/י את השרת בעצמך לקובץ ‎~/.codex/config.toml.",
      },
    ],
    snippets: [
      {
        label: { en: "Add and sign in", he: "הוספה והתחברות" },
        language: "bash",
        code: `codex mcp add ${MCP_SERVER_NAME} --url ${MCP_SERVER_URL}\ncodex mcp login ${MCP_SERVER_NAME}`,
      },
      {
        label: { en: "~/.codex/config.toml", he: "‎~/.codex/config.toml" },
        language: "toml",
        code: `[mcp_servers.${MCP_SERVER_NAME}]\nurl = "${MCP_SERVER_URL}"`,
      },
    ],
  },
  {
    id: "cursor",
    name: { en: "Cursor", he: "Cursor" },
    verified: true,
    source: "https://cursor.com/docs/context/mcp/install-links",
    installUrl: cursorInstallUrl(),
    steps: [
      { en: "Use the install link, or add the server to ~/.cursor/mcp.json.", he: "השתמש/י בקישור ההתקנה, או הוסף/י את השרת לקובץ ‎~/.cursor/mcp.json." },
      { en: "Cursor asks you to sign in to Skynet.", he: "Cursor יבקש ממך להתחבר ל-Skynet." },
    ],
    snippets: [
      {
        label: { en: "~/.cursor/mcp.json", he: "‎~/.cursor/mcp.json" },
        language: "json",
        code: json({ mcpServers: { [MCP_SERVER_NAME]: { url: MCP_SERVER_URL } } }),
      },
    ],
  },
  {
    id: "vscode",
    name: { en: "VS Code", he: "VS Code" },
    verified: true,
    source: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
    installUrl: vscodeInstallUrl(),
    steps: [
      {
        en: "Use the install link, the command line, or .vscode/mcp.json in your workspace.",
        he: "השתמש/י בקישור ההתקנה, בשורת הפקודה, או בקובץ ‎.vscode/mcp.json בסביבת העבודה.",
      },
      { en: "VS Code asks you to sign in to Skynet when the server starts.", he: "VS Code יבקש ממך להתחבר ל-Skynet כשהשרת עולה." },
    ],
    snippets: [
      {
        label: { en: "Command line", he: "שורת פקודה" },
        language: "bash",
        code: `code --add-mcp '${JSON.stringify({ name: MCP_SERVER_NAME, type: "http", url: MCP_SERVER_URL })}'`,
      },
      {
        label: { en: ".vscode/mcp.json", he: "‎.vscode/mcp.json" },
        language: "json",
        code: json({ servers: { [MCP_SERVER_NAME]: { type: "http", url: MCP_SERVER_URL } } }),
      },
    ],
  },
  {
    id: "gemini-cli",
    name: { en: "Gemini CLI", he: "Gemini CLI" },
    verified: true,
    source: "https://geminicli.com/docs/tools/mcp-server/",
    steps: [
      { en: "Add the server.", he: "הוסף/י את השרת." },
      { en: "In Gemini CLI, run /mcp auth skynet and sign in.", he: "ב-Gemini CLI, הרץ/י ‎/mcp auth skynet והתחבר/י." },
    ],
    snippets: [
      {
        label: { en: "Add the server", he: "הוספת השרת" },
        language: "bash",
        code: `gemini mcp add --transport http ${MCP_SERVER_NAME} ${MCP_SERVER_URL}`,
      },
      {
        label: { en: "settings.json", he: "settings.json" },
        language: "json",
        code: json({ mcpServers: { [MCP_SERVER_NAME]: { httpUrl: MCP_SERVER_URL } } }),
      },
    ],
  },
  {
    id: "windsurf",
    name: { en: "Windsurf", he: "Windsurf" },
    verified: false,
    steps: [
      { en: "Add the server to mcp_config.json.", he: "הוסף/י את השרת לקובץ mcp_config.json." },
    ],
    snippets: [
      {
        label: { en: "mcp_config.json", he: "mcp_config.json" },
        language: "json",
        code: json({ mcpServers: { [MCP_SERVER_NAME]: { serverUrl: MCP_SERVER_URL } } }),
      },
    ],
  },
  {
    id: "other",
    name: { en: "Other clients", he: "לקוחות אחרים" },
    verified: true,
    steps: [
      {
        en: "Any client that supports remote MCP servers over Streamable HTTP with OAuth can connect. Give it the server URL. Do not give it an API key.",
        he: "כל לקוח שתומך בשרתי MCP מרוחקים ב-Streamable HTTP עם OAuth יכול להתחבר. יש לתת לו את כתובת השרת. אין לתת לו מפתח API.",
      },
    ],
    snippets: [
      { label: { en: "Server URL", he: "כתובת השרת" }, language: "text", code: MCP_SERVER_URL },
    ],
  },
];

const MD_TEXT: Localized<{ install: string; unverified: string; source: string; checked: string }> = {
  en: {
    checked: "Last checked against each client's docs: {date}.",
    install: "Install with one click",
    unverified:
      "Not checked against this client's own docs. If these steps fail, use the client's MCP docs with the server URL.",
    source: "Official setup docs",
  },
  he: {
    checked: "נבדק לאחרונה מול התיעוד של כל לקוח: {date}.",
    install: "התקנה בלחיצה אחת",
    unverified:
      "השלבים לא נבדקו מול התיעוד של הלקוח עצמו. אם הם לא עובדים, השתמש/י בתיעוד ה-MCP של הלקוח עם כתובת השרת.",
    source: "תיעוד ההתקנה הרשמי",
  },
};

/** One client's setup steps as Markdown, without a heading. */
export function mcpClientMarkdown(client: McpClient, locale: McpLocale): string {
  const t = MD_TEXT[locale] ?? MD_TEXT.en;
  const parts: string[] = [];
  if (!client.verified) parts.push(`> [!WARNING]\n> ${t.unverified}`);
  parts.push(client.steps.map((step, i) => `${i + 1}. ${mcpText(step, locale)}`).join("\n"));
  if (client.installUrl) parts.push(`[${t.install}](${client.installUrl})`);
  for (const snippet of client.snippets) {
    parts.push(`**${mcpText(snippet.label, locale)}**\n\n\`\`\`${snippet.language}\n${snippet.code}\n\`\`\``);
  }
  if (client.note) parts.push(`> [!NOTE]\n> ${mcpText(client.note, locale)}`);
  if (client.source) parts.push(`[${t.source}](${client.source})`);
  return parts.join("\n\n");
}

/** The "last checked" line shown above the client steps. */
export function mcpClientsCheckedLine(locale: McpLocale): string {
  return (MD_TEXT[locale] ?? MD_TEXT.en).checked.replace("{date}", MCP_CLIENTS_LAST_CHECKED);
}

/** Every client's setup steps as Markdown, one level-3 section per client. */
export function mcpClientsMarkdown(locale: McpLocale): string {
  const sections = MCP_CLIENTS.map((client) => `### ${mcpText(client.name, locale)}\n\n${mcpClientMarkdown(client, locale)}`);
  return [`_${mcpClientsCheckedLine(locale)}_`, ...sections].join("\n\n");
}
