import * as z from "zod";
import { Id } from "./ids.js";

export const TICKET_STATUSES = ["todo", "doing", "review", "blocked", "done", "closed"] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** `done` is finished-but-open for review; `closed` is terminal, so both stamp completion. */
export function isTicketCompletedStatus(status: TicketStatus): boolean {
  return status === "done" || status === "closed";
}

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;
const DEFAULT_TICKET_PRIORITY: TicketPriority = "normal";

export const TICKET_TITLE_MAX_LENGTH = 200;
export const TICKET_DESCRIPTION_MAX_LENGTH = 20_000;
const TICKET_PREFIX_MAX_LENGTH = 12;
// Ticket numbers are stored as PostgreSQL Int values.
const TICKET_NUMBER_MAX = 2_147_483_647;
export const TICKET_COMMENT_MAX_LENGTH = 10_000;
export const TICKET_DONE_WHEN_MAX_LENGTH = 500;
export const TICKET_ACCEPTANCE_MAX_STEPS = 20;
export const TICKET_ACCEPTANCE_STEP_MAX_LENGTH = 500;
export const TICKET_WAITS_ON_MAX = 20;
export const TICKET_PLAN_MAX_TICKETS = 20;
const TICKET_PLAN_KEY_MAX_LENGTH = 40;
const TICKET_REFERENCE_MAX_LENGTH = 120;

const TicketPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(TICKET_PREFIX_MAX_LENGTH)
  .regex(
    /^[A-Za-z][A-Za-z0-9]*$/,
    "Prefix must start with a letter and contain only letters and digits",
  );

export function ticketRef(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

export function parseTicketRef(
  value: string,
  expectedPrefix?: string,
): { prefix: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-([1-9][0-9]*)$/.exec(value.trim());
  if (!match) return null;
  const [, rawPrefix, rawNumber] = match;
  if (!rawPrefix || !rawNumber) return null;
  const prefix = rawPrefix.toUpperCase();
  if (expectedPrefix !== undefined && prefix !== expectedPrefix.trim().toUpperCase()) return null;
  const number = Number(rawNumber);
  if (number > TICKET_NUMBER_MAX) return null;
  return { prefix, number };
}

export const BoardSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  ticketPrefix: z.string(),
  /** Checked tickets wait in review until a person moves them to done. */
  requireSignOff: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Board = z.infer<typeof BoardSchema>;

export const RenameBoardInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    ticketPrefix: TicketPrefixSchema.optional(),
    requireSignOff: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.ticketPrefix !== undefined ||
      value.requireSignOff !== undefined,
    { message: "Provide a name, ticketPrefix or requireSignOff" },
  );
export type RenameBoardInput = z.infer<typeof RenameBoardInput>;

export const TicketCommentSchema = z.object({
  id: Id,
  ticketId: Id,
  body: z.string(),
  authorBotId: Id.nullable(),
  authorUserId: Id.nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketComment = z.infer<typeof TicketCommentSchema>;

export const TicketAcceptanceStepSchema = z.object({
  text: z.string().trim().min(1).max(TICKET_ACCEPTANCE_STEP_MAX_LENGTH),
  checked: z.boolean().default(false),
});
export type TicketAcceptanceStep = z.infer<typeof TicketAcceptanceStepSchema>;

const DoneWhenSchema = z.string().trim().min(1).max(TICKET_DONE_WHEN_MAX_LENGTH);
const AcceptanceSchema = z.array(TicketAcceptanceStepSchema).max(TICKET_ACCEPTANCE_MAX_STEPS);
/** Tickets that must be complete before this one starts, by ref (RAK-3) or id. */
const WaitsOnSchema = z
  .array(z.string().trim().min(1).max(TICKET_REFERENCE_MAX_LENGTH))
  .max(TICKET_WAITS_ON_MAX)
  .refine((refs) => new Set(refs.map((ref) => ref.toUpperCase())).size === refs.length, {
    message: "Each ticket can be listed only once",
  });

export const TicketSchema = z.object({
  id: Id,
  boardId: Id,
  spaceId: Id,
  number: z.number().int().positive(),
  ref: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  assigneeBotId: Id.nullable(),
  createdByBotId: Id.nullable(),
  createdByUserId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  doneWhen: z.string().nullable(),
  acceptance: z.array(TicketAcceptanceStepSchema),
  /** Refs of the tickets this one waits on. */
  waitsOn: z.array(z.string()),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const ListTicketsInput = z.object({
  boardId: Id.optional(),
  status: TicketStatusSchema.optional(),
  assigneeBotId: Id.optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListTicketsInput = z.infer<typeof ListTicketsInput>;

export const ListTicketsOutput = z.object({ tickets: z.array(TicketSchema) });
export type ListTicketsOutput = z.infer<typeof ListTicketsOutput>;

export const GetTicketInput = z
  .object({
    id: Id.optional(),
    ref: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => Boolean(value.id) !== Boolean(value.ref), {
    message: "Provide exactly one of id or ref",
  });
export type GetTicketInput = z.infer<typeof GetTicketInput>;

export const CreateTicketInput = z.object({
  boardId: Id.optional(),
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH),
  description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).optional(),
  priority: TicketPrioritySchema.default(DEFAULT_TICKET_PRIORITY),
  assigneeBotId: Id,
  doneWhen: DoneWhenSchema.optional(),
  acceptance: AcceptanceSchema.optional(),
  waitsOn: WaitsOnSchema.optional(),
});
export type CreateTicketInput = z.infer<typeof CreateTicketInput>;

export const UpdateTicketInput = z.object({
  id: Id,
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH).optional(),
  description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  priority: TicketPrioritySchema.nullable().optional(),
  status: TicketStatusSchema.optional(),
  assigneeBotId: Id.optional(),
  doneWhen: DoneWhenSchema.nullable().optional(),
  acceptance: AcceptanceSchema.optional(),
  /** Replaces the whole list. */
  waitsOn: WaitsOnSchema.optional(),
});
export type UpdateTicketInput = z.infer<typeof UpdateTicketInput>;

export const TicketPlanItemSchema = z.object({
  /** Names this ticket within the plan, so other tickets can wait on it. */
  key: z.string().trim().min(1).max(TICKET_PLAN_KEY_MAX_LENGTH),
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH),
  description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).optional(),
  priority: TicketPrioritySchema.default(DEFAULT_TICKET_PRIORITY),
  assigneeBotId: Id,
  doneWhen: DoneWhenSchema.optional(),
  acceptance: AcceptanceSchema.optional(),
  /** Keys of other tickets in this plan, or refs of tickets already on the board. */
  waitsOn: WaitsOnSchema.default([]),
});
export type TicketPlanItem = z.infer<typeof TicketPlanItemSchema>;

export const TicketPlanInput = z
  .object({ tickets: z.array(TicketPlanItemSchema).min(1).max(TICKET_PLAN_MAX_TICKETS) })
  .superRefine((plan, ctx) => {
    const keys = new Set<string>();
    plan.tickets.forEach((item, index) => {
      const key = item.key.toUpperCase();
      if (keys.has(key))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate key ${item.key}`,
          path: ["tickets", index, "key"],
        });
      // A key that reads like a ref would be ambiguous in waitsOn.
      if (parseTicketRef(item.key))
        ctx.addIssue({
          code: "custom",
          message: `Key ${item.key} looks like a ticket ref; use a plain word`,
          path: ["tickets", index, "key"],
        });
      keys.add(key);
    });
  });
export type TicketPlanInput = z.infer<typeof TicketPlanInput>;

export const MoveTicketInput = z.object({
  id: Id,
  status: TicketStatusSchema,
});
export type MoveTicketInput = z.infer<typeof MoveTicketInput>;

export const CommentTicketInput = z.object({
  ticketId: Id,
  body: z.string().trim().min(1).max(TICKET_COMMENT_MAX_LENGTH),
});
export type CommentTicketInput = z.infer<typeof CommentTicketInput>;

export const BoardEventSchema = z.object({
  spaceId: Id,
  boardId: Id.optional(),
  ticketId: Id.optional(),
  createdAt: z.string(),
});
export type BoardEvent = z.infer<typeof BoardEventSchema>;
