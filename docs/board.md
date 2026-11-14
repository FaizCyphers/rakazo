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

A ticket assigned to a bot moves to **In progress** as soon as its bot starts on it.

When one of your bots asks another to do something, by messaging it with a request or handing
work off in a group, the server tracks the work as a ticket in **In progress**, owned by the bot
that was asked. A message that names an open ticket already owned by that bot is tracked on that
ticket instead. Both bots are told the ticket's number, and the bot that was asked keeps progress
in its comments and moves it on when finished. Results, questions, status updates and FYIs are
not tracked. A delegated ticket whose run ended with nothing to check is left to its bot rather
than started again.

A ticket can wait on other tickets on the same board. It starts only once every ticket it waits
on is **Done** or **Won't do**, and then its bot is woken right away. A ticket can also say what
done means and list acceptance steps; the ticket shows these, and so does the context of the bot
working on it.

A bot can lay out a plan of up to 20 tickets with what each waits on. In Ask and Auto, its
approval card lists every ticket, its owner and what it waits on, and approving creates them all
at once. A plan too long to show whole on the card is refused. Tickets that wait on each other in
a loop are refused too.

## Checking finished work

When a bot's run on a ticket ends, and the ticket has acceptance steps or says what done means,
the server checks the work instead of trusting the bot to close its own ticket. A model reads the
ticket, the bot's final reply and recent comments, and judges each step as passed or not. It uses
your approval model, or the bot's own model when that one only answers pass or ask. Its cost is
counted apart from the bot's answers.

- Every step passed: the steps are ticked, a comment lists them, and the ticket moves to **Done**,
  which starts any tickets waiting on it.
- Some steps failed the first time: a comment lists them, and the bot is woken once more with
  what is missing.
- Failed again, or the check could not be made: the ticket moves to **Blocked** with a comment,
  for you to look at.

A run that failed, was stopped, or is waiting on your answer is not checked, and neither is a
ticket its bot already moved to **Done**, **Won't do** or **Blocked**. Moving a ticket yourself
gives it its two checks again.

Turn on **Require sign-off** on the board to have checked tickets wait in **In review**. Only a
person can then move a ticket to **Done**; a bot that tries is told to leave it in review.

## When a ticket gets stuck

A ticket is stuck when it is **In progress**, or ready in **To do** with a bot as its owner, and
nothing is working on it: its last run failed, the server stopped it, or it ended with the ticket
still open. The server looks at why, as soon as a run fails and again about once a minute, and
handles each kind on its own:

| Why it stopped | What happens |
| --- | --- |
| Cut off: the run was interrupted or ended early | Tried again after 2, then 5 minutes |
| The model or computer provider was busy or unreachable | Tried again after 2, 10, then 30 minutes, or when the provider says to |
| A conflict with other work on the server | Tried again after 1, 3, then 10 minutes |
| Needs you: no model connected, a rejected key or sign-in, an unavailable model, credits or plan | Moves to **Blocked** with the one thing to do, and its bot's owner gets a notification |
| Anything else | Moves to **Blocked** with a comment saying what went wrong |

Each try wakes the bot with a note to keep its earlier work and carry on. When a kind's tries run
out, the ticket moves to **Blocked** with a comment. A run you stopped yourself is never tried
again. Moving or editing a ticket yourself starts its tries over; a ticket you move back to
**In progress** is picked up again within a few minutes.
