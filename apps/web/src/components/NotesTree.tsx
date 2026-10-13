import { type DragEvent, type ReactNode, useState } from "react";
import type { Folder, Note } from "@talorys/shared";
import { ChevronRight, FileText, Folder as FolderIcon, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "../lib/utils";

/** What's being dragged: a note or a folder, identified by id. */
export interface DragPayload {
  kind: "note" | "folder";
  id: string;
}

const DRAG_MIME = "application/x-talorys-note-item";

/** Groups folders and notes by their parent (`null` = root), each sorted for display. */
export function buildIndex(folders: Folder[], notes: Note[]) {
  const childFolders = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const list = childFolders.get(f.parent_folder_id) ?? [];
    list.push(f);
    childFolders.set(f.parent_folder_id, list);
  }
  for (const list of childFolders.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const childNotes = new Map<string | null, Note[]>();
  for (const n of notes) {
    const list = childNotes.get(n.parent_folder_id) ?? [];
    list.push(n);
    childNotes.set(n.parent_folder_id, list);
  }
  for (const list of childNotes.values()) list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return { childFolders, childNotes, folderMap: new Map(folders.map((f) => [f.id, f])) };
}

/** Root-to-leaf chain of folders leading to `id` (empty if `id` is null or unknown). */
export function folderPath(folderMap: Map<string, Folder>, id: string | null): Folder[] {
  const path: Folder[] = [];
  let current = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    const f = folderMap.get(current);
    if (!f) break;
    path.unshift(f);
    seen.add(current);
    current = f.parent_folder_id;
  }
  return path;
}

/** How many subfolders and notes a delete would remove, for a confirmation prompt. */
export function folderContents(folders: Folder[], notes: Note[], folderId: string): { folders: number; notes: number } {
  const { childFolders } = buildIndex(folders, notes);
  const ids: string[] = [];
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop();
    if (id === undefined) continue;
    ids.push(id);
    for (const child of childFolders.get(id) ?? []) stack.push(child.id);
  }
  const idSet = new Set(ids);
  const noteCount = notes.filter((n) => n.parent_folder_id && idSet.has(n.parent_folder_id)).length;
  return { folders: ids.length - 1, notes: noteCount };
}

/** True if `candidateId` is `folderId` itself, or lives inside it — moving `folderId` there would create a cycle. */
export function isSelfOrDescendant(folders: Folder[], folderId: string, candidateId: string): boolean {
  if (folderId === candidateId) return true;
  const byId = new Map(folders.map((f) => [f.id, f]));
  let current: string | null = candidateId;
  const seen = new Set<string>();
  while (current) {
    if (current === folderId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = byId.get(current)?.parent_folder_id ?? null;
  }
  return false;
}

export interface NotesTreeProps {
  folders: Folder[];
  notes: Note[];
  selectedNoteId?: string;
  activeFolderId: string | null;
  expanded: Set<string>;
  renamingId: string | null;
  onToggleExpand: (id: string) => void;
  onSelectFolder: (id: string) => void;
  onOpenNote: (id: string) => void;
  onStartRename: (id: string) => void;
  onSubmitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  onDeleteFolder: (folder: Folder) => void;
  onNewFolder: (parentId: string) => void;
  onMove: (dragged: DragPayload, targetFolderId: string | null) => void;
}

/** VS Code–style recursive folder/note tree with inline rename, delete and drag & drop. */
export function NotesTree(props: NotesTreeProps) {
  const { childFolders, childNotes } = buildIndex(props.folders, props.notes);
  return (
    <TreeLevel
      {...props}
      depth={0}
      parentId={null}
      childFolders={childFolders}
      childNotes={childNotes}
    />
  );
}

interface TreeLevelProps extends NotesTreeProps {
  depth: number;
  parentId: string | null;
  childFolders: Map<string | null, Folder[]>;
  childNotes: Map<string | null, Note[]>;
}

function TreeLevel({ depth, parentId, childFolders, childNotes, ...props }: TreeLevelProps) {
  const folders = childFolders.get(parentId) ?? [];
  const notes = childNotes.get(parentId) ?? [];
  if (folders.length === 0 && notes.length === 0 && depth > 0) {
    return <p style={{ paddingLeft: depth * 16 + 30 }} className="py-1 text-xs text-fg-subtle">Empty</p>;
  }
  return (
    <ul>
      {folders.map((folder) => (
        <li key={folder.id}>
          <FolderRow folder={folder} depth={depth} {...props} />
          {props.expanded.has(folder.id) && (
            <TreeLevel {...props} depth={depth + 1} parentId={folder.id} childFolders={childFolders} childNotes={childNotes} />
          )}
        </li>
      ))}
      {notes.map((note) => (
        <li key={note.id}>
          <NoteRow note={note} depth={depth} {...props} />
        </li>
      ))}
    </ul>
  );
}

function dragData(e: DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    return raw ? (JSON.parse(raw) as DragPayload) : null;
  } catch {
    return null;
  }
}

function FolderRow({
  folder,
  depth,
  activeFolderId,
  expanded,
  renamingId,
  onToggleExpand,
  onSelectFolder,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onDeleteFolder,
  onNewFolder,
  onMove,
}: Pick<
  NotesTreeProps,
  | "activeFolderId"
  | "expanded"
  | "renamingId"
  | "onToggleExpand"
  | "onSelectFolder"
  | "onStartRename"
  | "onSubmitRename"
  | "onCancelRename"
  | "onDeleteFolder"
  | "onNewFolder"
  | "onMove"
> & { folder: Folder; depth: number }) {
  const [dragOver, setDragOver] = useState(false);
  const isOpen = expanded.has(folder.id);
  const isActive = activeFolderId === folder.id;
  const isRenaming = renamingId === folder.id;

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg py-1.5 pr-1.5 text-left transition-colors",
        dragOver ? "bg-accent-soft ring-1 ring-accent/40" : isActive ? "bg-muted" : "hover:bg-muted/60",
      )}
      style={{ paddingLeft: depth * 16 + 4 }}
      draggable={!isRenaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "folder", id: folder.id }));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const dragged = dragData(e);
        if (dragged) onMove(dragged, folder.id);
      }}
    >
      <button
        type="button"
        onClick={() => onToggleExpand(folder.id)}
        aria-label={isOpen ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:text-fg"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")} />
      </button>
      <button
        type="button"
        onClick={() => {
          onToggleExpand(folder.id);
          onSelectFolder(folder.id);
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
      >
        {isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-accent" /> : <FolderIcon className="h-4 w-4 shrink-0 text-fg-subtle" />}
        {isRenaming ? (
          <input
            autoFocus
            defaultValue={folder.name}
            maxLength={200}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmitRename(folder.id, e.currentTarget.value);
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={(e) => onSubmitRename(folder.id, e.currentTarget.value)}
            className="min-w-0 flex-1 rounded border border-accent bg-surface px-1 text-sm focus:outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</span>
        )}
      </button>
      {!isRenaming && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <IconAction label={`New note in ${folder.name}`} onClick={() => onSelectFolder(folder.id)}>
            <Plus className="h-3.5 w-3.5" />
          </IconAction>
          <IconAction label={`New folder in ${folder.name}`} onClick={() => onNewFolder(folder.id)}>
            <FolderIcon className="h-3.5 w-3.5" />
          </IconAction>
          <IconAction label={`Rename ${folder.name}`} onClick={() => onStartRename(folder.id)}>
            <Pencil className="h-3.5 w-3.5" />
          </IconAction>
          <IconAction label={`Delete ${folder.name}`} onClick={() => onDeleteFolder(folder)}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconAction>
        </div>
      )}
    </div>
  );
}

function NoteRow({
  note,
  depth,
  selectedNoteId,
  onOpenNote,
}: Pick<NotesTreeProps, "selectedNoteId" | "onOpenNote"> & { note: Note; depth: number }) {
  const isSelected = selectedNoteId === note.id;
  return (
    <button
      type="button"
      onClick={() => onOpenNote(note.id)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "note", id: note.id }));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-sm transition-colors",
        isSelected ? "bg-muted font-medium" : "hover:bg-muted/60",
      )}
      style={{ paddingLeft: depth * 16 + 28 }}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0 flex-1 truncate">{note.title}</span>
    </button>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-1 text-fg-subtle hover:bg-border hover:text-fg"
    >
      {children}
    </button>
  );
}

/** Drop target covering the root level (e.g. the page title) — moves the dragged item out of every folder. */
export function useRootDropTarget(onMove: (dragged: DragPayload) => void) {
  const [over, setOver] = useState(false);
  return {
    dragOver: over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const dragged = dragData(e);
        if (dragged) onMove(dragged);
      },
    },
  };
}
