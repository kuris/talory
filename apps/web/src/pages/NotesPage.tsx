import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Folder, Note, Project } from "@talorys/shared";
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  Crosshair,
  Eye,
  FolderKanban,
  FolderPlus,
  ListTodo,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Markdown } from "../components/Markdown";
import { buildIndex, type DragPayload, folderContents, folderPath, isSelfOrDescendant, NotesTree, useRootDropTarget } from "../components/NotesTree";
import { WriterEditor, type WriterHandle, taskStats, toggleTaskLine } from "../components/WriterEditor";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Input, Select, Spinner } from "../components/ui";
import { keys, useAllNotes, useApiMutation, useFolders, useNotes, useProjects } from "../hooks/queries";
import { useToast } from "../hooks/toast";
import { api } from "../lib/api";
import { cn, relativeTime } from "../lib/utils";

const EXPANDED_KEY = "talorys.notes.expanded";

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export default function NotesPage() {
  const { noteId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const searching = !!debounced;

  const foldersQuery = useFolders();
  const allNotesQuery = useAllNotes();
  const searchQuery = useNotes(debounced || undefined, { enabled: searching });
  const folders = foldersQuery.data ?? [];
  const allNotes = allNotesQuery.data ?? [];
  const { folderMap } = buildIndex(folders, allNotes);

  const persistExpanded = useCallback((next: Set<string>) => {
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
    } catch {}
  }, []);

  const toggleExpand = useCallback(
    (id: string) => {
      const next = new Set(expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistExpanded(next);
    },
    [expanded, persistExpanded],
  );

  // Reveal the path to the currently open note and focus it, so a deep link always shows its context.
  useEffect(() => {
    if (!noteId || allNotes.length === 0) return;
    const note = allNotes.find((n) => n.id === noteId);
    if (!note) return;
    setActiveFolderId(note.parent_folder_id);
    if (note.parent_folder_id) {
      const ancestors = folderPath(folderMap, note.parent_folder_id);
      if (ancestors.some((f) => !expanded.has(f.id))) {
        const next = new Set(expanded);
        for (const f of ancestors) next.add(f.id);
        persistExpanded(next);
      }
    }
    // Runs once per opened note; expanding further folders afterwards must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, allNotes.length]);

  const create = useApiMutation(
    () => api<{ note: Note }>("/notes", { method: "POST", body: { title: "Untitled", content: "", parent_folder_id: activeFolderId } }),
    { invalidate: [["notes"]], onSuccess: (r) => navigate(`/notes/${r.note.id}?edit=1`) },
  );

  const createFolder = useApiMutation(
    (parentId: string | null) => api<{ folder: Folder }>("/folders", { method: "POST", body: { name: "New folder", parent_folder_id: parentId } }),
    {
      invalidate: [keys.folders],
      onSuccess: (r, parentId) => {
        if (parentId) {
          const next = new Set(expanded);
          next.add(parentId);
          persistExpanded(next);
        }
        setActiveFolderId(parentId);
        setRenamingId(r.folder.id);
      },
    },
  );

  const renameFolder = useApiMutation((v: { id: string; name: string }) => api(`/folders/${v.id}`, { method: "PATCH", body: { name: v.name } }), {
    invalidate: [keys.folders],
  });

  const deleteFolder = useApiMutation(
    (id: string) => api<{ folders: number; notes: number }>(`/folders/${id}`, { method: "DELETE" }),
    {
      invalidate: [keys.folders, ["notes"]],
      success: (r) => `Folder deleted${r.notes || r.folders ? ` (${[r.notes && `${r.notes} note${r.notes === 1 ? "" : "s"}`, r.folders && `${r.folders} subfolder${r.folders === 1 ? "" : "s"}`].filter(Boolean).join(", ")})` : ""}`,
      onSuccess: (_r, id) => {
        setDeletingFolder(null);
        if (activeFolderId === id) setActiveFolderId(null);
      },
    },
  );

  const moveNote = useApiMutation(
    (v: { id: string; parent_folder_id: string | null }) => api(`/notes/${v.id}`, { method: "PATCH", body: { parent_folder_id: v.parent_folder_id } }),
    { invalidate: [["notes"]] },
  );
  const moveFolder = useApiMutation(
    (v: { id: string; parent_folder_id: string | null }) => api(`/folders/${v.id}`, { method: "PATCH", body: { parent_folder_id: v.parent_folder_id } }),
    { invalidate: [keys.folders] },
  );

  const moveItem = useCallback(
    (dragged: DragPayload, targetFolderId: string | null) => {
      if (dragged.kind === "note") {
        const note = allNotes.find((n) => n.id === dragged.id);
        if (note && note.parent_folder_id === targetFolderId) return;
        moveNote.mutate({ id: dragged.id, parent_folder_id: targetFolderId });
        return;
      }
      if (dragged.id === targetFolderId) return;
      const folder = folders.find((f) => f.id === dragged.id);
      if (folder && folder.parent_folder_id === targetFolderId) return;
      if (targetFolderId && isSelfOrDescendant(folders, dragged.id, targetFolderId)) {
        toast("Can't move a folder into itself or one of its own subfolders.", "error");
        return;
      }
      moveFolder.mutate({ id: dragged.id, parent_folder_id: targetFolderId });
    },
    // moveNote/moveFolder are stable useApiMutation results that only change identity on re-render, not on data changes.
    [allNotes, folders, toast], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const rootDrop = useRootDropTarget((dragged) => moveItem(dragged, null));

  const submitRename = (id: string, name: string) => {
    setRenamingId(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    const folder = folders.find((f) => f.id === id);
    if (folder && folder.name === trimmed) return;
    renameFolder.mutate({ id, name: trimmed });
  };

  const breadcrumb = activeFolderId ? folderPath(folderMap, activeFolderId) : [];
  const contents = deletingFolder ? folderContents(folders, allNotes, deletingFolder.id) : null;

  const isLoading = searching ? searchQuery.isLoading : foldersQuery.isLoading || allNotesQuery.isLoading;
  const error = searching ? searchQuery.error : foldersQuery.error ?? allNotesQuery.error;
  const empty = searching ? !searchQuery.data?.length : folders.length === 0 && allNotes.length === 0;

  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] md:min-h-full">
      <aside className={cn("w-full shrink-0 flex-col border-r border-border md:flex md:w-80", noteId ? "hidden" : "flex")}>
        <div className="space-y-3 p-4">
          <div
            className={cn("-mx-2 flex items-center justify-between rounded-lg px-2 py-1 transition-colors", rootDrop.dragOver && "bg-accent-soft ring-1 ring-accent/40")}
            {...rootDrop.handlers}
          >
            <button type="button" onClick={() => setActiveFolderId(null)} className="text-2xl font-semibold tracking-tight">
              Notes
            </button>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" onClick={() => createFolder.mutate(activeFolderId)} loading={createFolder.isPending} aria-label="New folder" title="New folder">
                <FolderPlus className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setProjectsOpen(true)} aria-label="Manage projects">
                <FolderKanban className="h-4 w-4" />
              </Button>
              <Button size="icon" onClick={() => create.mutate(undefined)} loading={create.isPending} aria-label="New note">
                {!create.isPending && <Plus className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          {!searching && breadcrumb.length > 0 && (
            <div className="flex items-center gap-1 overflow-x-auto text-xs text-fg-subtle">
              <button type="button" onClick={() => setActiveFolderId(null)} className="shrink-0 rounded px-1 hover:bg-muted hover:text-fg">
                Notes
              </button>
              {breadcrumb.map((f) => (
                <span key={f.id} className="flex shrink-0 items-center gap-1">
                  <ChevronRight className="h-3 w-3" />
                  <button type="button" onClick={() => setActiveFolderId(f.id)} className={cn("rounded px-1 hover:bg-muted hover:text-fg", f.id === activeFolderId && "font-medium text-fg")}>
                    {f.name}
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" className="h-9 pl-9 text-sm" aria-label="Search notes" />
          </div>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {error ? (
            <div className="p-2">
              <ErrorNotice
                error={error}
                onRetry={() => {
                  if (searching) void searchQuery.refetch();
                  else {
                    void foldersQuery.refetch();
                    void allNotesQuery.refetch();
                  }
                }}
              />
            </div>
          ) : isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : empty ? (
            <EmptyState icon={<NotebookPen className="h-8 w-8" />} title={searching ? "No matches" : "No notes yet"}>
              {searching ? "Try another search." : "Create a note or a folder to get started. Markdown supported."}
            </EmptyState>
          ) : searching ? (
            <ul className="space-y-0.5">
              {searchQuery.data?.map((n) => {
                const tasks = taskStats(n.content);
                const path = n.parent_folder_id ? folderPath(folderMap, n.parent_folder_id) : [];
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/notes/${n.id}`)}
                      className={cn("w-full rounded-lg px-3 py-2.5 text-left transition-colors", n.id === noteId ? "bg-muted" : "hover:bg-muted/60")}
                    >
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</p>
                        {tasks.total > 0 && (
                          <span className={cn("flex shrink-0 items-center gap-1 text-[11px] tabular-nums", tasks.done === tasks.total ? "text-success" : "text-fg-subtle")}>
                            <CircleCheck className="h-3 w-3" />
                            {tasks.done}/{tasks.total}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-fg-subtle">
                        {path.length > 0 ? `${path.map((f) => f.name).join(" / ")} · ` : ""}
                        {relativeTime(n.updated_at)}
                        {n.content ? ` · ${n.content.replace(/[#*_`>\-[\]]/g, "").slice(0, 120)}` : ""}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <NotesTree
              folders={folders}
              notes={allNotes}
              selectedNoteId={noteId}
              activeFolderId={activeFolderId}
              expanded={expanded}
              renamingId={renamingId}
              onToggleExpand={toggleExpand}
              onSelectFolder={setActiveFolderId}
              onOpenNote={(id) => navigate(`/notes/${id}`)}
              onStartRename={setRenamingId}
              onSubmitRename={submitRename}
              onCancelRename={() => setRenamingId(null)}
              onDeleteFolder={setDeletingFolder}
              onNewFolder={(parentId) => createFolder.mutate(parentId)}
              onMove={moveItem}
            />
          )}
        </div>
      </aside>

      <section className={cn("min-w-0 flex-1", !noteId && "hidden md:block")}>
        {noteId ? (
          <NoteEditor key={noteId} id={noteId} folderMap={folderMap} onBack={() => navigate("/notes")} />
        ) : (
          <EmptyState icon={<NotebookPen className="h-9 w-9" />} title="Select a note">
            Or create a new one with the + button.
          </EmptyState>
        )}
      </section>
      <ProjectsDialog open={projectsOpen} onClose={() => setProjectsOpen(false)} />
      <ConfirmDialog
        open={!!deletingFolder}
        title="Delete folder?"
        message={
          deletingFolder && (
            <>
              “{deletingFolder.name}” will be permanently deleted.
              {contents && (contents.folders > 0 || contents.notes > 0) && (
                <>
                  {" "}
                  This also deletes {contents.notes > 0 && `${contents.notes} note${contents.notes === 1 ? "" : "s"}`}
                  {contents.notes > 0 && contents.folders > 0 && " and "}
                  {contents.folders > 0 && `${contents.folders} subfolder${contents.folders === 1 ? "" : "s"}`} inside it.
                </>
              )}
            </>
          )
        }
        onCancel={() => setDeletingFolder(null)}
        onConfirm={() => {
          if (!deletingFolder) return;
          if (deletingFolder.id === activeFolderId) setActiveFolderId(null);
          deleteFolder.mutate(deletingFolder.id);
        }}
        loading={deleteFolder.isPending}
      />
    </div>
  );
}

function NoteEditor({ id, folderMap, onBack }: { id: string; folderMap: Map<string, Folder>; onBack: () => void }) {
  const projects = useProjects();
  const [note, setNote] = useState<Note | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [projectId, setProjectId] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">(() => (new URLSearchParams(location.search).get("edit") ? "edit" : "preview"));
  const [focusMode, setFocusMode] = useState(() => localStorage.getItem("talorys.notes.focus") === "1");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<WriterHandle>(null);

  useEffect(() => {
    try {
      localStorage.setItem("talorys.notes.focus", focusMode ? "1" : "0");
    } catch {}
  }, [focusMode]);

  useEffect(() => {
    // Ignore a superseded load: a late response must not overwrite what the owner already typed.
    let stale = false;
    api<{ note: Note }>(`/notes/${id}`)
      .then((r) => {
        if (stale) return;
        setNote(r.note);
        setTitle(r.note.title);
        setContent(r.note.content);
        setProjectId(r.note.project_id ?? "");
        if (!r.note.content) setMode("edit");
      })
      .catch((error) => {
        if (!stale) setLoadError(error);
      });
    return () => {
      stale = true;
    };
  }, [id]);

  // Compare the title as it will be stored (trimmed, "Untitled" when empty); comparing the raw
  // input would keep the note dirty forever and autosave in a loop.
  const savedTitle = title.trim() || "Untitled";
  const dirty = !!note && (savedTitle !== note.title || content !== note.content || projectId !== (note.project_id ?? ""));
  const body = { title: savedTitle, content, project_id: projectId || null };

  const save = useApiMutation(() => api<{ note: Note }>(`/notes/${id}`, { method: "PATCH", body }), {
    invalidate: [["notes"]],
    onSuccess: (r) => setNote(r.note),
  });

  // Flush pending edits when leaving the note (switching notes or pages) before autosave fires.
  const pending = useRef<{ dirty: boolean; body: typeof body }>({ dirty, body });
  pending.current = { dirty, body };
  const deleted = useRef(false);
  const qc = useQueryClient();
  useEffect(
    () => () => {
      if (!pending.current.dirty || deleted.current) return;
      void api(`/notes/${id}`, { method: "PATCH", body: pending.current.body })
        .then(() => qc.invalidateQueries({ queryKey: ["notes"] }))
        .catch(() => {});
    },
    [id, qc],
  );

  // Autosave shortly after typing stops.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!dirty || save.isPending) return;
    const t = setTimeout(() => saveRef.current.mutate(undefined), 1000);
    return () => clearTimeout(t);
  }, [dirty, title, content, projectId, save.isPending]);

  const toggleTask = useCallback((line: number) => setContent((c) => toggleTaskLine(c, line)), []);
  const remove = useApiMutation(
    async () => {
      await api(`/notes/${id}`, { method: "DELETE" });
      deleted.current = true;
    },
    {
      invalidate: [["notes"]],
      success: "Note deleted",
      onSuccess: onBack,
    },
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty) save.mutate(undefined);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (loadError) return <div className="p-6"><ErrorNotice error={loadError} /></div>;
  if (!note) return <div className="flex justify-center py-16"><Spinner /></div>;

  const path = note.parent_folder_id ? folderPath(folderMap, note.parent_folder_id) : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={onBack} className="md:hidden" aria-label="Back to notes">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex rounded-lg bg-muted p-0.5">
            <button type="button" onClick={() => setMode("edit")} className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium", mode === "edit" ? "bg-surface shadow-sm" : "text-fg-muted")}>
              <Pencil className="h-3 w-3" /> Write
            </button>
            <button type="button" onClick={() => setMode("preview")} className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium", mode === "preview" ? "bg-surface shadow-sm" : "text-fg-muted")}>
              <Eye className="h-3 w-3" /> Preview
            </button>
          </div>
          {mode === "edit" && (
            <>
              <Button variant="ghost" size="icon" onClick={() => setFocusMode((f) => !f)} aria-label="Focus mode" aria-pressed={focusMode} title="Focus mode — dim everything but the current paragraph" className={cn(focusMode && "text-accent")}>
                <Crosshair className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => editorRef.current?.insertTask()} aria-label="Add todo" title="Add todo (⌘↵ toggles the current line)">
                <ListTodo className="h-4 w-4" />
              </Button>
            </>
          )}
          {save.isPending ? <span className="text-xs text-fg-subtle">Saving…</span> : dirty ? <Badge tone="warning">Unsaved</Badge> : <span className="hidden text-xs text-fg-subtle sm:inline">Saved</span>}
        </div>
        <div className="flex items-center gap-1">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-8 w-36 text-xs" aria-label="Project">
            <option value="">No project</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button variant="ghost" size="icon" onClick={() => setConfirmDelete(true)} aria-label="Delete note">
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => save.mutate(undefined)} disabled={!dirty} loading={save.isPending}>
            Save
          </Button>
        </div>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[44rem] px-5 py-8 md:px-8 md:py-14">
          {path.length > 0 && (
            <div className="mb-2 flex items-center gap-1 overflow-x-auto text-xs text-fg-subtle">
              <span>Notes</span>
              {path.map((f) => (
                <span key={f.id} className="flex shrink-0 items-center gap-1">
                  <ChevronRight className="h-3 w-3" />
                  {f.name}
                </span>
              ))}
            </div>
          )}
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            placeholder="Title"
            aria-label="Note title"
            className="w-full bg-transparent text-2xl font-semibold tracking-tight placeholder:text-fg-subtle focus:outline-none"
          />
          <NoteMeta content={content} updatedAt={note.updated_at} />
          <div className="mt-6">
            {mode === "edit" ? (
              <div className="min-h-[55vh] cursor-text pb-[30vh]" onClick={(e) => e.target === e.currentTarget && editorRef.current?.focus()}>
                <WriterEditor
                  ref={editorRef}
                  value={content}
                  onChange={setContent}
                  focusMode={focusMode}
                  placeholder="Start writing…  (- [ ] makes a todo, ⌘↵ toggles it)"
                  aria-label="Note content"
                />
              </div>
            ) : content ? (
              <Markdown content={content} onToggleTask={toggleTask} />
            ) : (
              <p className="text-sm text-fg-subtle">Empty note.</p>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete note?"
        message={`“${note.title}” will be permanently deleted.`}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate(undefined)}
        loading={remove.isPending}
      />
    </div>
  );
}

function NoteMeta({ content, updatedAt }: { content: string; updatedAt: string }) {
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  const tasks = taskStats(content);
  const pct = tasks.total ? Math.round((tasks.done / tasks.total) * 100) : 0;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
      <span>Edited {relativeTime(updatedAt)}</span>
      <span>{words} {words === 1 ? "word" : "words"} · {Math.max(1, Math.round(words / 230))} min read</span>
      {tasks.total > 0 && (
        <span className="flex items-center gap-2">
          <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
          </span>
          {tasks.done}/{tasks.total} done
        </span>
      )}
    </div>
  );
}

function ProjectsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: projects } = useProjects();
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Project | null>(null);
  const create = useApiMutation(() => api("/projects", { method: "POST", body: { name } }), {
    invalidate: [keys.projects],
    onSuccess: () => setName(""),
  });
  const update = useApiMutation((v: { id: string; status: Project["status"] }) => api(`/projects/${v.id}`, { method: "PATCH", body: { status: v.status } }), {
    invalidate: [keys.projects],
  });
  const remove = useApiMutation((id: string) => api(`/projects/${id}`, { method: "DELETE" }), {
    invalidate: [keys.projects, keys.tasks, ["notes"]],
    success: "Project deleted",
    onSuccess: () => setDeleting(null),
  });
  return (
    <>
      <Dialog open={open && !deleting} onClose={onClose} title="Projects">
        <p className="mb-4 text-sm text-fg-muted">Lightweight projects group tasks and notes and give Talorys context.</p>
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate(undefined);
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" maxLength={200} aria-label="Project name" />
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
            Add
          </Button>
        </form>
        {!projects?.length ? (
          <p className="py-4 text-center text-sm text-fg-subtle">No projects yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {projects.map((p) => (
              <li key={p.id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                <Select value={p.status} onChange={(e) => update.mutate({ id: p.id, status: e.target.value as Project["status"] })} className="h-8 w-32 text-xs" aria-label={`Status of ${p.name}`}>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="completed">Completed</option>
                  <option value="archived">Archived</option>
                </Select>
                <Button variant="ghost" size="icon" onClick={() => setDeleting(p)} aria-label={`Delete ${p.name}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        title="Delete project?"
        message={`“${deleting?.name}” will be deleted. Its tasks and notes are kept and simply unassigned.`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </>
  );
}
