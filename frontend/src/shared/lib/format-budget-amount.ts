/** Localize exact server credit decimals without rounding them through a floating point number. */
export function formatBudgetAmount(value: string, locale: string): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const whole = formatter.format(BigInt(integer));
  const significant = fraction.replace(/0+$/, "");
  if (!significant) return whole;
  const decimal =
    new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")
      ?.value ?? ".";
  return (
    whole + decimal + [...significant].map((digit) => formatter.format(Number(digit))).join("")
  );
}
