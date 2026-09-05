/** Remove comments and strings before looking for executable helper calls. */
function executablePython(code: string): string {
  return code.replace(
    /'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|#[^\n]*/g,
    " ",
  );
}

export function scorerCallsModel(code: string): boolean {
  const executable = executablePython(code);
  const aliases = [...executable.matchAll(/\bllm\s+as\s+(\w+)/g)].map((match) => match[1]);
  return ["llm", ...aliases].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(executable));
}

/** Make the runtime's legacy injected helpers explicit without moving future imports. */
export function withScorerImports(code: string): string {
  const executable = executablePython(code);
  const imports = [...executable.matchAll(/from\s+skynet\s+import\s+(\([^)]*\)|[^\n;]+)/g)]
    .map((match) => match[1])
    .join(",");
  const missing = ["llm", "Image"].filter(
    (name) =>
      new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(executable) &&
      !new RegExp(`\\b${name}\\b(?!\\s+as\\s)`).test(imports) &&
      !new RegExp(`\\b(?:def|class)\\s+${name}\\b|\\b${name}\\s*=`).test(executable),
  );
  if (!missing.length || imports.includes("*")) return code;
  const header =
    code.match(
      /^(?:(?:[ \t]*#[^\n]*|[ \t]*)\n)*(?:(?:"""[\s\S]*?"""|'''[\s\S]*?''')[ \t]*\n)?(?:(?:[ \t]*#[^\n]*|[ \t]*|from __future__ import (?:\([^)]*\)|[^\n]+))\n)*/,
    )?.[0] ?? "";
  return `${header}from skynet import ${missing.join(", ")}\n\n${code.slice(header.length)}`;
}
