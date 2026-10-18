/**
 * REWARD.md import and export (SKY-84), in Unsloth Studio's file format.
 *
 * A REWARD.md is YAML frontmatter (`name`, `kind`, `description`) and a YAML
 * body that holds the rule. Only `kind: rule` fits the builder; a
 * `kind: python` reward belongs in the code editor. The reader covers the
 * YAML those files use: block mappings and sequences, flow `{...}` and
 * `[...]`, quoted and plain scalars, numbers, booleans and comments.
 */

import { ruleFrom } from "./reward-rules-code.ts";
import { NAME_PATTERN, type RewardEntry, type RewardRule } from "./reward-rules.ts";

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {}

interface Line {
  indent: number;
  text: string;
}

/** Strip a ` #` comment that is outside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === "'" && quote === "'" && text[i + 1] === "'") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      if (i === 0 || /[\s:[{,-]/.test(text[i - 1]!)) quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function toLines(source: string): Line[] {
  const out: Line[] = [];
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*\t/.test(raw)) throw new YamlError("tabs are not allowed for indentation");
    const text = stripComment(raw.trimStart());
    if (!text) continue;
    out.push({ indent: raw.length - raw.trimStart().length, text });
  }
  return out;
}

function resolvePlain(text: string): YamlValue {
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^(?:null|Null|NULL|~)$/.test(text)) return null;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
}

const DOUBLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", '"': '"', "/": "/" };

/** Parse one flow value from `text` at `start`. */
function flowValue(text: string, start: number, inFlow: boolean): { value: YamlValue; end: number } {
  let i = start;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  skip();
  const ch = text[i];
  if (ch === "{" || ch === "[") {
    const close = ch === "{" ? "}" : "]";
    i++;
    const map: Record<string, YamlValue> = {};
    const list: YamlValue[] = [];
    skip();
    while (text[i] !== close) {
      if (i >= text.length) throw new YamlError(`missing ${close}`);
      if (ch === "{") {
        const key = flowKey(text, i);
        i = key.end;
        skip();
        if (text[i] !== ":") throw new YamlError(`missing ':' after ${key.key}`);
        const item = flowValue(text, i + 1, true);
        map[key.key] = item.value;
        i = item.end;
      } else {
        const item = flowValue(text, i, true);
        list.push(item.value);
        i = item.end;
      }
      skip();
      if (text[i] === ",") {
        i++;
        skip();
      } else if (text[i] !== close) {
        throw new YamlError(`expected ',' or ${close}`);
      }
    }
    return { value: ch === "{" ? map : list, end: i + 1 };
  }
  if (ch === "'" || ch === '"') {
    const quoted = quotedString(text, i);
    return { value: quoted.value, end: quoted.end };
  }
  let end = i;
  while (end < text.length && !(inFlow && /[,\]}]/.test(text[end]!))) end++;
  return { value: resolvePlain(text.slice(i, end).trim()), end };
}

function quotedString(text: string, start: number): { value: string; end: number } {
  const quote = text[start];
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote === "'" && ch === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, end: i + 1 };
    }
    if (quote === '"' && ch === '"') return { value: out, end: i + 1 };
    if (quote === '"' && ch === "\\") {
      const next = text[i + 1] ?? "";
      const hex = /^u([0-9a-fA-F]{4})/.exec(text.slice(i + 1));
      if (hex) {
        out += String.fromCharCode(parseInt(hex[1]!, 16));
        i += 6;
        continue;
      }
      out += DOUBLE_ESCAPES[next] ?? next;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  throw new YamlError("an unclosed quote");
}

function flowKey(text: string, start: number): { key: string; end: number } {
  if (text[start] === "'" || text[start] === '"') {
    const quoted = quotedString(text, start);
    return { key: quoted.value, end: quoted.end };
  }
  let end = start;
  while (end < text.length && !/[:,{}[\]]/.test(text[end]!)) end++;
  return { key: text.slice(start, end).trim(), end };
}

function inline(text: string): YamlValue {
  const parsed = flowValue(text, 0, false);
  if (text.slice(parsed.end).trim()) throw new YamlError(`unexpected text: ${text.slice(parsed.end).trim()}`);
  return parsed.value;
}

/** Find a block mapping's `key: ` split, outside quotes; `null` when the line is no key. */
function splitKey(text: string): { key: string; rest: string } | null {
  if (text[0] === "'" || text[0] === '"') {
    const quoted = quotedString(text, 0);
    const after = text.slice(quoted.end);
    const m = /^\s*:(?:\s+|$)/.exec(after);
    return m ? { key: quoted.value, rest: after.slice(m[0].length) } : null;
  }
  if (text[0] === "{" || text[0] === "[") return null;
  const m = /:(?:\s+|$)/.exec(text);
  return m ? { key: text.slice(0, m.index).trim(), rest: text.slice(m.index + m[0].length) } : null;
}

const isItem = (line: Line | undefined) => !!line && (line.text === "-" || line.text.startsWith("- "));

function block(lines: Line[], i: number, indent: number): { value: YamlValue; next: number } {
  return isItem(lines[i]) ? sequence(lines, i, indent) : mapping(lines, i, indent);
}

function mapping(lines: Line[], i: number, indent: number): { value: YamlValue; next: number } {
  const map: Record<string, YamlValue> = {};
  while (i < lines.length && lines[i]!.indent === indent && !isItem(lines[i])) {
    const split = splitKey(lines[i]!.text);
    if (!split) throw new YamlError(`expected 'key: value' at: ${lines[i]!.text}`);
    if (split.key in map) throw new YamlError(`duplicate key ${split.key}`);
    const next = lines[i + 1];
    if (split.rest) {
      map[split.key] = inline(split.rest);
      i++;
    } else if (next && (next.indent > indent || (next.indent === indent && isItem(next)))) {
      const nested = block(lines, i + 1, next.indent);
      map[split.key] = nested.value;
      i = nested.next;
    } else {
      map[split.key] = null;
      i++;
    }
  }
  if (i < lines.length && lines[i]!.indent > indent) throw new YamlError(`bad indentation at: ${lines[i]!.text}`);
  return { value: map, next: i };
}

function sequence(lines: Line[], i: number, indent: number): { value: YamlValue; next: number } {
  const list: YamlValue[] = [];
  while (i < lines.length && lines[i]!.indent === indent && isItem(lines[i])) {
    const line = lines[i]!;
    const rest = line.text.slice(1).trimStart();
    if (!rest) {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const nested = block(lines, i + 1, next.indent);
        list.push(nested.value);
        i = nested.next;
      } else {
        list.push(null);
        i++;
      }
    } else if (splitKey(rest)) {
      const itemIndent = indent + (line.text.length - rest.length);
      const copy = [...lines];
      copy[i] = { indent: itemIndent, text: rest };
      const nested = mapping(copy, i, itemIndent);
      list.push(nested.value);
      i = nested.next;
    } else {
      list.push(inline(rest));
      i++;
    }
  }
  return { value: list, next: i };
}

/** Parse the YAML subset REWARD.md files use. */
export function parseYaml(source: string): YamlValue {
  const lines = toLines(source);
  if (lines.length === 0) return null;
  const first = lines[0]!;
  if (!isItem(first) && !splitKey(first.text)) return inline(first.text);
  const parsed = block(lines, 0, first.indent);
  if (parsed.next < lines.length) throw new YamlError(`unexpected text at: ${lines[parsed.next]!.text}`);
  return parsed.value;
}

const PLAIN_SAFE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** One value as flow YAML: plain identifiers, single-quoted text, `{}`/`[]`. */
export function yamlFlow(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    return PLAIN_SAFE.test(value) && typeof resolvePlain(value) === "string"
      ? value
      : `'${value.replace(/'/g, "''")}'`;
  }
  if (Array.isArray(value)) return `[${value.map(yamlFlow).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return `{${entries.map(([k, v]) => `${yamlFlow(k)}: ${yamlFlow(v)}`).join(", ")}}`;
}

/** A reward as a REWARD.md that Unsloth Studio and Skynet both import. */
export function rewardToMarkdown(entry: RewardEntry): string {
  const head = [
    "---",
    `name: ${yamlFlow(entry.name)}`,
    "kind: rule",
    ...(entry.description ? [`description: ${yamlFlow(entry.description)}`] : []),
    "---",
  ];
  const body = Object.entries(entry.rule)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) =>
      key === "bands" && Array.isArray(value)
        ? `bands:\n${value.map((band) => `  - ${yamlFlow(band)}`).join("\n")}`
        : `${key}: ${yamlFlow(value)}`,
    );
  return `${[...head, ...body].join("\n")}\n`;
}

export type RewardImportError =
  | "no_frontmatter"
  | "unclosed_frontmatter"
  | "bad_yaml"
  | "not_mapping"
  | "python_kind"
  | "unknown_kind"
  | "bad_name"
  | "bad_rule";

export type RewardImport =
  | { ok: true; entry: Omit<RewardEntry, "weight"> & { rule: RewardRule } }
  | { ok: false; error: RewardImportError; detail?: string };

const isMap = (v: unknown): v is Record<string, YamlValue> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read one REWARD.md into a reward; `compare_to` defaults to the run's expected field. */
export function rewardFromMarkdown(source: string, expectedField: string): RewardImport {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!/^---[ \t]*\n/.test(text)) return { ok: false, error: "no_frontmatter" };
  const close = /\n---[ \t]*(?:\n|$)/.exec(text.slice(3));
  if (!close) return { ok: false, error: "unclosed_frontmatter" };
  const head = text.slice(3, 3 + close.index);
  const body = text.slice(3 + close.index + close[0].length);
  let meta: YamlValue;
  let rule: YamlValue;
  try {
    meta = parseYaml(head);
    rule = parseYaml(body);
  } catch (error) {
    return { ok: false, error: "bad_yaml", detail: error instanceof Error ? error.message : undefined };
  }
  if (!isMap(meta) || !isMap(rule)) return { ok: false, error: "not_mapping" };
  const kind = meta.kind ?? "rule";
  if (kind === "python") return { ok: false, error: "python_kind" };
  if (kind !== "rule") return { ok: false, error: "unknown_kind", detail: String(kind) };
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  if (!NAME_PATTERN.test(name)) return { ok: false, error: "bad_name", detail: name };
  const parsed = ruleFrom(rule, expectedField);
  if (!parsed) return { ok: false, error: "bad_rule" };
  return {
    ok: true,
    entry: {
      name,
      description: typeof meta.description === "string" ? meta.description : "",
      source: "yours",
      rule: parsed,
    },
  };
}
