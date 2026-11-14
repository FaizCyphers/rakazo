# Ticket board

> [!NOTE]
> The ticket board is a Labs feature. Each account turns it on in **Settings → Labs**, or a
> self-hosted server turns it on for everyone with `TICKET_BOARD_ENABLED=true` on the API and
> worker. See [Configuration](./self-host-configuration.md).

The board is a shared list of tickets that you and your bots both work from. Open it from **Board**
in the account menu, or from **Board** in Settings on mobile.

Tickets move through **To do**, **In progress**, **In review**, **Blocked**, **Done** and
**Won't do**. Each has a title, description, owner, priority and comments.

Assign a ticket to a bot and it starts working on it. Bots can also create, update and comment on
tickets themselves. Ticket work stays out of your chats, but a bot that needs you still posts a
card in its chat.

A ticket can wait on other tickets on the same board. It starts only once every ticket it waits
on is **Done** or **Won't do**, and then its bot is woken right away. A ticket can also say what
done means and list acceptance steps; the ticket shows these, and so does the context of the bot
working on it.

A bot can lay out a plan of up to 20 tickets with what each waits on. In Ask and Auto, its
approval card lists every ticket, its owner and what it waits on, and approving creates them all
at once. A plan too long to show whole on the card is refused. Tickets that wait on each other in
a loop are refused too.
