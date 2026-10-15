import type { CalendarEvent } from "@talorys/shared";
import { type Database, likePattern, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";
import { stripUndefined } from "./tasks";

export class CalendarRepository {
  constructor(private readonly db: Database) {}

  /** Manually-added events whose date falls within [start, end], inclusive, both "YYYY-MM-DD". */
  listRange(start: string, end: string): CalendarEvent[] {
    return this.db.all<CalendarEvent>(`SELECT * FROM tal_calendar_events WHERE date >= ? AND date <= ? ORDER BY date, created_at`, start, end);
  }

  get(id: string): CalendarEvent | null {
    return this.db.one<CalendarEvent>(`SELECT * FROM tal_calendar_events WHERE id = ?`, id);
  }

  require(id: string): CalendarEvent {
    const e = this.get(id);
    if (!e) throw new NotFoundError("Calendar event not found");
    return e;
  }

  /** Events whose title or notes match, newest first. */
  search(q: string, limit = 10): CalendarEvent[] {
    return this.db.all<CalendarEvent>(
      `SELECT * FROM tal_calendar_events WHERE title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' ORDER BY date DESC LIMIT ?`,
      likePattern(q), likePattern(q), limit,
    );
  }

  create(input: { title: string; date: string; notes?: string }): CalendarEvent {
    const ts = now();
    const event: CalendarEvent = { id: newId(), title: input.title.trim(), date: input.date, notes: input.notes ?? "", created_at: ts, updated_at: ts };
    this.db.run(
      `INSERT INTO tal_calendar_events (id, title, date, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      event.id, event.title, event.date, event.notes, event.created_at, event.updated_at,
    );
    return event;
  }

  update(id: string, patch: { title?: string; date?: string; notes?: string }): CalendarEvent {
    const existing = this.require(id);
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    this.db.run(`UPDATE tal_calendar_events SET title = ?, date = ?, notes = ? WHERE id = ?`, next.title, next.date, next.notes, id);
    return next;
  }

  delete(id: string): void {
    this.require(id);
    this.db.run(`DELETE FROM tal_calendar_events WHERE id = ?`, id);
  }
}
