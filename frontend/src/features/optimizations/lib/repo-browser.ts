/**
 * The file tree a repository version is browsed through: the pinned commit's
 * entries plus the files the version's patch adds, with each change marked.
 * Pure so the tree's shape and filtering are unit-tested.
 */

import type { RepositoryTreeEntry } from "@/shared/types/api";
import type { FilePatch } from "./repo-patch.ts";

export interface RepoNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children: RepoNode[];
  /** The patch entry that changes this file; for a renamed file's old path, the rename. */
  change: FilePatch | null;
  /** True for a path the version removes: deleted, or the old side of a rename. */
  removed: boolean;
  /** Changed files at or below this node. */
  changedCount: number;
}

export interface RepoRow {
  node: RepoNode;
  depth: number;
  expanded: boolean;
}

function sortChildren(node: RepoNode): void {
  node.children.sort((a, b) =>
    a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  node.children.forEach(sortChildren);
}

function countChanged(node: RepoNode): number {
  node.changedCount =
    node.type === "file"
      ? node.change || node.removed
        ? 1
        : 0
      : node.children.reduce((sum, child) => sum + countChanged(child), 0);
  return node.changedCount;
}

/** Build the tree of the commit's entries plus every path the patch touches. */
export function buildRepoTree(entries: RepositoryTreeEntry[], files: FilePatch[]): RepoNode {
  const root: RepoNode = {
    name: "",
    path: "",
    type: "dir",
    children: [],
    change: null,
    removed: false,
    changedCount: 0,
  };
  const byPath = new Map<string, RepoNode>([["", root]]);
  const ensure = (path: string, type: "file" | "dir"): RepoNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensure(slash === -1 ? "" : path.slice(0, slash), "dir");
    const node: RepoNode = {
      name: path.slice(slash + 1),
      path,
      type,
      children: [],
      change: null,
      removed: false,
      changedCount: 0,
    };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const entry of entries) {
    if (entry.path) ensure(entry.path, entry.type);
  }
  for (const file of files) {
    const node = ensure(file.path, "file");
    node.change = file;
    node.removed = file.status === "deleted";
    if (file.status === "renamed" && file.oldPath) {
      const old = ensure(file.oldPath, "file");
      if (!old.change) old.change = file;
      old.removed = true;
    }
  }
  sortChildren(root);
  countChanged(root);
  return root;
}

/** Folders that hold a change open by default; the rest stay collapsed. */
export function changedFolders(root: RepoNode): Set<string> {
  const open = new Set<string>();
  const walk = (node: RepoNode) => {
    if (node.type !== "dir" || node.changedCount === 0) return;
    if (node.path) open.add(node.path);
    node.children.forEach(walk);
  };
  walk(root);
  return open;
}

/** Whether a file exists in this version's tree, removed paths included. */
export function hasFile(root: RepoNode, path: string): boolean {
  let node: RepoNode | undefined = root;
  for (const part of path.split("/")) {
    node = node?.children.find((child) => child.name === part);
    if (!node) return false;
  }
  return node.type === "file";
}

/**
 * The rows a reader sees, in display order. With a filter, only files whose
 * path contains it (any case) and their folders show, every folder open.
 */
export function visibleRows(root: RepoNode, expanded: ReadonlySet<string>, filter: string): RepoRow[] {
  const needle = filter.trim().toLowerCase();
  const rows: RepoRow[] = [];
  const matches = new Map<RepoNode, boolean>();
  const matching = (node: RepoNode): boolean => {
    const cached = matches.get(node);
    if (cached !== undefined) return cached;
    const hit =
      node.type === "file"
        ? node.path.toLowerCase().includes(needle)
        : node.children.some(matching);
    matches.set(node, hit);
    return hit;
  };
  const walk = (node: RepoNode, depth: number) => {
    for (const child of node.children) {
      if (needle && !matching(child)) continue;
      const open = child.type === "dir" && (needle ? true : expanded.has(child.path));
      rows.push({ node: child, depth, expanded: open });
      if (open) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Every folder above a path, nearest the root first. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export type RepoFileKind = "markdown" | "html" | "python" | "json" | "code";

/** How a file's source is drawn, from its name. */
export function repoFileKind(path: string): RepoFileKind {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "py" || ext === "pyi") return "python";
  if (ext === "json") return "json";
  return "code";
}
