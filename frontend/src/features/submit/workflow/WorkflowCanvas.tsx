"use client";

/**
 * The workflow canvas: an n8n-style node editor over the wizard's
 * `WorkflowSpec`.
 *
 * The spec is the single source of truth (owned by the wizard hook); React
 * Flow state is re-derived from it after every structural mutation. Pure
 * drag movement stays inside React Flow until drag-stop, when positions are
 * committed back onto the spec. External spec replacements (dataset init,
 * clone hydration, agent ops) bump `specRevision`, which remounts the flow
 * so stale internal state can't survive.
 *
 * Interaction model (mirrors n8n): scroll pans, Ctrl/⌘+scroll and pinch
 * zoom, left-drag box-selects, middle-drag or Space+drag pans. Nodes are
 * added from a context menu (pane right-click, the toolbar "Add node"
 * button, or dropping a half-made connection on empty canvas — the latter
 * auto-wires the new node). Fullscreen portals the whole editor onto
 * `document.body` so no transformed/filtered ancestor can trap it.
 *
 * The canvas itself is always LTR — data flows left→right — while inspector
 * chrome follows the page direction.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import {
  Background,
  ConnectionLineType,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  ChevronDown,
  Code2,
  Copy,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  Scan,
  Sparkles,
  Trash2,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/shared/ui/primitives/button";
import { cn } from "@/shared/lib/utils";
import { formatMsg, msg } from "@/shared/lib/messages";
import type { WorkflowDryRunResponse, WorkflowNodeSpec, WorkflowSpec } from "@/shared/types/api";

import {
  autoLayoutSpec,
  makeNodeId,
  nodePorts,
  newNodeSpec,
  validateWorkflowSpec,
  wouldCreateCycle,
  type WorkflowIssue,
} from "./model";
import { workflowIssueText } from "./issue-text";
import { NODE_TYPES, flowTypeFor, type CanvasNode, type NodeTraceState } from "./nodes";
import { NodeInspector } from "./NodeInspector";
import { DryRunDialog } from "./DryRunDialog";

export interface WorkflowDryRunBinding {
  /** Reason the dry-run button is disabled, or null when it can run. */
  disabledReason: string | null;
  /** Prefill values for the input anchor's fields (first dataset row). */
  sampleInputs: Record<string, string>;
  run: (inputs: Record<string, unknown>) => Promise<WorkflowDryRunResponse>;
}

interface WorkflowCanvasProps {
  spec: WorkflowSpec;
  specRevision: number;
  onSpecChange: (spec: WorkflowSpec) => void;
  dryRun?: WorkflowDryRunBinding;
  // Node the code agent just changed — pulsed briefly on the canvas.
  pulseNodeId?: string | null;
  className?: string;
}

const SNAP_GRID: [number, number] = [16, 16];
const FIT_VIEW = { padding: 0.2, maxZoom: 1 };
const EDGE_COLOR = "#8A7563";

const ADD_KINDS = [
  { kind: "signature", icon: Sparkles, labelKey: "workflow.toolbar.add_signature" },
  { kind: "transform", icon: Code2, labelKey: "workflow.toolbar.add_transform" },
  { kind: "mcp", icon: Wrench, labelKey: "workflow.toolbar.add_tool" },
] as const;

type MenuTarget = { type: "pane" } | { type: "node"; id: string } | { type: "edge"; id: string };

interface MenuState {
  // Position relative to the canvas root element (physical px).
  x: number;
  y: number;
  // Where an added node lands, in flow coordinates.
  flow: { x: number; y: number };
  target: MenuTarget;
  // Set when the menu opened from a connection dropped on empty canvas —
  // the added node gets auto-wired to this handle.
  pending: { nodeId: string; handleId: string; dir: "out" | "in" } | null;
}

const edgeId = (e: { source: string; source_port: string; target: string; target_port: string }) =>
  `${e.source}.${e.source_port}->${e.target}.${e.target_port}`;

function deriveNodes(
  spec: WorkflowSpec,
  issuesByNode: Map<string, string[]>,
  traces: Map<string, NodeTraceState>,
  prev: CanvasNode[],
  pulseNodeId: string | null,
): CanvasNode[] {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  return spec.nodes.map((node, index) => ({
    id: node.id,
    type: flowTypeFor(node),
    position: node.position ?? prevById.get(node.id)?.position ?? { x: 80 + index * 60, y: 80 },
    selected: prevById.get(node.id)?.selected ?? false,
    deletable: node.kind !== "input" && node.kind !== "output",
    data: {
      spec: node,
      issues: issuesByNode.get(node.id) ?? [],
      trace: traces.get(node.id) ?? null,
      pulse: node.id === pulseNodeId,
    },
  }));
}

function deriveEdges(spec: WorkflowSpec, prev: Edge[]): Edge[] {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  return spec.edges.map((e) => ({
    id: edgeId(e),
    source: e.source,
    sourceHandle: e.source_port,
    target: e.target,
    targetHandle: e.target_port,
    selected: prevById.get(edgeId(e))?.selected ?? false,
    style: { stroke: EDGE_COLOR, strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR, width: 16, height: 16 },
    interactionWidth: 40,
  }));
}

function CanvasInner({
  spec,
  onSpecChange,
  dryRun,
  pulseNodeId = null,
  className,
}: Omit<WorkflowCanvasProps, "specRevision">) {
  const { fitView, screenToFlowPosition } = useReactFlow();
  const [fullscreen, setFullscreen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [dryRunOpen, setDryRunOpen] = React.useState(false);
  const [dryRunResult, setDryRunResult] = React.useState<WorkflowDryRunResponse | null>(null);
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  // Minimap fades in while the viewport is moving and back out shortly after.
  const [navActive, setNavActive] = React.useState(false);
  const navTimerRef = React.useRef<number | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const flowWrapRef = React.useRef<HTMLDivElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const menuOpenRef = React.useRef(false);
  React.useEffect(() => {
    menuOpenRef.current = menu !== null;
  }, [menu]);

  const issues: WorkflowIssue[] = React.useMemo(
    () => validateWorkflowSpec(spec, workflowIssueText),
    [spec],
  );
  const issuesByNode = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const issue of issues) {
      if (!issue.nodeId) continue;
      map.set(issue.nodeId, [...(map.get(issue.nodeId) ?? []), issue.message]);
    }
    return map;
  }, [issues]);

  const traces = React.useMemo(() => {
    const map = new Map<string, NodeTraceState>();
    for (const trace of dryRunResult?.node_traces ?? []) {
      map.set(trace.node_id, {
        status: trace.error ? "error" : "ok",
        elapsedMs: trace.elapsed_ms,
        error: trace.error,
      });
    }
    return map;
  }, [dryRunResult]);

  const [nodes, setNodes] = React.useState<CanvasNode[]>(() =>
    deriveNodes(spec, issuesByNode, traces, [], pulseNodeId),
  );
  const [edges, setEdges] = React.useState<Edge[]>(() => deriveEdges(spec, []));

  React.useEffect(() => {
    setNodes((prev) => deriveNodes(spec, issuesByNode, traces, prev, pulseNodeId));
    setEdges((prev) => deriveEdges(spec, prev));
  }, [spec, issuesByNode, traces, pulseNodeId]);

  const specRef = React.useRef(spec);
  React.useEffect(() => {
    specRef.current = spec;
  }, [spec]);

  const onNodesChange = React.useCallback(
    (changes: Array<NodeChange<CanvasNode>>) => {
      const removals = new Set(
        changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id),
      );
      if (removals.size > 0) {
        const cur = specRef.current;
        onSpecChange({
          nodes: cur.nodes.filter(
            (n) => !removals.has(n.id) || n.kind === "input" || n.kind === "output",
          ),
          edges: cur.edges.filter((e) => !removals.has(e.source) && !removals.has(e.target)),
        });
        setSelectedId((id) => (id && removals.has(id) ? null : id));
      }
      setNodes((prev) => applyNodeChanges(changes, prev));
      const selected = changes.find((c) => c.type === "select" && c.selected);
      if (selected) setSelectedId((selected as { id: string }).id);
      const deselected = changes.filter((c) => c.type === "select" && !c.selected);
      if (deselected.length > 0) {
        setSelectedId((id) =>
          deselected.some((c) => (c as { id: string }).id === id) ? null : id,
        );
      }
    },
    [onSpecChange],
  );

  const onEdgesChange = React.useCallback(
    (changes: Array<EdgeChange<Edge>>) => {
      const removals = new Set(
        changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id),
      );
      if (removals.size > 0) {
        const cur = specRef.current;
        onSpecChange({
          ...cur,
          edges: cur.edges.filter((e) => !removals.has(edgeId(e))),
        });
      }
      setEdges((prev) => applyEdgeChanges(changes, prev));
    },
    [onSpecChange],
  );

  const isValidConnection: IsValidConnection<Edge> = React.useCallback((conn) => {
    if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return false;
    if (conn.source === conn.target) return false;
    const cur = specRef.current;
    const portTaken = cur.edges.some(
      (e) => e.target === conn.target && e.target_port === conn.targetHandle,
    );
    if (portTaken) return false;
    return !wouldCreateCycle(cur, conn.source, conn.target);
  }, []);

  const onConnect = React.useCallback(
    (conn: Connection) => {
      if (!conn.sourceHandle || !conn.targetHandle) return;
      const cur = specRef.current;
      onSpecChange({
        ...cur,
        edges: [
          ...cur.edges,
          {
            source: conn.source,
            source_port: conn.sourceHandle,
            target: conn.target,
            target_port: conn.targetHandle,
          },
        ],
      });
      setEdges((prev) => addEdge(conn, prev));
    },
    [onSpecChange],
  );

  // A connection dropped on empty canvas opens the add-node menu at the drop
  // point; the picked node is wired straight to the dangling handle (n8n's
  // drag-to-spawn gesture).
  const onConnectEnd = React.useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode || !state.fromHandle) return;
      const targetEl = event.target as Element | null;
      if (!targetEl?.closest(".react-flow__pane")) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      const root = rootRef.current;
      if (!root || !point) return;
      const rect = root.getBoundingClientRect();
      setMenu({
        x: Math.min(point.clientX - rect.left, rect.width - 200),
        y: Math.min(point.clientY - rect.top, rect.height - 170),
        flow: screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        target: { type: "pane" },
        pending: {
          nodeId: state.fromNode.id,
          handleId: state.fromHandle.id ?? "",
          dir: state.fromHandle.type === "source" ? "out" : "in",
        },
      });
    },
    [screenToFlowPosition],
  );

  const onNodeDragStop = React.useCallback(() => {
    setNodes((prev) => {
      const cur = specRef.current;
      onSpecChange({
        ...cur,
        nodes: cur.nodes.map((n) => {
          const flowNode = prev.find((fn) => fn.id === n.id);
          return flowNode
            ? { ...n, position: { x: flowNode.position.x, y: flowNode.position.y } }
            : n;
        }),
      });
      return prev;
    });
  }, [onSpecChange]);

  const addNodeAt = React.useCallback(
    (
      kind: "signature" | "transform" | "mcp",
      position: { x: number; y: number },
      pending: MenuState["pending"],
    ) => {
      const cur = specRef.current;
      const node = newNodeSpec(kind, cur, {
        x: Math.round(position.x / SNAP_GRID[0]) * SNAP_GRID[0],
        y: Math.round(position.y / SNAP_GRID[1]) * SNAP_GRID[1],
      });
      let nextEdges = cur.edges;
      if (pending) {
        const ports = nodePorts(node);
        if (pending.dir === "out") {
          const target = ports.inputs[0];
          if (target) {
            nextEdges = [
              ...nextEdges,
              {
                source: pending.nodeId,
                source_port: pending.handleId,
                target: node.id,
                target_port: target.name,
              },
            ];
          }
        } else {
          // Dragged backwards from an input handle — only wire it if that
          // port isn't already fed (single-producer rule).
          const source = ports.outputs[0];
          const fed = cur.edges.some(
            (e) => e.target === pending.nodeId && e.target_port === pending.handleId,
          );
          if (source && !fed) {
            nextEdges = [
              ...nextEdges,
              {
                source: node.id,
                source_port: source.name,
                target: pending.nodeId,
                target_port: pending.handleId,
              },
            ];
          }
        }
      }
      onSpecChange({ nodes: [...cur.nodes, node], edges: nextEdges });
      setSelectedId(node.id);
    },
    [onSpecChange],
  );

  const duplicateNode = React.useCallback(
    (id: string) => {
      const cur = specRef.current;
      const orig = cur.nodes.find((n) => n.id === id);
      if (!orig || orig.kind === "input" || orig.kind === "output") return;
      const prefix =
        orig.kind === "signature" ? "step" : orig.kind === "mcp" ? "tool" : "transform";
      const copy: WorkflowNodeSpec = JSON.parse(JSON.stringify(orig));
      copy.id = makeNodeId(prefix, cur);
      copy.position = {
        x: (orig.position?.x ?? 0) + 48,
        y: (orig.position?.y ?? 0) + 48,
      };
      onSpecChange({ ...cur, nodes: [...cur.nodes, copy] });
      setSelectedId(copy.id);
    },
    [onSpecChange],
  );

  const updateNode = React.useCallback(
    (next: WorkflowNodeSpec) => {
      const cur = specRef.current;
      onSpecChange({
        ...cur,
        nodes: cur.nodes.map((n) => (n.id === next.id ? next : n)),
      });
    },
    [onSpecChange],
  );

  const deleteNode = React.useCallback(
    (id: string) => {
      const cur = specRef.current;
      onSpecChange({
        nodes: cur.nodes.filter((n) => n.id !== id),
        edges: cur.edges.filter((e) => e.source !== id && e.target !== id),
      });
      setSelectedId(null);
    },
    [onSpecChange],
  );

  const deleteEdge = React.useCallback(
    (id: string) => {
      const cur = specRef.current;
      onSpecChange({ ...cur, edges: cur.edges.filter((e) => edgeId(e) !== id) });
    },
    [onSpecChange],
  );

  const tidyUp = React.useCallback(() => {
    onSpecChange(autoLayoutSpec(specRef.current));
    window.setTimeout(() => fitView({ ...FIT_VIEW, duration: 300 }), 50);
  }, [onSpecChange, fitView]);

  const openMenuAt = React.useCallback(
    (clientX: number, clientY: number, target: MenuTarget) => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      setMenu({
        x: Math.min(clientX - rect.left, rect.width - 200),
        y: Math.min(clientY - rect.top, rect.height - 170),
        flow: screenToFlowPosition({ x: clientX, y: clientY }),
        target,
        pending: null,
      });
    },
    [screenToFlowPosition],
  );

  const onPaneContextMenu = React.useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      openMenuAt(event.clientX, event.clientY, { type: "pane" });
    },
    [openMenuAt],
  );

  const onNodeContextMenu = React.useCallback(
    (event: React.MouseEvent, node: CanvasNode) => {
      event.preventDefault();
      const kind = node.data.spec.kind;
      if (kind === "input" || kind === "output") return;
      openMenuAt(event.clientX, event.clientY, { type: "node", id: node.id });
    },
    [openMenuAt],
  );

  const onEdgeContextMenu = React.useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      openMenuAt(event.clientX, event.clientY, { type: "edge", id: edge.id });
    },
    [openMenuAt],
  );

  const openAddMenuFromToolbar = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const root = rootRef.current;
      const flowEl = flowWrapRef.current;
      if (!root || !flowEl) return;
      const rootRect = root.getBoundingClientRect();
      const btnRect = event.currentTarget.getBoundingClientRect();
      const flowRect = flowEl.getBoundingClientRect();
      setMenu((prev) =>
        prev
          ? null
          : {
              x: btnRect.left - rootRect.left,
              y: btnRect.bottom - rootRect.top + 4,
              flow: screenToFlowPosition({
                x: flowRect.left + flowRect.width / 2,
                y: flowRect.top + flowRect.height / 2,
              }),
              target: { type: "pane" },
              pending: null,
            },
      );
    },
    [screenToFlowPosition],
  );

  const closeMenu = React.useCallback(() => setMenu(null), []);

  // Dismiss the menu on any pointer-down outside it (capture phase so canvas
  // interactions can't swallow the event first).
  React.useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = menuRef.current;
      if (el && e.target instanceof globalThis.Node && !el.contains(e.target)) setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menu]);

  // ESC closes the menu first, then exits fullscreen — like a modal stack.
  React.useEffect(() => {
    if (!menu && !fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (menuOpenRef.current) setMenu(null);
      else setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, fullscreen]);

  // Lock page scroll while the fullscreen overlay is open (portal pattern
  // shared with the trajectory tree).
  React.useEffect(() => {
    if (!fullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  // Re-fit after the portal moves the canvas between containers.
  React.useEffect(() => {
    const t = window.setTimeout(() => fitView({ ...FIT_VIEW, duration: 200 }), 80);
    return () => window.clearTimeout(t);
  }, [fullscreen, fitView]);

  const handleMoveStart = React.useCallback(() => {
    if (navTimerRef.current) window.clearTimeout(navTimerRef.current);
    setNavActive(true);
    setMenu(null);
  }, []);
  const handleMoveEnd = React.useCallback(() => {
    if (navTimerRef.current) window.clearTimeout(navTimerRef.current);
    navTimerRef.current = window.setTimeout(() => setNavActive(false), 1000);
  }, []);

  const selectedNode = spec.nodes.find((n) => n.id === selectedId) ?? null;
  const inputAnchor = spec.nodes.find((n) => n.kind === "input");
  const inputFieldNames = inputAnchor ? nodePorts(inputAnchor).outputs.map((p) => p.name) : [];

  const menuNode = menu?.target.type === "node" ? menu.target.id : null;
  const menuEdge = menu?.target.type === "edge" ? menu.target.id : null;

  const body = (
    <div
      ref={rootRef}
      className={cn(
        fullscreen
          ? "fixed inset-0 z-50 flex h-screen w-screen flex-col bg-background"
          : "relative flex flex-col",
        className,
      )}
      data-tutorial="workflow-canvas"
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 bg-[#FAF8F5] px-3 py-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={openAddMenuFromToolbar}
        >
          <Plus className="size-3.5" />
          {msg("workflow.toolbar.add_node")}
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
        <ToolbarButton icon={LayoutGrid} label={msg("workflow.toolbar.tidy")} onClick={tidyUp} />
        <span className="ms-auto" />
        {issues.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[#A3512B]">
            <AlertTriangle className="size-3" />
            {formatMsg("workflow.toolbar.issues", { p1: issues.length })}
          </span>
        )}
        {dryRun && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            disabled={issues.length > 0 || !!dryRun.disabledReason}
            title={dryRun.disabledReason ?? undefined}
            onClick={() => setDryRunOpen(true)}
          >
            <Play className="size-3" />
            {msg("workflow.toolbar.dry_run")}
          </Button>
        )}
        <ToolbarButton
          icon={fullscreen ? Minimize2 : Maximize2}
          label={msg(
            fullscreen ? "workflow.toolbar.exit_fullscreen" : "workflow.toolbar.fullscreen",
          )}
          onClick={() => setFullscreen((f) => !f)}
          iconOnly
        />
      </div>

      <div
        className={cn(
          "grid min-h-0 flex-1",
          selectedNode
            ? fullscreen
              ? "grid-cols-[minmax(0,1fr)_360px]"
              : "grid-cols-[minmax(0,1fr)_320px]"
            : "grid-cols-1",
        )}
      >
        <div
          dir="ltr"
          ref={flowWrapRef}
          className={cn("relative", fullscreen ? "min-h-0" : "h-[480px]")}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onNodeDragStop={onNodeDragStop}
            isValidConnection={isValidConnection}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            onPaneClick={closeMenu}
            onMoveStart={handleMoveStart}
            onMoveEnd={handleMoveEnd}
            minZoom={0.1}
            maxZoom={3}
            panOnScroll
            zoomOnScroll={false}
            panOnDrag={[1]}
            selectionOnDrag
            snapToGrid
            snapGrid={SNAP_GRID}
            connectionRadius={60}
            connectionLineType={ConnectionLineType.Bezier}
            connectionLineStyle={{ stroke: EDGE_COLOR, strokeWidth: 2 }}
            fitView
            fitViewOptions={FIT_VIEW}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={["Backspace", "Delete"]}
            className="bg-[#FDFCFA]"
          >
            <Background gap={16} size={1.25} color="#E3D9CB" />
            <ZoomControls />
            <Panel position="bottom-center" className="pointer-events-none !m-3">
              <span
                dir="auto"
                className="whitespace-nowrap rounded-full border border-border/50 bg-background/80 px-3 py-1 text-[0.6875rem] text-muted-foreground/80 shadow-xs backdrop-blur"
              >
                {msg("workflow.canvas.hint")}
              </span>
            </Panel>
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeColor={(n) =>
                n.type === "input_anchor" || n.type === "output_anchor" ? "#C8A882" : "#DDD2C2"
              }
              nodeStrokeColor="#B9A78F"
              nodeBorderRadius={10}
              maskColor="rgba(61, 46, 34, 0.06)"
              bgColor="#FAF8F5"
              className={cn(
                "!m-3 overflow-hidden rounded-lg border border-border/60 shadow-sm transition-opacity duration-300",
                navActive ? "opacity-100" : "pointer-events-none opacity-0",
              )}
            />
          </ReactFlow>
        </div>
        {selectedNode && (
          <div className="min-h-0 overflow-hidden border-s border-border/40">
            <NodeInspector
              spec={selectedNode}
              issues={issuesByNode.get(selectedNode.id) ?? []}
              onChange={updateNode}
              onDelete={
                selectedNode.kind !== "input" && selectedNode.kind !== "output"
                  ? () => deleteNode(selectedNode.id)
                  : undefined
              }
            />
          </div>
        )}
      </div>

      {dryRunResult && (
        <DryRunResultBar result={dryRunResult} onDismiss={() => setDryRunResult(null)} />
      )}

      {dryRun && (
        <DryRunDialog
          open={dryRunOpen}
          onOpenChange={setDryRunOpen}
          inputFields={inputFieldNames}
          sampleInputs={dryRun.sampleInputs}
          run={dryRun.run}
          onResult={setDryRunResult}
        />
      )}

      {menu && (
        <div
          ref={menuRef}
          className="absolute z-30 min-w-44 rounded-lg border border-border/70 bg-popover p-1 text-popover-foreground shadow-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.target.type === "pane" && (
            <>
              {ADD_KINDS.map(({ kind, icon, labelKey }) => (
                <MenuItem
                  key={kind}
                  icon={icon}
                  label={msg(labelKey)}
                  onClick={() => {
                    addNodeAt(kind, menu.flow, menu.pending);
                    setMenu(null);
                  }}
                />
              ))}
              {!menu.pending && (
                <>
                  <div className="mx-1 my-1 h-px bg-border/70" />
                  <MenuItem
                    icon={LayoutGrid}
                    label={msg("workflow.toolbar.tidy")}
                    onClick={() => {
                      tidyUp();
                      setMenu(null);
                    }}
                  />
                  <MenuItem
                    icon={Scan}
                    label={msg("workflow.controls.fit")}
                    onClick={() => {
                      void fitView({ ...FIT_VIEW, duration: 300 });
                      setMenu(null);
                    }}
                  />
                </>
              )}
            </>
          )}
          {menuNode && (
            <>
              <MenuItem
                icon={Copy}
                label={msg("workflow.menu.duplicate")}
                onClick={() => {
                  duplicateNode(menuNode);
                  setMenu(null);
                }}
              />
              <div className="mx-1 my-1 h-px bg-border/70" />
              <MenuItem
                icon={Trash2}
                label={msg("workflow.menu.delete")}
                danger
                onClick={() => {
                  deleteNode(menuNode);
                  setMenu(null);
                }}
              />
            </>
          )}
          {menuEdge && (
            <MenuItem
              icon={Trash2}
              label={msg("workflow.menu.delete_edge")}
              danger
              onClick={() => {
                deleteEdge(menuEdge);
                setMenu(null);
              }}
            />
          )}
        </div>
      )}
    </div>
  );

  if (!fullscreen) return body;
  return (
    <>
      {/* Placeholder keeps the wizard card's height while the editor lives
          in the portal, so the page doesn't collapse behind the overlay. */}
      <div className="h-[521px] bg-muted/20" aria-hidden />
      {createPortal(body, document.body)}
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors",
        danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-muted",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span dir="auto">{label}</span>
    </button>
  );
}

function ZoomControls() {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  return (
    <Panel position="bottom-left" className="!m-3">
      <div className="flex items-center overflow-hidden rounded-lg border border-border/60 bg-background/95 shadow-sm backdrop-blur">
        <ControlButton
          icon={ZoomOut}
          label={msg("workflow.controls.zoom_out")}
          onClick={() => zoomOut({ duration: 150 })}
        />
        <button
          type="button"
          onClick={() => zoomTo(1, { duration: 200 })}
          title={msg("workflow.controls.zoom_reset")}
          className="h-7 min-w-12 cursor-pointer px-1 text-center text-[0.6875rem] font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground"
        >
          {Math.round(zoom * 100)}%
        </button>
        <ControlButton
          icon={ZoomIn}
          label={msg("workflow.controls.zoom_in")}
          onClick={() => zoomIn({ duration: 150 })}
        />
        <div className="h-4 w-px bg-border/70" />
        <ControlButton
          icon={Scan}
          label={msg("workflow.controls.fit")}
          onClick={() => fitView({ ...FIT_VIEW, duration: 300 })}
        />
      </div>
    </Panel>
  );
}

function ControlButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  iconOnly = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  iconOnly?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
      onClick={onClick}
      title={iconOnly ? label : undefined}
      aria-label={label}
    >
      <Icon className="size-3.5" />
      {!iconOnly && label}
    </Button>
  );
}

function DryRunResultBar({
  result,
  onDismiss,
}: {
  result: WorkflowDryRunResponse;
  onDismiss: () => void;
}) {
  const failed = !!result.error;
  return (
    <div
      className={cn(
        "flex items-start gap-3 border-t px-4 py-2.5 text-xs",
        failed ? "border-destructive/30 bg-[#FBF0EC]" : "border-border/40 bg-[#F5F8F1]",
      )}
    >
      <span className={cn("mt-0.5 font-semibold", failed ? "text-destructive" : "text-[#5A7247]")}>
        {failed ? msg("workflow.dryrun.failed") : msg("workflow.dryrun.succeeded")}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        {failed ? (
          <span className="break-words text-muted-foreground" dir="ltr">
            {result.error}
          </span>
        ) : (
          Object.entries(result.outputs ?? {}).map(([key, value]) => (
            <div key={key} className="truncate text-muted-foreground" dir="ltr">
              <span className="font-mono font-medium text-foreground">{key}</span>
              {": "}
              {String(value)}
            </div>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={msg("workflow.dryrun.dismiss")}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function WorkflowCanvas({ specRevision, ...props }: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider key={specRevision}>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
