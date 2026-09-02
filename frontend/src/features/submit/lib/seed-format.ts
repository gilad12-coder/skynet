/**
 * Reads a pasted starting point and says whether it is source code and,
 * when it can tell, in which language — so the Starting point step opens the
 * editor that fits the paste instead of a plain textarea.
 */

/** Grammar names as `@codemirror/language-data` knows them, so a detected
 *  language can be handed straight to the editor. */
export type SeedLanguage =
  | "Python"
  | "TypeScript"
  | "TSX"
  | "JavaScript"
  | "JSX"
  | "JSON"
  | "YAML"
  | "TOML"
  | "SQL"
  | "HTML"
  | "XML"
  | "CSS"
  | "Rust"
  | "Go"
  | "Java"
  | "C"
  | "C++"
  | "C#"
  | "Kotlin"
  | "Swift"
  | "Ruby"
  | "PHP"
  | "Lua"
  | "Shell"
  | "Dockerfile";

const SHEBANGS: Array<[RegExp, SeedLanguage]> = [
  [/python/, "Python"],
  [/\b(node|deno|bun)\b/, "JavaScript"],
  [/\bruby\b/, "Ruby"],
  [/\bphp\b/, "PHP"],
  [/\blua\b/, "Lua"],
];

// A line that ends a statement the C-family way. Prose ends lines with
// semicolons too, so the line has to carry a call, an assignment or a
// jump keyword before it counts.
const STATEMENT = /(?:[=(].*|^\s*(?:return|break|continue|throw)\b.*);\s*$/;
const NEW_CALL = /\bnew\s+\w+(<[^>]*>)?\s*\(/;
const ACCESS_MODIFIER = /^\s*(public|private|protected|internal|static)\s/;

const C_LINES = [
  /^\s*#include\s+(<\w+\.h>|"[\w/.-]+")/,
  /^\s*#\s*(define|ifdef|ifndef|endif|pragma)\b/,
  /^\s*(static\s+|const\s+|unsigned\s+)*(int|char|void|float|double|long|short|bool|size_t|struct\s+\w+)\s+\**\w+\s*[(=;[]/,
  /\b(printf|malloc|calloc|free|sizeof|memcpy|strlen)\s*\(/,
  STATEMENT,
];

const JS_BASE = [
  /^\s*(const|let|var)\s+[\w{[$]+.*=/,
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/,
  /^\s*(import|export)\b.*\bfrom\s+['"]/,
  /^\s*import\s+['"]/,
  /^\s*export\s+(default\s+)?(const|class|async|function|\{)/,
  /(\)|\w)\s*=>\s*/,
  /\bconsole\.\w+\(/,
  /\brequire\(['"]/,
  /^\s*module\.exports\b/,
  /\b(document|window)\.\w+/,
  STATEMENT,
];

const TS_ONLY = [
  /^\s*(export\s+)?(declare\s+)?(type|interface|enum|namespace)\s+\w+/,
  /^\s*import\s+type\b/,
  /:\s*(string|number|boolean|void|unknown|any|never|null)\b/,
  /\)\s*:\s*[\w<>[\]|]+\s*(=>|\{)/,
  /\w+\?:\s/,
  /\bas\s+const\b/,
];

const JSX_ONLY = [/^\s*<\/?[A-Z]\w*[\s>/]/, /=\{[^}]*\}/, /^\s*return\s*\(\s*$/, /\bclassName=/];

interface Signal {
  language: SeedLanguage;
  // Non-blank lines that have to match before the language is claimed.
  min: number;
  lines: RegExp[];
  // A line shape the text must contain at all for the language to be in the
  // running — keeps look-alikes (`x = 1` in Python vs TOML) apart.
  anchor?: RegExp;
}

/* Ordered: on a tie the earlier entry wins, so a language sits ahead of any
   language whose signals it shares (C before C++, Java before C#, Python
   before anything that also ends lines with `return x`). */
const SIGNALS: Signal[] = [
  {
    language: "Dockerfile",
    min: 2,
    anchor: /^FROM\s/,
    lines: [
      /^(FROM|RUN|COPY|ADD|CMD|ENTRYPOINT|WORKDIR|ENV|EXPOSE|ARG|VOLUME|USER|LABEL|HEALTHCHECK)\s/,
    ],
  },
  {
    language: "TOML",
    min: 2,
    anchor: /^\s*\[\[?[\w.-]+\]\]?\s*$/,
    lines: [/^\s*\[\[?[\w.-]+\]\]?\s*$/, /^\s*[\w.-]+\s*=\s*("|'|\d|true|false|\[|\{)/],
  },
  {
    language: "Python",
    anchor:
      /^\s*(?:def|class|import|from\s+[\w.]+\s+import|if|elif|for|while|with|try|except|return|print|@\w+)\b/,
    min: 2,
    lines: [
      /^\s*(async\s+)?(def|class)\s+\w+.*:\s*(#.*)?$/,
      /^\s*import\s+[\w.]+(\s+as\s+\w+)?(\s*,\s*[\w.]+)*\s*(#.*)?$/,
      /^\s*from\s+[\w.]+\s+import\s/,
      /^\s*(if|elif|else|for|while|with|try|except|finally)\b.*:\s*(#.*)?$/,
      /^\s*(print|return|yield|raise|pass|assert|lambda)\b(?!.*;\s*$)/,
      /^\s*@\w+(\.\w+)*(\(.*\))?\s*$/,
      /\bself\./,
      /^\s*[\w.[\]]+ (?:[-+*/]?=) (?!=)(?!.*;\s*$)/,
    ],
  },
  {
    language: "Go",
    min: 2,
    lines: [
      /^package\s+\w+\s*$/,
      /^import\s+(\(|")/,
      /^\s*func\s+(\(\w+\s+\*?\w+\)\s*)?\w+\(/,
      /^\s*type\s+\w+\s+(struct|interface)\b/,
      /\w+\s*:=\s/,
      /\bfmt\.\w+\(/,
      /\berr\s*!=\s*nil\b/,
    ],
  },
  {
    language: "Rust",
    min: 2,
    lines: [
      /^\s*(pub(\(\w+\))?\s+)?(fn|struct|enum|impl|trait|mod)\s+[\w<]/,
      /^\s*use\s+[\w:]+(::\{.*\})?;\s*$/,
      /\blet\s+(mut\s+\w+|\w+\s*:\s*[\w<>&[\]]+)\s*=/,
      /\w+!\s*[([]/,
      /&(mut\s+)?self\b|(?<![\w$])->\s*[\w<&(]/,
      /^\s*#\[\w+/,
    ],
  },
  {
    language: "Java",
    min: 2,
    lines: [
      /^\s*package\s+[\w.]+;/,
      /^\s*import\s+(static\s+)?[\w.]+(\.\*)?;/,
      ACCESS_MODIFIER,
      /System\.(out|err)\./,
      /^\s*@(Override|Test|Autowired|Bean)\b/,
      NEW_CALL,
      STATEMENT,
    ],
  },
  { language: "C", min: 2, lines: C_LINES },
  {
    language: "C++",
    min: 2,
    lines: [
      ...C_LINES,
      /^\s*#include\s+<\w+>/,
      /\bstd::|::\w+\(|\b(cout|cin|cerr)\b/,
      /\btemplate\s*</,
      /^\s*(class|namespace)\s+\w+/,
      /\bnullptr\b|\bauto\s+\w+\s*=/,
    ],
  },
  {
    language: "C#",
    min: 2,
    lines: [
      /^\s*using\s+[\w.]+;/,
      /^\s*namespace\s+[\w.]+/,
      /^\s*((public|internal|static|sealed|partial|abstract)\s+)*(class|interface|struct|record|enum)\s+\w+/,
      /\bConsole\.\w+\(/,
      ACCESS_MODIFIER,
      /\bvar\s+\w+\s*=/,
      NEW_CALL,
      STATEMENT,
    ],
  },
  {
    language: "Kotlin",
    min: 2,
    lines: [
      /^\s*(fun|val|var)\s+\w+/,
      /^\s*(data\s+|sealed\s+|open\s+)?(class|object|interface)\s+\w+/,
      /^\s*(import|package)\s+[\w.]+\s*$/,
      /\bprintln\(/,
      /\b(listOf|mapOf|mutableListOf)\(/,
    ],
  },
  {
    language: "Swift",
    min: 2,
    lines: [
      /^\s*(func|let|var)\s+\w+/,
      /^\s*import\s+(Foundation|UIKit|SwiftUI|Combine)\b/,
      /^\s*(struct|class|enum|protocol|extension)\s+\w+/,
      /\bprint\(/,
      /\bguard\s+let\b|\bif\s+let\b/,
    ],
  },
  { language: "JavaScript", min: 2, lines: [...JS_BASE, ...TS_ONLY, ...JSX_ONLY] },
  {
    language: "PHP",
    min: 2,
    lines: [
      /<\?php/,
      /^\s*\$\w+\s*(=|\.=|\+=)/,
      /\$\w+->\w+/,
      /^\s*(foreach|echo|namespace|use|require|include)\b/,
      /^\s*['"]\w+['"]\s*=>/,
      /^\s*(public|private|protected)\s+(static\s+)?function\b/,
      STATEMENT,
    ],
  },
  {
    language: "Ruby",
    min: 2,
    lines: [
      /^\s*(def|class|module)\s+[\w.:]+(\(.*\))?\s*$/,
      /^\s*end\s*$/,
      /^\s*(puts|require|require_relative|attr_accessor|attr_reader)\s/,
      /\.each\s+do\b|\bdo\s*\|/,
      /^\s*@\w+\s*=/,
    ],
  },
  {
    language: "Lua",
    min: 2,
    lines: [
      /^\s*local\s+\w+/,
      /^\s*(local\s+)?function\s+[\w.:]+\s*\(/,
      /=\s*function\s*\(/,
      /^\s*end\s*$/,
      /^\s*(if|elseif|while|for)\b.*\b(then|do)\s*$/,
      /~=/,
      /\.\.\s*["\w]/,
    ],
  },
  {
    language: "Shell",
    min: 2,
    lines: [
      /^\s*(set\s+-[a-zA-Z]+|export\s+\w+=|cd\s|echo\s|npm\s|npx\s|yarn\s|pnpm\s|pip3?\s|apt(-get)?\s|brew\s|sudo\s|mkdir\s|rm\s|cp\s|mv\s|curl\s|wget\s|git\s|chmod\s|docker\s|make\s|source\s|\.\s)/,
      /^\s*(if\s+\[|fi|then|do|done|esac)\s*$/,
      /^\s*\w+\(\)\s*\{/,
      /\$\{?[A-Za-z_@#?]|\$\(/,
      /^(?!\s*\|).*\s\|\s*\w|&&\s*\\?$/,
      /^\s*\w+=("[^"]*"|'[^']*'|\S+)\s*$/,
    ],
  },
  {
    language: "SQL",
    min: 2,
    anchor:
      /^\s*(select|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(or\s+replace\s+)?(table|view|index|schema|function|type)|alter\s+table|drop\s+(table|view|index)|with\s+\w+\s+as\s*\()\b/i,
    lines: [
      /^\s*(select|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(or\s+replace\s+)?(table|view|index|schema|function|type)|alter\s+table|drop\s+(table|view|index)|with\s+\w+\s+as\s*\(|truncate|grant|begin|commit|rollback)\b(?!.*[.!?]\s*$)/i,
      /^\s*(from\s+(?!.*\bimport\b)|where|(left|right|inner|outer|cross|full)?\s*(outer\s+)?join|group\s+by|order\s+by|having|limit|offset|values|union|returning)\b\s(?!.*[.!?]\s*$)/i,
      /\b(primary\s+key|not\s+null|varchar\s*\(|auto_increment|serial\b)/i,
    ],
  },
  {
    language: "HTML",
    min: 2,
    lines: [
      /^\s*<!doctype\s+html/i,
      /^\s*<\/?(html|head|body|div|span|p|a|ul|ol|li|h[1-6]|table|tr|td|th|form|input|button|img|script|style|link|meta|nav|section|header|footer|main|label|select|option|textarea|br|hr|svg|path|title)\b[^>]*>?/i,
    ],
  },
  {
    language: "XML",
    min: 2,
    lines: [/^\s*<\?xml/, /^\s*<\/?[a-zA-Z][\w:.-]*(\s[^>]*)?\/?>/],
  },
  {
    language: "CSS",
    min: 2,
    lines: [
      /^\s*(?!(else|try|do|finally|class|struct|enum|impl|interface|namespace|type|pub|fun|func|object|extension|protocol|trait|mod)\b)[.#]?[\w-]+(\s*[,>+~ ]\s*[.#]?[\w-]+)*(:{1,2}[\w-]+(\(.*\))?)*\s*\{\s*$/,
      /^\s*[\w-]+\s*:\s*[^;{}]+;\s*$/,
      /^\s*@(media|import|keyframes|font-face|supports|tailwind|apply|layer)\b/,
      /^\s*--[\w-]+\s*:/,
    ],
  },
  {
    language: "JSON",
    anchor: /^\s*"[^"]*"\s*:/,
    min: 2,
    lines: [/^\s*"[^"]*"\s*:\s*\S/, /^\s*[{}[\]],?\s*$/],
  },
];

const YAML_KEY = /^\s*[\w.-]+:(\s+\S.*)?$/;
const YAML_LIST = /^\s*-\s+\S/;
const SENTENCE = /[.!?]$/;
// A line with no code punctuation that ends like a sentence, or a capitalised
// heading ("Rules:") — the lines a prompt is made of.
const PROSE = /^\s*(?:[A-Z][^{}[\]()=;<>"`]*[.!?:]|[^{}[\]()=;<>"`]*[.!?])\s*$/;

/**
 * YAML has no keyword to anchor on, so it is claimed only when nearly every
 * line is a key or list item, none reads as a sentence, and at least one key
 * has an indented block under it — the shape a prose prompt with a "Rules:"
 * heading and bullets never takes.
 */
function looksLikeYaml(lines: string[]): boolean {
  const first = lines[0]?.trim();
  if (first === "---" && lines.filter((line) => YAML_KEY.test(line)).length * 2 >= lines.length) {
    return true;
  }
  let structural = 0;
  let nested = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (SENTENCE.test(line.trim())) return false;
    const isKey = YAML_KEY.test(line) && !line.trim().endsWith(";");
    if (isKey || YAML_LIST.test(line)) structural++;
    const next = lines[i + 1];
    if (isKey && next && indent(next) > indent(line)) nested = true;
  }
  return nested && structural * 10 >= lines.length * 9;
}

function indent(line: string): number {
  return line.length - line.trimStart().length;
}

function refineScript(language: SeedLanguage, lines: string[]): SeedLanguage {
  if (language !== "JavaScript") return language;
  const ts = lines.some((line) => TS_ONLY.some((re) => re.test(line)));
  const jsx = lines.some((line) => JSX_ONLY.some((re) => re.test(line)));
  if (ts) return jsx ? "TSX" : "TypeScript";
  return jsx ? "JSX" : "JavaScript";
}

/**
 * Names the language of `text`, or null when it does not read as code in a
 * language the editor can highlight. A shebang settles it outright; strict
 * JSON parses; everything else is scored line by line against each
 * language's signals and the best-supported language wins, provided its
 * signals cover a third of the lines.
 */
/** True when a third or more of the lines read like sentences or headings. */
function readsAsProse(lines: string[]): boolean {
  return lines.filter((line) => PROSE.test(line)).length * 3 >= lines.length;
}

export function detectLanguage(text: string): SeedLanguage | null {
  const lines = text.split("\n").filter((line) => line.trim());
  const first = lines[0];
  if (!first) return null;
  if (first.startsWith("#!")) {
    return SHEBANGS.find(([re]) => re.test(first))?.[1] ?? "Shell";
  }
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "JSON";
    } catch {
      // Not strict JSON; the line signals below still get a look.
    }
  }
  if (readsAsProse(lines)) return null;

  let best: { language: SeedLanguage; score: number } | null = null;
  for (const signal of SIGNALS) {
    if (signal.anchor && !lines.some((line) => signal.anchor?.test(line))) continue;
    const score = lines.filter((line) => signal.lines.some((re) => re.test(line))).length;
    if (score < signal.min || score * 3 < lines.length) continue;
    if (!best || score > best.score) best = { language: signal.language, score };
  }
  if (best) return refineScript(best.language, lines);
  return looksLikeYaml(lines) ? "YAML" : null;
}

// Lines that read as code in no particular language: keywords, block
// punctuation, assignments and quoted keys.
const CODE_LINE =
  /^\s*(?:import|from|def|class|return|if|elif|else|for|while|try|except|finally|with|async|await|yield|lambda|const|let|var|function|export|fn|pub|use|struct|impl|package|#include|@\w+)\b|[{}[\]]\s*,?\s*(?:#.*|\/\/.*)?$|^\s*[\w.[\]]+\s*(?:[-+*/]?=|:=)\s*\S|^\s*"[^"]*"\s*:/;

/**
 * Whether `text` reads as source code — in a known language, or in none the
 * editor can name but with enough code-shaped lines to deserve a gutter.
 */
export function looksLikeCode(text: string): boolean {
  if (detectLanguage(text) !== null) return true;
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length === 0 || readsAsProse(lines)) return false;
  const hits = lines.filter((line) => CODE_LINE.test(line) || STATEMENT.test(line)).length;
  return hits >= 3 && hits * 3 >= lines.length;
}
