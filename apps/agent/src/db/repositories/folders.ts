import type { Folder } from "@talorys/shared";
import { type Database, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";
import { stripUndefined } from "./tasks";

export class FolderRepository {
  constructor(private readonly db: Database) {}

  list(): Folder[] {
    return this.db.all<Folder>(`SELECT * FROM tal_folders ORDER BY name COLLATE NOCASE`);
  }

  get(id: string): Folder | null {
    return this.db.one<Folder>(`SELECT * FROM tal_folders WHERE id = ?`, id);
  }

  require(id: string): Folder {
    const f = this.get(id);
    if (!f) throw new NotFoundError("Folder not found");
    return f;
  }

  /** True if `candidateAncestorId` is `folderId` itself or one of its ancestors (i.e. moving `folderId` under it would create a cycle). */
  isSelfOrAncestor(folderId: string, candidateAncestorId: string): boolean {
    let current: string | null = candidateAncestorId;
    const seen = new Set<string>();
    while (current) {
      if (current === folderId) return true;
      if (seen.has(current)) return false; // already-corrupt chain; stop rather than loop forever
      seen.add(current);
      current = this.db.one<{ parent_folder_id: string | null }>(`SELECT parent_folder_id FROM tal_folders WHERE id = ?`, current)?.parent_folder_id ?? null;
    }
    return false;
  }

  create(input: { name: string; parent_folder_id?: string | null }): Folder {
    const ts = now();
    const folder: Folder = {
      id: newId(),
      name: input.name.trim(),
      parent_folder_id: input.parent_folder_id ?? null,
      created_at: ts,
      updated_at: ts,
    };
    this.db.run(
      `INSERT INTO tal_folders (id, name, parent_folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      folder.id, folder.name, folder.parent_folder_id, folder.created_at, folder.updated_at,
    );
    return folder;
  }

  update(id: string, patch: { name?: string; parent_folder_id?: string | null }): Folder {
    const existing = this.require(id);
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    this.db.run(
      `UPDATE tal_folders SET name = ?, parent_folder_id = ?, updated_at = ? WHERE id = ?`,
      next.name, next.parent_folder_id, next.updated_at, id,
    );
    return next;
  }

  /** This folder and every descendant folder id, including itself. */
  private subtreeIds(id: string): string[] {
    const ids = [id];
    const children = this.db.all<{ id: string }>(`SELECT id FROM tal_folders WHERE parent_folder_id = ?`, id);
    for (const child of children) ids.push(...this.subtreeIds(child.id));
    return ids;
  }

  /** Counts the notes and subfolders a delete would remove, for a confirmation prompt. */
  contents(id: string): { folders: number; notes: number } {
    const ids = this.subtreeIds(id);
    const placeholders = ids.map(() => "?").join(",");
    const notes = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_notes WHERE parent_folder_id IN (${placeholders})`, ...ids)?.n ?? 0;
    return { folders: ids.length - 1, notes };
  }

  /** Deletes the folder and everything inside it (subfolders and notes), returning what was removed. */
  delete(id: string): { folders: number; notes: number } {
    this.require(id);
    return this.db.transaction(() => {
      const ids = this.subtreeIds(id);
      const placeholders = ids.map(() => "?").join(",");
      // Counted before deleting: the notes table has an FTS sync trigger, so the DELETE statement's
      // own row-write count also includes its writes to the search index and can't be used here.
      const notes = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_notes WHERE parent_folder_id IN (${placeholders})`, ...ids)?.n ?? 0;
      this.db.run(`DELETE FROM tal_notes WHERE parent_folder_id IN (${placeholders})`, ...ids);
      // Children first, then self, so a partial failure never leaves an orphaned subfolder.
      for (let i = ids.length - 1; i >= 0; i--) this.db.run(`DELETE FROM tal_folders WHERE id = ?`, ids[i]);
      return { folders: ids.length - 1, notes };
    });
  }
}
