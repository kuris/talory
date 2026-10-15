import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Mindmap, MindmapNode } from "@talorys/shared";
import { ArrowLeft, ChevronDown, ChevronRight, Maximize, Network, Plus, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { Button, Card, ConfirmDialog, EmptyState, ErrorNotice, Spinner } from "../components/ui";
import { keys, useApiMutation, useMindmap, useMindmaps } from "../hooks/queries";
import { api } from "../lib/api";
import { computeMindmapLayout, MINDMAP_LAYOUT_STYLES, type MindmapLayoutStyle } from "../lib/mindmapLayout";
import { cn, relativeTime } from "../lib/utils";

const isLayoutStyle = (v: string | null): v is MindmapLayoutStyle => v === "tree" || v === "radial" || v === "fishbone" || v === "free";

export default function MindmapPage() {
  const { mapId } = useParams();
  if (mapId) return <MindmapEditor id={mapId} />;
  return <MindmapList />;
}

function MindmapList() {
  const navigate = useNavigate();
  const { data: mindmaps, isLoading, error, refetch } = useMindmaps();
  const [deleting, setDeleting] = useState<Mindmap | null>(null);

  const create = useApiMutation(() => api<{ mindmap: Mindmap }>("/mindmaps", { method: "POST", body: {} }), {
    invalidate: [keys.mindmaps],
    onSuccess: (r) => navigate(`/mindmap/${r.mindmap.id}`),
  });
  const remove = useApiMutation((id: string) => api(`/mindmaps/${id}`, { method: "DELETE" }), {
    invalidate: [keys.mindmaps],
    success: "Mind map deleted",
    onSuccess: () => setDeleting(null),
  });

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Mind Maps</h1>
        <Button size="sm" onClick={() => create.mutate(undefined)} loading={create.isPending}>
          <Plus className="h-4 w-4" /> New
        </Button>
      </div>
      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !mindmaps?.length ? (
        <EmptyState icon={<Network className="h-9 w-9" />} title="No mind maps yet">
          Brainstorm and structure ideas visually. Create one with the button above.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {mindmaps.map((m) => (
            <Card key={m.id} className="group relative flex flex-col gap-1 p-4 transition-colors hover:bg-subtle">
              <button type="button" onClick={() => navigate(`/mindmap/${m.id}`)} className="text-left">
                <p className="truncate pr-6 text-sm font-medium">{m.title}</p>
                <p className="mt-1 text-xs text-fg-subtle">
                  {relativeTime(m.updated_at)} · {m.node_count ?? 0} {m.node_count === 1 ? "node" : "nodes"}
                </p>
              </button>
              <button
                type="button"
                onClick={() => setDeleting(m)}
                aria-label={`Delete ${m.title}`}
                className="absolute right-3 top-3 hidden rounded-md p-1 text-fg-subtle hover:bg-muted hover:text-danger group-hover:block"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Card>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete mind map?"
        message={`“${deleting?.title}” and all of its nodes will be permanently deleted.`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </div>
  );
}

function MindmapEditor({ id }: { id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useMindmap(id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteMap, setConfirmDeleteMap] = useState(false);
  const [confirmDeleteNode, setConfirmDeleteNode] = useState<MindmapNode | null>(null);
  const [layoutStyle, setLayoutStyle] = useState<MindmapLayoutStyle>(() => {
    const saved = window.localStorage.getItem(`mindmap-layout:${id}`);
    return isLayoutStyle(saved) ? saved : "tree";
  });
  useEffect(() => {
    window.localStorage.setItem(`mindmap-layout:${id}`, layoutStyle);
  }, [id, layoutStyle]);

  const patchCache = (node: MindmapNode) => {
    qc.setQueryData(keys.mindmap(id), (old: { mindmap: Mindmap; nodes: MindmapNode[] } | undefined) =>
      old ? { mindmap: old.mindmap, nodes: old.nodes.map((n) => (n.id === node.id ? node : n)) } : old,
    );
  };

  const addNode = useApiMutation(
    (v: { parent_id: string; text: string; x?: number; y?: number }) => api<{ node: MindmapNode }>(`/mindmaps/${id}/nodes`, { method: "POST", body: v }),
    {
      invalidate: [keys.mindmap(id)],
      onSuccess: (r) => {
        setSelectedId(r.node.id);
        setEditingId(r.node.id);
      },
    },
  );
  const patchNode = useApiMutation(
    (v: { nodeId: string; patch: Partial<{ text: string; x: number; y: number; parent_id: string }> }) =>
      api<{ node: MindmapNode }>(`/mindmaps/${id}/nodes/${v.nodeId}`, { method: "PATCH", body: v.patch }),
    {
      onSuccess: (r) => {
        patchCache(r.node);
        void qc.invalidateQueries({ queryKey: keys.mindmaps });
      },
    },
  );
  const removeNode = useApiMutation((nodeId: string) => api(`/mindmaps/${id}/nodes/${nodeId}`, { method: "DELETE" }), {
    invalidate: [keys.mindmap(id)],
    onSuccess: () => {
      setSelectedId(null);
      setEditingId(null);
      setConfirmDeleteNode(null);
    },
  });
  const removeMap = useApiMutation(() => api(`/mindmaps/${id}`, { method: "DELETE" }), {
    invalidate: [keys.mindmaps],
    success: "Mind map deleted",
    onSuccess: () => navigate("/mindmap"),
  });

  if (error) return <div className="p-6"><ErrorNotice error={error} onRetry={() => void refetch()} /></div>;
  if (isLoading || !data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  const { mindmap, nodes } = data;
  const root = nodes.find((n) => n.parent_id === null);

  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col md:min-h-full">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => navigate("/mindmap")} aria-label="Back to mind maps">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <p className="truncate text-sm font-medium">{mindmap.title}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setConfirmDeleteMap(true)} aria-label="Delete mind map">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {!root ? (
        <div className="p-6">
          <ErrorNotice error={new Error("This mind map has no central node.")} />
        </div>
      ) : (
        <>
          <div className="hidden min-h-0 flex-1 md:block">
            <MindmapCanvas
              nodes={nodes}
              selectedId={selectedId}
              editingId={editingId}
              layoutStyle={layoutStyle}
              onLayoutStyleChange={setLayoutStyle}
              onSelect={setSelectedId}
              onEdit={setEditingId}
              onAddChild={(parentId) => addNode.mutate({ parent_id: parentId, text: "New idea" })}
              onCommitText={(nodeId, text) => {
                setEditingId(null);
                patchNode.mutate({ nodeId, patch: { text } });
              }}
              onMove={(nodeId, x, y) => patchNode.mutate({ nodeId, patch: { x, y } })}
              onRequestDelete={(node) => setConfirmDeleteNode(node)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2 md:hidden">
            <MindmapOutline
              root={root}
              nodes={nodes}
              editingId={editingId}
              onEdit={setEditingId}
              onAddChild={(parentId) => addNode.mutate({ parent_id: parentId, text: "New idea" })}
              onCommitText={(nodeId, text) => {
                setEditingId(null);
                patchNode.mutate({ nodeId, patch: { text } });
              }}
              onRequestDelete={(node) => setConfirmDeleteNode(node)}
            />
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmDeleteMap}
        title="Delete mind map?"
        message={`“${mindmap.title}” and all of its nodes will be permanently deleted.`}
        onCancel={() => setConfirmDeleteMap(false)}
        onConfirm={() => removeMap.mutate(undefined)}
        loading={removeMap.isPending}
      />
      <ConfirmDialog
        open={!!confirmDeleteNode}
        title="Delete node?"
        message={`“${confirmDeleteNode?.text}” and everything under it will be permanently deleted.`}
        onCancel={() => setConfirmDeleteNode(null)}
        onConfirm={() => confirmDeleteNode && removeNode.mutate(confirmDeleteNode.id)}
        loading={removeNode.isPending}
      />
    </div>
  );
}

// ---------- Desktop: free-form canvas ----------

type DragState =
  | { type: "pan"; startClientX: number; startClientY: number; startViewX: number; startViewY: number }
  | { type: "node"; id: string; startClientX: number; startClientY: number; startX: number; startY: number; moved: boolean };

function MindmapCanvas({
  nodes,
  selectedId,
  editingId,
  layoutStyle,
  onLayoutStyleChange,
  onSelect,
  onEdit,
  onAddChild,
  onCommitText,
  onMove,
  onRequestDelete,
}: {
  nodes: MindmapNode[];
  selectedId: string | null;
  editingId: string | null;
  layoutStyle: MindmapLayoutStyle;
  onLayoutStyleChange: (style: MindmapLayoutStyle) => void;
  onSelect: (id: string | null) => void;
  onEdit: (id: string | null) => void;
  onAddChild: (parentId: string) => void;
  onCommitText: (nodeId: string, text: string) => void;
  onMove: (nodeId: string, x: number, y: number) => void;
  onRequestDelete: (node: MindmapNode) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [localPos, setLocalPos] = useState<Record<string, { x: number; y: number }>>({});
  // Nodes the owner has manually dragged this session, in any layout style. These win over the
  // auto-computed position until the style changes (a different style's coordinates aren't
  // meaningful) or the page reloads.
  const [pinned, setPinned] = useState<Record<string, { x: number; y: number }>>({});
  // While a node is actively being dragged, its position must track the pointer exactly —
  // animating it would make it lag behind the cursor.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const isFree = layoutStyle === "free";
  // Auto layouts (tree/radial/fishbone) always recompute positions from the tree structure, so
  // branches can never land on top of each other regardless of what x,y happen to be stored.
  const autoPos = useMemo(() => (isFree ? null : computeMindmapLayout(nodes, layoutStyle)), [nodes, layoutStyle, isFree]);
  useEffect(() => setPinned({}), [layoutStyle]);

  // Drop a local drag override once the server-confirmed position catches up, so a drag never
  // visibly snaps back to the pre-drag spot while the PATCH is in flight.
  useEffect(() => {
    setLocalPos((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, pos] of Object.entries(prev)) {
        const n = nodeById.get(id);
        if (n && Math.abs(n.x - pos.x) < 0.5 && Math.abs(n.y - pos.y) < 0.5) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [nodeById]);

  const posOf = (n: MindmapNode) => localPos[n.id] ?? pinned[n.id] ?? autoPos?.get(n.id) ?? { x: n.x, y: n.y };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.001);
    setView((v) => ({ ...v, scale: Math.min(2.2, Math.max(0.3, v.scale * factor)) }));
  };

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    onSelect(null);
    dragRef.current = { type: "pan", startClientX: e.clientX, startClientY: e.clientY, startViewX: view.x, startViewY: view.y };
    viewportRef.current?.setPointerCapture(e.pointerId);
  };

  const onNodePointerDown = (e: React.PointerEvent, node: MindmapNode) => {
    e.stopPropagation();
    if (editingId === node.id) return;
    onSelect(node.id);
    const pos = posOf(node);
    dragRef.current = { type: "node", id: node.id, startClientX: e.clientX, startClientY: e.clientY, startX: pos.x, startY: pos.y, moved: false };
    setDraggingId(node.id);
    viewportRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.type === "pan") {
      setView((v) => ({ ...v, x: d.startViewX + (e.clientX - d.startClientX), y: d.startViewY + (e.clientY - d.startClientY) }));
    } else {
      const dx = (e.clientX - d.startClientX) / view.scale;
      const dy = (e.clientY - d.startClientY) / view.scale;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      setLocalPos((p) => ({ ...p, [d.id]: { x: d.startX + dx, y: d.startY + dy } }));
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDraggingId(null);
    if (d?.type === "node" && d.moved) {
      const pos = localPos[d.id];
      if (pos) {
        onMove(d.id, pos.x, pos.y);
        setPinned((p) => ({ ...p, [d.id]: pos }));
      }
    }
  };

  return (
    <div
      ref={viewportRef}
      onWheel={onWheel}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="relative h-full w-full touch-none overflow-hidden bg-subtle"
    >
      <div
        style={{ transform: `translate(calc(50% + ${view.x}px), calc(50% + ${view.y}px)) scale(${view.scale})`, transformOrigin: "0 0" }}
        className="absolute inset-0"
      >
        <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
          {nodes
            .filter((n) => n.parent_id)
            .map((n) => {
              const parent = nodeById.get(n.parent_id as string);
              if (!parent) return null;
              const p1 = posOf(parent);
              const p2 = posOf(n);
              return <line key={n.id} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--border-strong)" strokeWidth={2 / view.scale} />;
            })}
        </svg>
        {nodes.map((n) => {
          const pos = posOf(n);
          const isRoot = n.parent_id === null;
          const isSelected = selectedId === n.id;
          const isEditing = editingId === n.id;
          return (
            <div
              key={n.id}
              onPointerDown={(e) => onNodePointerDown(e, n)}
              onClick={(e) => {
                e.stopPropagation();
                if (isSelected && !isEditing) onEdit(n.id);
                else onSelect(n.id);
              }}
              style={{ left: pos.x, top: pos.y, transform: "translate(-50%, -50%)" }}
              className={cn(
                "absolute flex min-w-[120px] max-w-[220px] cursor-grab select-none items-center justify-center rounded-xl border px-3 py-2 text-center text-sm font-medium shadow-sm active:cursor-grabbing",
                n.id !== draggingId && "transition-[left,top] duration-200",
                isRoot ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-fg",
                isSelected && "ring-2 ring-accent ring-offset-2 ring-offset-subtle",
              )}
            >
              {isEditing ? (
                <input
                  autoFocus
                  defaultValue={n.text}
                  maxLength={300}
                  onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => onCommitText(n.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.currentTarget.value = n.text;
                      e.currentTarget.blur();
                    }
                  }}
                  className={cn("w-full bg-transparent text-center outline-none", isRoot ? "placeholder:text-accent-fg/60" : "")}
                />
              ) : (
                <span className="break-words">{n.text}</span>
              )}
              {isSelected && !isEditing && (
                <div className="absolute -right-3 top-1/2 flex -translate-y-1/2 translate-x-full items-center gap-1">
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddChild(n.id);
                    }}
                    aria-label={`Add branch to ${n.text}`}
                    title="Add branch"
                    className="rounded-full bg-accent p-1.5 text-accent-fg shadow-sm hover:opacity-90"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  {!isRoot && (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRequestDelete(n);
                      }}
                      aria-label={`Delete ${n.text}`}
                      title="Delete"
                      className="rounded-full bg-surface p-1.5 text-fg-subtle shadow-sm ring-1 ring-border hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="absolute left-4 top-4 flex items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-sm">
        {MINDMAP_LAYOUT_STYLES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => onLayoutStyleChange(s.value)}
            aria-pressed={layoutStyle === s.value}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium",
              layoutStyle === s.value ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-muted",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-sm">
        <button type="button" onClick={() => setView((v) => ({ ...v, scale: Math.max(0.3, v.scale * 0.85) }))} aria-label="Zoom out" className="rounded p-1.5 text-fg-muted hover:bg-muted">
          <ZoomOut className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setView({ x: 0, y: 0, scale: 1 })} aria-label="Reset view" className="rounded p-1.5 text-fg-muted hover:bg-muted">
          <Maximize className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setView((v) => ({ ...v, scale: Math.min(2.2, v.scale * 1.15) }))} aria-label="Zoom in" className="rounded p-1.5 text-fg-muted hover:bg-muted">
          <ZoomIn className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------- Mobile: indented outline ----------

function MindmapOutline({
  root,
  nodes,
  editingId,
  onEdit,
  onAddChild,
  onCommitText,
  onRequestDelete,
}: {
  root: MindmapNode;
  nodes: MindmapNode[];
  editingId: string | null;
  onEdit: (id: string | null) => void;
  onAddChild: (parentId: string) => void;
  onCommitText: (nodeId: string, text: string) => void;
  onRequestDelete: (node: MindmapNode) => void;
}) {
  const childrenOf = useMemo(() => {
    const map = new Map<string, MindmapNode[]>();
    for (const n of nodes) {
      if (!n.parent_id) continue;
      if (!map.has(n.parent_id)) map.set(n.parent_id, []);
      map.get(n.parent_id)?.push(n);
    }
    for (const list of map.values()) list.sort((a, b) => a.order_index - b.order_index);
    return map;
  }, [nodes]);

  return (
    <ul className="space-y-0.5">
      <OutlineRow node={root} depth={0} childrenOf={childrenOf} editingId={editingId} onEdit={onEdit} onAddChild={onAddChild} onCommitText={onCommitText} onRequestDelete={onRequestDelete} />
    </ul>
  );
}

function OutlineRow({
  node,
  depth,
  childrenOf,
  editingId,
  onEdit,
  onAddChild,
  onCommitText,
  onRequestDelete,
}: {
  node: MindmapNode;
  depth: number;
  childrenOf: Map<string, MindmapNode[]>;
  editingId: string | null;
  onEdit: (id: string | null) => void;
  onAddChild: (parentId: string) => void;
  onCommitText: (nodeId: string, text: string) => void;
  onRequestDelete: (node: MindmapNode) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isRoot = node.parent_id === null;
  const isEditing = editingId === node.id;
  const children = childrenOf.get(node.id) ?? [];

  return (
    <li>
      <div style={{ paddingLeft: `${depth * 16 + 4}px` }} className="flex items-center gap-1 rounded-lg py-1.5 pr-1 text-sm">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className={cn("shrink-0 rounded p-0.5 text-fg-subtle", !children.length && "invisible")}
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {isEditing ? (
          <input
            autoFocus
            defaultValue={node.text}
            maxLength={300}
            onBlur={(e) => onCommitText(node.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = node.text;
                e.currentTarget.blur();
              }
            }}
            className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-sm outline-none focus:border-accent"
          />
        ) : (
          <button type="button" onClick={() => onEdit(node.id)} className={cn("min-w-0 flex-1 truncate text-left", isRoot && "font-semibold")}>
            {node.text}
          </button>
        )}
        <button type="button" onClick={() => onAddChild(node.id)} aria-label={`Add branch to ${node.text}`} className="shrink-0 rounded p-1 text-fg-subtle hover:bg-muted hover:text-fg">
          <Plus className="h-3.5 w-3.5" />
        </button>
        {!isRoot && (
          <button type="button" onClick={() => onRequestDelete(node)} aria-label={`Delete ${node.text}`} className="shrink-0 rounded p-1 text-fg-subtle hover:bg-muted hover:text-danger">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {!collapsed && children.length > 0 && (
        <ul className="space-y-0.5">
          {children.map((c) => (
            <OutlineRow key={c.id} node={c} depth={depth + 1} childrenOf={childrenOf} editingId={editingId} onEdit={onEdit} onAddChild={onAddChild} onCommitText={onCommitText} onRequestDelete={onRequestDelete} />
          ))}
        </ul>
      )}
    </li>
  );
}
