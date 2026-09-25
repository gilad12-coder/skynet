/** Value formatting shared by the dataset preview grid and its row reader. */

/** Render any cell value as a short, single-line string for the preview grid. */
export function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Render a value for the full-record reader: prose as-is, structures pretty-printed. */
export function readerText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Whether a cell holds an inline image, as remote previews send them. */
export function isImageDataUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}
