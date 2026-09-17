/**
 * Parsing for the spending-limit field. The field is typed in dollars — the
 * user writes "3" for $3.00 or "1.20" for $1.20 — and the server bills in
 * credits, one credit to the cent, so a parsed amount is returned as whole
 * credits (dollars × 100). Because a credit is a whole cent, "1.205" is finer
 * than the wallet can hold and is reported as a specific problem rather than
 * being rounded into a number the user never typed; "-1" is likewise reported
 * rather than flipped to 1. Group separators, whitespace and any script's
 * digits are accepted the way the active locale writes them.
 *
 * This module is imported by a `node --test` suite that cannot resolve `@/`
 * aliases, so it stays import-free. `CENTS_PER_DOLLAR` is the inverse of
 * billing's `CREDIT_USD_VALUE` (0.01): one dollar is a hundred credits.
 */

const CENTS_PER_DOLLAR = 100;

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
const ARABIC_GROUP = "٬";
const ARABIC_DECIMAL = "٫";

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
  // The dollar amount carries at most two decimals — a whole number of cents.
  // A third decimal digit asks for a fraction of a credit the wallet cannot hold.
  if (fraction != null && fraction.length > 2) return { kind: "fraction" };
  const dollars = Number(whole);
  const cents = fraction ? Number(fraction.padEnd(2, "0")) : 0;
  const value = dollars * CENTS_PER_DOLLAR + cents;
  if (negative || value < 1) return { kind: "below_one" };
  if (!Number.isSafeInteger(value)) return { kind: "invalid" };
  return { kind: "value", value };
}

/**
 * Render a stored credit amount as the dollar text the spending-limit field
 * shows: `250` → "2.50", `1000` → "10", `10` → "0.10", `1` → "0.01". Cents are
 * dropped when zero and always padded to two digits otherwise, and the locale's
 * decimal separator is used so the text round-trips back through
 * `parseBudgetInput` in the same locale. Digits stay ASCII (universally typed
 * and normalised on the way in) and grouping is omitted, as an input field wants.
 */
export function creditsToBudgetText(credits: number, locale: string): string {
  const whole = Math.floor(credits / CENTS_PER_DOLLAR);
  const cents = credits % CENTS_PER_DOLLAR;
  if (cents === 0) return String(whole);
  const { decimal } = numberSymbols(locale);
  return `${whole}${decimal}${String(cents).padStart(2, "0")}`;
}
