/**
 * The repository file tree behind the editable-paths picker: built from the
 * flat listing GitHub returns, with folder selection meaning the whole folder.
 * Selections are the wizard's editable paths, where "." is the whole repository.
 */

export const WHOLE_REPOSITORY = ".";

export interface RepoTreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children: RepoTreeNode[];
}

export type CheckState = "checked" | "mixed" | "unchecked";

/** Nest a flat ``path``/``type`` listing into folders first, then files, each sorted by name. */
export function buildRepoTree(
  entries: ReadonlyArray<{ path: string; type: "file" | "dir" }>,
): RepoTreeNode[] {
  const root: RepoTreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, RepoTreeNode>([["", root]]);

  const dirAt = (path: string): RepoTreeNode => {
    const known = dirs.get(path);
    if (known) return known;
    const cut = path.lastIndexOf("/");
    const parent = dirAt(cut < 0 ? "" : path.slice(0, cut));
    const node: RepoTreeNode = { name: path.slice(cut + 1), path, type: "dir", children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };

  for (const entry of entries) {
    if (!entry.path) continue;
    if (entry.type === "dir") {
      dirAt(entry.path);
      continue;
    }
    const cut = entry.path.lastIndexOf("/");
    dirAt(cut < 0 ? "" : entry.path.slice(0, cut)).children.push({
      name: entry.path.slice(cut + 1),
      path: entry.path,
      type: "file",
      children: [],
    });
  }

  const sort = (nodes: RepoTreeNode[]) => {
    nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    for (const node of nodes) sort(node.children);
  };
  sort(root.children);
  return root.children;
}

/** Whether ``path`` sits inside the folder ``dir`` (or is it). */
function within(path: string, dir: string): boolean {
  return dir === WHOLE_REPOSITORY || path === dir || path.startsWith(`${dir}/`);
}

/** How a node's checkbox reads: covered by itself or a folder above it, partly covered below, or not at all. */
export function checkState(node: RepoTreeNode, selected: readonly string[]): CheckState {
  if (selected.some((path) => within(node.path, path))) return "checked";
  if (node.type === "dir" && selected.some((path) => path.startsWith(`${node.path}/`)))
    return "mixed";
  return "unchecked";
}

/**
 * Check or uncheck one node. Checking replaces whatever it covers below;
 * unchecking a node covered by a folder above swaps that folder for the
 * siblings along the way, so everything else the folder covered stays chosen.
 */
export function togglePath(
  selected: readonly string[],
  node: RepoTreeNode,
  roots: readonly RepoTreeNode[],
): string[] {
  if (checkState(node, selected) !== "checked") {
    return [...selected.filter((path) => !within(path, node.path)), node.path];
  }
  if (selected.includes(node.path)) return selected.filter((path) => path !== node.path);

  const cover = selected.find((path) => within(node.path, path))!;
  const kept = selected.filter((path) => path !== cover);
  let level: readonly RepoTreeNode[] =
    cover === WHOLE_REPOSITORY ? roots : (findNode(roots, cover)?.children ?? []);
  while (level.length) {
    const next = level.find((child) => within(node.path, child.path));
    for (const child of level) if (child !== next) kept.push(child.path);
    if (!next || next.path === node.path) break;
    level = next.children;
  }
  return kept;
}

/** Find the node at ``path``, or undefined when the tree has none. */
export function findNode(nodes: readonly RepoTreeNode[], path: string): RepoTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.type === "dir" && path.startsWith(`${node.path}/`))
      return findNode(node.children, path);
  }
  return undefined;
}

/** Folders that hold a selection below them, opened so the selection is visible. */
export function foldersToReveal(selected: readonly string[]): string[] {
  const open = new Set<string>();
  for (const path of selected) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join("/"));
  }
  return [...open];
}
