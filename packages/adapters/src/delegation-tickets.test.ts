import { TICKET_TITLE_MAX_LENGTH } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  delegationBoard,
  delegationNotice,
  delegationTitle,
  trackDelegation,
} from "./delegation-tickets.js";

const board = { id: "board-1", ticketPrefix: "RAK", ownerId: "user-1" };
const input = {
  spaceId: "space-1",
  userId: "user-1",
  fromBotId: "bot-a",
  toBotId: "bot-b",
  message: "Draft the release notes\n\nCover every merged change.",
};

function harness(options: { target?: boolean; named?: unknown[] } = {}) {
  const create = vi.fn(async (args: { data: { number: number } }) => ({
    id: "ticket-new",
    number: args.data.number,
    doneWhen: null,
    acceptance: null,
  }));
  const tx = {
    bot: { findFirst: vi.fn(async () => (options.target === false ? null : { id: "bot-b" })) },
    ticket: { findMany: vi.fn(async () => options.named ?? []), create },
    board: { update: vi.fn(async () => ({ nextNumber: 13 })) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, create, mocks: tx };
}

describe("delegation tickets", () => {
  it("titles a ticket with the message's first line, cut to the title limit", () => {
    expect(delegationTitle("\n  Draft the notes  \nmore")).toBe("Draft the notes");
    const long = delegationTitle("x".repeat(TICKET_TITLE_MAX_LENGTH + 50));
    expect(long).toHaveLength(TICKET_TITLE_MAX_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  it("names the ticket in one line, and says a checked ticket is finished by its check", () => {
    expect(delegationNotice({ ref: "RAK-12", checked: false })).toBe(
      "Tracked as RAK-12. Keep progress in its comments and move it to done, review or blocked when finished.",
    );
    expect(delegationNotice({ ref: "RAK-12", checked: true })).toBe(
      "Tracked as RAK-12. Keep progress in its comments; it is checked when your run ends.",
    );
  });

  it("creates a ticket in progress for the target, from the message", async () => {
    const { tx, create } = harness();
    await expect(trackDelegation(tx, board, input)).resolves.toEqual({
      id: "ticket-new",
      boardId: "board-1",
      ref: "RAK-12",
      checked: false,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          number: 12,
          title: "Draft the release notes",
          description: input.message,
          status: "doing",
          assigneeBotId: "bot-b",
          createdByBotId: "bot-a",
          createdByUserId: "user-1",
        }),
      }),
    );
  });

  it("links to the open ticket the message names that is already the target's", async () => {
    const { tx, create, mocks } = harness({
      named: [{ id: "ticket-7", number: 7, doneWhen: "Notes are published", acceptance: null }],
    });
    await expect(
      trackDelegation(tx, board, { ...input, message: "Pick up RAK-3 and rak-7 please" }),
    ).resolves.toEqual({ id: "ticket-7", boardId: "board-1", ref: "RAK-7", checked: true });
    expect(mocks.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          number: { in: [3, 7] },
          assigneeBotId: "bot-b",
          status: { notIn: ["done", "closed"] },
        }),
      }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("tracks nothing for a bot its owner does not own", async () => {
    const { tx, create } = harness({ target: false });
    await expect(trackDelegation(tx, board, input)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("has no board without the board lab", async () => {
    const prisma = {
      bot: { findFirst: vi.fn(async () => ({ userId: "user-1" })) },
      user: { findUnique: vi.fn(async () => ({ labs: [] })) },
      board: { findUnique: vi.fn() },
    };
    await expect(
      delegationBoard({ prisma: prisma as never }, { spaceId: "space-1", botId: "bot-a" }),
    ).resolves.toBeNull();
    expect(prisma.board.findUnique).not.toHaveBeenCalled();
  });
});
