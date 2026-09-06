/** Round displayed credit decimals to whole credits without changing the ledger value. */
export function formatBudgetAmount(value: string, locale: string): string {
  const negative = value.startsWith("-");
  const [integer = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const rounded = BigInt(integer) + ((fraction[0] ?? "0") >= "5" ? 1n : 0n);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    negative ? -rounded : rounded,
  );
}
