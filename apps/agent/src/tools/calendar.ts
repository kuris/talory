import { isValidCalendarDate, type CalendarEvent } from "@talorys/shared";
import { z } from "zod";
import { defineTool, ToolError } from "./registry";
import { localDateRangeBounds } from "../services/time";

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Local calendar date 'YYYY-MM-DD' in the owner's timezone");

function checkDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if (!isValidCalendarDate(y, m, d)) throw new ToolError(`"${date}" is not a valid calendar date.`);
  return date;
}

function present(e: CalendarEvent) {
  return { id: e.id, title: e.title, date: e.date, ...(e.notes ? { notes: e.notes } : {}) };
}

export const calendarTools = [
  defineTool({
    name: "create_calendar_event",
    description: "Add an event to the owner's calendar on a specific date. For to-dos with a deadline, use create_task instead — its due date already appears on the calendar.",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z.object({
      title: z.string().min(1).max(200),
      date: localDate,
      notes: z.string().max(2000).optional(),
    }),
    label: (i) => `Adding “${i.title}” to the calendar`,
    execute: (i, ctx) => {
      const event = ctx.services.calendar.create({ title: i.title, date: checkDate(i.date), notes: i.notes });
      ctx.services.activity.record("calendar.created", `Agent added calendar event “${event.title}”`);
      return { created: present(event) };
    },
  }),
  defineTool({
    name: "list_calendar_events",
    description: "List the owner's calendar events (manually-added entries, not tasks) within a local date range.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ start: localDate, end: localDate }),
    label: () => `Checking the calendar`,
    execute: (i, ctx) => {
      localDateRangeBounds(checkDate(i.start), checkDate(i.end), ctx.timezone); // validates the range
      const events = ctx.services.calendar.listRange(i.start, i.end);
      return { count: events.length, events: events.map(present) };
    },
  }),
  defineTool({
    name: "delete_calendar_event",
    description: "Delete a calendar event by id.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1).max(64) }),
    label: () => `Removing a calendar event`,
    execute: (i, ctx) => {
      const event = ctx.services.calendar.get(i.id);
      if (!event) throw new ToolError("No calendar event with that id.");
      ctx.services.calendar.delete(i.id);
      return { deleted: present(event) };
    },
  }),
];
