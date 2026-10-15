import { useMemo, useState } from "react";
import type { CalendarEvent, Task } from "@talorys/shared";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Trash2 } from "lucide-react";
import { Button, Dialog, ErrorNotice, Input, Label, PageHeader, Spinner, Textarea } from "../components/ui";
import { keys, useApiMutation, useCalendar, useTimezone } from "../hooks/queries";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The owner's local calendar day for a UTC instant, as "YYYY-MM-DD". */
function toLocalDateKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

interface GridCell {
  key: string;
  day: number;
  inMonth: boolean;
}

/** A 6-week (42-cell) grid for the given month, computed with pure calendar math — no timezone involved. */
function buildMonthGrid(year: number, month: number): GridCell[] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const start = new Date(Date.UTC(year, month - 1, 1 - firstWeekday));
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    return { key: dateKey(y, m, day), day, inMonth: m === month && y === year };
  });
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) (out[keyOf(item)] ??= []).push(item);
  return out;
}

type DialogState = { mode: "create"; date: string } | { mode: "edit"; event: CalendarEvent };

export default function CalendarPage() {
  const tz = useTimezone();
  const today = new Date();
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() + 1 });
  const grid = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor]);
  const start = grid[0]!.key;
  const end = grid[grid.length - 1]!.key;
  const { data, isLoading, error, refetch } = useCalendar(start, end);
  const todayKey = toLocalDateKey(today.toISOString(), tz);

  const eventsByDate = useMemo(() => groupBy(data?.events ?? [], (e) => e.date), [data]);
  const tasksByDate = useMemo(
    () => groupBy((data?.tasks ?? []).filter((t): t is Task & { due_at: string } => !!t.due_at), (t) => toLocalDateKey(t.due_at, tz)),
    [data, tz],
  );

  const [dialog, setDialog] = useState<DialogState | null>(null);

  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(Date.UTC(cursor.year, cursor.month - 1, 1)));

  const shiftMonth = (delta: number) =>
    setCursor((c) => {
      const d = new Date(Date.UTC(c.year, c.month - 1 + delta, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    });
  const goToday = () => setCursor({ year: today.getFullYear(), month: today.getMonth() + 1 });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
      <PageHeader
        title="Calendar"
        description="Tasks with a due date appear here automatically. Click a day to add an event."
        actions={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => shiftMonth(-1)} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="w-36 text-center text-sm font-medium">{monthLabel}</div>
            <Button variant="ghost" size="icon" onClick={() => shiftMonth(1)} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={goToday}>
              Today
            </Button>
          </div>
        }
      />

      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading && !data ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-7 border-b border-border bg-subtle">
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-2 text-center text-xs font-medium text-fg-subtle">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((cell) => {
              const events = eventsByDate[cell.key] ?? [];
              const tasks = tasksByDate[cell.key] ?? [];
              const items = [...tasks.map((t) => ({ kind: "task" as const, item: t })), ...events.map((e) => ({ kind: "event" as const, item: e }))];
              return (
                <button
                  type="button"
                  key={cell.key}
                  onClick={() => setDialog({ mode: "create", date: cell.key })}
                  className={cn(
                    "min-h-[92px] border-b border-r border-border p-1.5 text-left align-top last:border-r-0 hover:bg-subtle sm:min-h-[112px]",
                    !cell.inMonth && "bg-subtle/60",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs",
                      cell.key === todayKey ? "bg-accent font-semibold text-accent-fg" : !cell.inMonth ? "text-fg-subtle" : "text-fg",
                    )}
                  >
                    {cell.day}
                  </span>
                  <div className="mt-1 space-y-0.5">
                    {items.slice(0, 3).map(({ kind, item }) =>
                      kind === "task" ? (
                        <div key={item.id} className="flex items-center gap-1 truncate rounded bg-muted px-1 py-0.5 text-[11px] text-fg-muted">
                          {item.status === "done" ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : <Circle className="h-3 w-3 shrink-0" />}
                          <span className={cn("truncate", item.status === "done" && "line-through")}>{item.title}</span>
                        </div>
                      ) : (
                        <div
                          key={item.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDialog({ mode: "edit", event: item });
                          }}
                          className="truncate rounded bg-accent/15 px-1 py-0.5 text-[11px] font-medium text-accent"
                        >
                          {item.title}
                        </div>
                      ),
                    )}
                    {items.length > 3 && <div className="px-1 text-[11px] text-fg-subtle">+{items.length - 3} more</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {dialog && <EventDialog state={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function EventDialog({ state, onClose }: { state: DialogState; onClose: () => void }) {
  const isEdit = state.mode === "edit";
  const [title, setTitle] = useState(isEdit ? state.event.title : "");
  const [date, setDate] = useState(isEdit ? state.event.date : state.date);
  const [notes, setNotes] = useState(isEdit ? state.event.notes : "");

  const create = useApiMutation((v: { title: string; date: string; notes: string }) => api("/calendar-events", { method: "POST", body: v }), {
    invalidate: [keys.calendarAll],
    onSuccess: onClose,
  });
  const update = useApiMutation(
    (v: { title: string; date: string; notes: string }) => api(`/calendar-events/${isEdit ? state.event.id : ""}`, { method: "PATCH", body: v }),
    { invalidate: [keys.calendarAll], onSuccess: onClose },
  );
  const remove = useApiMutation(() => api(`/calendar-events/${isEdit ? state.event.id : ""}`, { method: "DELETE" }), {
    invalidate: [keys.calendarAll],
    onSuccess: onClose,
  });

  const save = () => {
    const v = { title: title.trim(), date, notes };
    if (isEdit) update.mutate(v);
    else create.mutate(v);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? "Edit event" : "Add event"}
      footer={
        <div className="flex w-full justify-between">
          {isEdit ? (
            <Button variant="ghost" className="text-danger" onClick={() => remove.mutate(undefined)} loading={remove.isPending}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} loading={create.isPending || update.isPending} disabled={!title.trim()}>
              Save
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="event-title">Title</Label>
          <Input id="event-title" autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="event-date">Date</Label>
          <Input id="event-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="event-notes" hint="Optional">
            Notes
          </Label>
          <Textarea id="event-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}
