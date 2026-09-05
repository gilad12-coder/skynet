/**
 * Parsing for the spending-limit field. The server accepts whole credits of at
 * least one, so anything else is reported as a specific problem instead of
 * being reshaped into a number the user never typed: "120.50" must not become
 * 12050 and "-120" must not become 120. Group separators, whitespace and any
 * script's digits are accepted the way the active locale writes them.
 */

export type BudgetInputResult =
  | { kind: "empty" }
  | { kind: "value"; value: number }
  | { kind: "invalid" }
  | { kind: "fraction" }
  | { kind: "below_one" };

interface NumberSymbols {
  group: string[];
  decimal: string;
}

const symbolCache = new Map<string, NumberSymbols>();
const ARABIC_GROUP = "\u066c";
const ARABIC_DECIMAL = "\u066b";

/**
 * The group and decimal separators the locale writes, plus the apostrophe and
 * the Arabic-script separators that keyboards produce whatever the locale's
 * own formatting says.
 */
function numberSymbols(locale: string): NumberSymbols {
  const cached = symbolCache.get(locale);
  if (cached) return cached;
  let parts: Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
  } catch {
    parts = new Intl.NumberFormat("en").formatToParts(1234567.5);
  }
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  const group = new Set(parts.filter((part) => part.type === "group").map((part) => part.value));
  group.add("'");
  group.add(ARABIC_GROUP);
  group.delete(decimal);
  const symbols = { group: [...group], decimal };
  symbolCache.set(locale, symbols);
  return symbols;
}

const ANY_DIGIT = /\p{Nd}/gu;
const IS_DIGIT = /^\p{Nd}$/u;
const BIDI_CONTROLS = /[​‎‏؜⁦-⁩]/g;
const LEADING_SIGN = /^[-+−‒–]/;
const LEADING_MINUS = /^[-−‒–]/;

/** Map a digit from any script to ASCII: Unicode lays every digit set out as a run of ten from zero. */
function asciiDigit(digit: string): string {
  const code = digit.codePointAt(0) ?? 0;
  let zero = code;
  while (zero > 0 && IS_DIGIT.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return String((code - zero) % 10);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseBudgetInput(text: string, locale: string): BudgetInputResult {
  const { group, decimal } = numberSymbols(locale);
  let rest = text.replace(BIDI_CONTROLS, "").replace(ANY_DIGIT, asciiDigit).replace(/\s/g, "");
  if (!rest) return { kind: "empty" };
  const negative = LEADING_MINUS.test(rest);
  rest = rest.replace(LEADING_SIGN, "");
  // A separator only groups when it sits before a full group of three digits
  // (or two, in lakh grouping); "1.5" in German is a decimal, not 15.
  for (const separator of group) {
    const escaped = escapeRegExp(separator);
    rest = rest.replace(new RegExp(`${escaped}(?=\\d{3}(?!\\d)|\\d{2}${escaped})`, "g"), "");
  }
  const [whole = "", fraction, ...more] = rest.replace(ARABIC_DECIMAL, decimal).split(decimal);
  if (more.length > 0 || !/^\d+$/.test(whole) || (fraction != null && !/^\d*$/.test(fraction))) {
    return { kind: "invalid" };
  }
  if (fraction && /[1-9]/.test(fraction)) return { kind: "fraction" };
  const value = Number(whole);
  if (negative || value < 1) return { kind: "below_one" };
  if (!Number.isSafeInteger(value)) return { kind: "invalid" };
  return { kind: "value", value };
}
