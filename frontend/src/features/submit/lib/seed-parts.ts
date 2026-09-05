/** Validate names before constructing a candidate object, which would collapse duplicates. */
export function seedPartsIssue(
  parts: ReadonlyArray<{ key: string; value: string }>,
): "missing_name" | "missing_content" | "duplicate_name" | null {
  const names = new Set<string>();
  for (const part of parts) {
    const name = part.key.trim();
    if (!name && !part.value.trim()) continue;
    if (!name) return "missing_name";
    if (!part.value.trim()) return "missing_content";
    if (names.has(name)) return "duplicate_name";
    names.add(name);
  }
  return null;
}

/** Give unnamed parts collision-free identifiers while retaining authored names. */
export function namedSeedParts(parts: ReadonlyArray<{ key: string; value: string }>) {
  const names = new Set(parts.map((part) => part.key.trim()).filter(Boolean));
  return parts.map((part, index) => {
    if (part.key.trim() || !part.value.trim()) return part;
    let number = index + 1;
    while (names.has(`part_${number}`)) number += 1;
    const key = `part_${number}`;
    names.add(key);
    return { ...part, key };
  });
}
