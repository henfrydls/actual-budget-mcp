# Changelog

## 0.10.6

Three replies that were not describing your budget. `create_transaction` read
your request back to you, `delete_rule` showed you the rule as the engine
stores it, and `get_rules` handed over everything whether or not you could
read it. Nothing was written wrongly in any of the three; what they told you
about it was wrong, or was too much to use.

### The reply says what was saved, not what was asked for (#184)

Actual runs your rules on every transaction it takes in, so the row that lands
can differ from the one you sent. The reply repeated the request, except for
one line: the category, which has read the row since 0.10.5. One sentence
spoke for the budget and the rest spoke for you, with nothing to say which was
which.

Found in the live test of 0.10.5. A rule that sets `amount` put the
transaction into the budget at -5.50, and the reply said `Amount: -4.40`, the
figure in the request. The budget had the right number and the reply did not.

Every value in the reply is now the one on the saved row, and a value a rule
decided says so, the way the category line already did:

    Amount:   -5.50 (set by one of your rules, asked for -4.40)

That covers the amount, the date, the payee, the notes and the cleared flag.
`Cleared` only appears when a rule decided it, since nothing has ever printed
it otherwise.

Three things the reply used to claim that had not happened:

A transfer a rule stopped. When you name one of your accounts as the payee,
the transaction is linked to a matching row there. A rule that then rewrites
the payee leaves it linked to nothing and the other account empty, while the
reply announced the transfer, the matching row and what the movement did to
your budget.

A transfer that went somewhere else, or in more than one direction. A rule can
point a transaction at a different account, and it can split one into parts
that each move on their own. The reply named one account and described one
movement. It describes each of them now, with the account each one reached and
what it did to your budget.

A category on a split. The reply said a category you asked for had not been
applied; Actual copies it onto every part, so it is applied, and the parts are
where it lives. The parts are read, and the reply says what each of them is
filed under and which of those a rule chose.

When the budget cannot be read back at all, the reply says that too, instead
of letting the request pass for a description of what is there.

`create_transactions` takes the figures in its transfer summary from the rows
as well, lists separately the rows that asked to be transfers and did not
become them, and ends with one line per row a rule changed. A batch nothing
happened to reads exactly as it did before.

### Deleting a rule shows you the rule (#186)

`delete_rule` prints what it is about to delete so you can check it is the
right one, and it printed the values as the engine stores them: an amount a
hundred times larger than the figure it means, a schedule's recurrence as its
stored configuration, and a payee as an id. The one thing that confirmation
exists for was the part that could not be read.

It now says it in the same words as `get_rules`, through the same code, so the
two cannot describe one rule differently again. The warnings come with it:
when the rule you are about to delete is one that breaks your imports, that is
worth knowing before you decide.

In both of them, quotes now mean one thing: this is the text your budget is
holding. A figure, a true or false, a recurrence in words and the name an id
stands for are printed as themselves. That puts a working rule and a broken
one on different lines for the first time:

    THEN set cleared = false        THEN set cleared = "false"
    THEN set amount  = -5.50        THEN set amount  = "-5.50"
    IF payee is Netflix             IF payee is "Netflix"

The left column works. The right column is a rule that means the opposite of
what it says, one that takes your next import down, and one that has never
matched anything. All three used to print like the left.

Two more things in the listing read properly now. A split action printed its
operation twice with the figure in cents and nothing about which part it was
for. A value written as a template printed as though the rule had none, since
the stored value is empty and the engine reads the template instead.

### Asking get_rules for fewer rules (#177)

The listing is around 161 bytes a rule, so a budget with 1500 of them answered
with 242 KB, which is a large part of an assistant's context spent on a list
nobody reads all of.

**If you have more than 100 rules, this changes the reply you get.** It
returns the first 100, and says how many there are, where the next page
starts, and how many of the rules it did not list carry a warning, so a page
cannot bury one. With 100 rules or fewer and no arguments, the reply is the
same as before, to the byte.

Three ways to ask for less:

- `flagged_only` gives the rules carrying a warning, wherever they are. This
  is the only way to find the ones 0.10.5 learned to warn about.
- `field` gives the rules that mention one field, such as payee, amount or
  category.
- `limit` and `offset` page through the rest.

### What Actual does, which this cannot change

Two things were measured against the engine while fixing the above, and
neither is something this server can decide:

- A rule that sets `account` does not move a new transaction. Actual writes
  the account you sent over whatever the rule chose, so the transaction stays
  where you put it. Such a rule does nothing on the way in.
- Actual takes the category off a transfer whose two accounts are both inside
  your budget, or both outside it, and it does so after the transaction is
  written. A category on that kind of transfer is not kept, whatever you ask
  for, and the reply says so rather than announcing one that is about to go.

### Known, and not fixed here

- `allow_duplicate` in a batch is still all or nothing. To let one legitimate
  repeat through, it switches off the approximate checks for every row in the
  call. The `imported_id` checks stay on. (#175)

## 0.10.5

Rules again, and amounts. The thread running through it is a value saved as
the text it arrived as, where Actual keeps something else: a figure, a true or
a false. The rule was created, it read back correctly, and then it either
never matched anything or did the opposite of what it says. One kind takes
your next bank import down with it and brings in none of that batch.

If you wrote rules through this server before now, the section on what to look
for is the part worth reading. `get_rules` does that reading for you.

### Amounts in a currency with no decimal places (#141)

Actual stores an amount as an integer in the currency's smallest unit, and
converts using that currency's own number of decimal places. This server
always used two. In JPY, KRW and IRR, which have none, every amount was out by
a factor of a hundred in both directions: asking to spend 100 recorded 10,000,
and a real 100 came back as 1. It was not a display problem, the wrong number
was what got written.

The decimal count now comes from the budget. It is read when the connection
opens and again after each sync, so a currency changed in the app arrives with
the next sync, and the write tools re-read it before converting anything. The
count also decides how many decimals an amount is printed with, so a yen is no
longer shown as "1,000.00".

`get_transactions` had the same hundred written into its amount filters, so in
one of those currencies a bound was compared against figures a hundred times
smaller and the reply read as if the account were empty.

Budgets in any other currency are unaffected, and so is a budget with no
currency set.

### A rule about an amount (#183)

`create_rule` passed the figure through as text. A condition was refused by
the engine, which answered "Failed creating a new rule" and said nothing about
which part was wrong, so no rule about an amount could be made here at all. An
action was saved without complaint, and then every import with a transaction
matching it died on `Can't convert to integer` and brought in none of its
batch.

The figure is now read the way every other amount here is, as you would say
it: 45.50, not 4550. The reply says it back with the stored integer beside it,
because that reading is the thing that was wrong.

What is not a figure is refused by name instead of by the engine. An empty
value used to be saved as zero, which in an action set every transaction it
matched to nothing. "0x10", "1e3", ".5" and "45." are all numbers to
JavaScript and none of them is how anyone writes an amount. More decimals than
the currency has are refused rather than rounded, because rounding saves a
figure you did not write.

On an amount the operators are `is`, `isapprox`, `gt`, `gte`, `lt` and `lte`.
`isNot` is not one of them, and it was what this server's own advice offered.
Spending is negative, which the description now says: "more than 45.50 spent"
is `lt -45.50`.

### Rules about cleared and reconciled transactions (#185)

The same fault on the two fields Actual keeps as true or false. A condition
was refused outright, so a rule about a cleared transaction could not be
written here. An action was saved, and then read for its truth, which is where
it got interesting: any text that is not empty is true, so `set cleared =
"false"` marked every transaction it matched as cleared. The opposite of what
it says, on every import, with nothing reporting it. `"0"` meant true for the
same reason.

Both are read as real values now. Write `true` or `false`, and `yes`, `no`,
`1` and `0` are understood as well, in any case. Anything else is refused by
name rather than quietly meaning true. `is` is the only operator these fields
take, so "not cleared" is written `cleared is false`.

`transfer` and `parent` are refused as conditions. Actual lists them beside
`cleared` and `reconciled`, but it never hands them to a rule when one runs:
a transaction carries them under different names, so the condition is always
false. Such a rule is created, reads correctly, and does nothing on an import
or a bank sync. It would still match if you applied it by hand from the rules
page, and the refusal says so rather than telling you it can never work.

A value sent as a real boolean or a number, which is what a client does
without thinking, is accepted now instead of being refused by the schema.

### Rules that break your next import (#187)

A rule's action writes onto the transaction, so a field Actual keeps no column
for cannot be written at all. `transfer`, `parent` and `saved` were accepted
anyway, and then every import with a transaction matching the rule failed as a
whole:

    Field "transfer" does not exist on table transactions

It is not the matching row that is lost, it is the batch. Three transactions
imported with one of them matching, and none of the three arrived, so a bank
sync stops bringing anything in and nothing points back at the rule.
`category_group` was accepted too and did nothing at all: a rule that reads as
though it files transactions and has never filed one.

All four are refused now, each with the reason it is refused for. The fields a
rule can set are checked against Actual's own table rather than against a list
written here, which also means `date`, `imported_payee` and `amount` are
offered: all three worked and this server never said so.

### A rule that sets a category now says so (#190)

A transaction recorded without one came back with no mention of a category,
and a rule had given it one. It read as uncategorised, and the category turned
up later in a report, which is an expensive place to find out that a rule is
wrong. The reply names it as the rule's doing, and says so too when the rule
split the transaction instead.

On a transfer out of the budget the reply used to announce the category and
then ask for one in the same breath. It says where the transaction counts
instead.

### Schedule rules are readable (#182)

Actual writes a rule for every schedule, and all three interesting parts of it
came out unreadable: the date as `[object Object]`, the amount in cents, and
the link printing the operation twice instead of naming the schedule.

A schedule's date is described in words now: how often, on which day or
weekday, from when, until when or how many times, and whether weekends move
it. The amount is money, with the direction said, because a rule about 4,500
or more spent is stored as a positive figure and read as income without it.
The link names the schedule.

What cannot be described is shown as it is stored rather than guessed at. The
fifth Monday of the month and the days counted back from the end used to fall
through to a sentence that was wrong rather than incomplete: "every month on
Monday" for a schedule that falls in November, March and May.

### What to look for in the rules you already have

Refusing new ones does nothing for the ones already saved, and these cannot be
spotted by reading them. `get_rules` marks them, and counts them at the end
with a line saying what each kind does:

- A figure held as text, which is the one that takes your next import down.
  Both it and a correct rule print as money, so there is no telling them apart
  by eye.
- A figure held as nothing, which sets every transaction it matches to zero.
  The import succeeds, which is what makes it hard to notice.
- A word where true or false belongs, which means true whatever the word says.
  An empty value is marked too, and it means false.
- A condition Actual never runs on its own.
- An action on a field with no column, which fails every import that matches
  it, and one on a field that is not stored, which does nothing.

A rule whose value comes from a template or a formula is left alone, since
that is how the app's own editor writes some of them and the stored value is
not what it uses.

### Known, and not fixed here

- `allow_duplicate` in a batch is still all or nothing. To let one legitimate
  repeat through, it switches off the approximate checks for every row in the
  call. The `imported_id` checks stay on. (#175)
- `delete_rule` prints a rule's values as they are stored, so the confirmation
  is harder to read than the listing. (#186)
- `create_transaction` echoes the payee and notes it was given rather than
  what the rules left behind. (#184)

## 0.10.4

Rules are most of this release. Four bugs with one shape: the rule was
reported as created, it appeared in `get_rules` like any other, and it never
fired. A rule that does nothing leaves no trace of itself, so if you wrote
rules through this server before now, the section on what to look for is the
part worth reading.

### A rule on a payee now runs (#167)

Actual stores a payee in a rule by its id. `create_rule` saved the name as
typed, so `IF payee is "Amazon" THEN set category = "Groceries"` was created,
listed, and matched nothing. An action that set a payee was worse: it left the
transactions it touched pointing at a payee that does not exist.

Names are resolved to ids before the rule is saved, in conditions and in
actions. An exact name wins, whatever the case; part of a name works when only
one payee fits; a name that fits more than one is refused and the reply lists
them, rather than quietly putting the rule on "Amazon Prime". A name that
matches nothing is refused as well, in an action too, so a typo does not become
a new payee that the rule then moves transactions to. The hidden payee Actual
keeps for each account, for transfers, is not matched by name, so a rule on
"Checking" does not catch every transfer into that account.

Found and fixed by @bubbletroubles in #168, who reported #169 along the way.

### The other three fields a rule keeps by id (#170, #171)

`account` and `category_group` had the same bug, and are resolved the same way
now, in conditions and in actions. All four fields match by id or by a whole
name, because a name matched loosely in one field and strictly in another is a
difference nobody sees until a rule does something nobody asked for.

`oneOf` and `notOneOf` had never worked from here. The engine wants a list and
a single string went out, so it answered "Failed creating a new rule" and said
nothing about which part was wrong. They take a list now, each element resolved
on its own, and one unusable element refuses the whole rule rather than saving
half a list. `oneOf` on a field that cannot take a list is refused here, with
the field named, instead of by the engine.

Setting an account in an action now says what it does: it moves the
transaction to that account, which is not what everyone expects from a rule.

A closed account cannot go in a rule at all. It comes back from neither
`getAccounts()` nor a query, so naming it fails and so does its id, and the
message says to reopen the account rather than leaving you to guess.

### A text operator on a field stored by id is refused (#169)

`payee contains "Netfl"` never matched Netflix, and `payee contains "-"`
matched nearly every transaction, because what the engine compares against is
the id, and a UUID is mostly hyphens. Measured on a fresh budget: a rule keyed
on a category's name did not fire, one keyed on the first characters of its id
did, and `doesNotContain` on the name fired on everything, which is the same
fact from the side that does damage unnoticed.

`contains`, `doesNotContain` and `matches` are refused on all four fields the
engine keeps by id, and the message names the way out instead of only the
refusal. For matching a payee as text there are two fields, and neither is the
one that always works: `imported_payee` holds the text the row arrived with,
which is what someone reaching for `payee contains` usually wants and the only
one that fires on the first charge from a shop you have never seen;
`payee_name` compares against the payee's current name, once that payee
exists.

### What to look for in the rules you already have

Rules written before this release are still there, and the broken ones cannot
be spotted by reading them: the condition looks ordinary and what makes it
wrong is invisible. `get_rules` now does that reading for you.

- It reads all four id fields back as names, in lists and in actions, so a
  rule no longer comes back as a row of UUIDs.
- It marks a condition that holds a name where an id belongs, which is a rule
  that has never matched anything, and tells that apart from an id that
  resolves to nothing, which was pointing at something since deleted.
- It marks a text operator on an id field, says what it compares against and
  what to use instead, and counts them at the end, which is the part worth
  acting on in a long list.

It also stopped calling working rules broken. `category is null` fires on
transactions with no category and is shown as "(none)" rather than as the word
null; a rule on a closed account says the account can be reopened and no
longer suggests deleting anything; an id written in a different case gets its
own line with the name, because the engine compares ids exactly; and an empty
list, which matches nothing, used to print as an empty string with no warning.

### One payment, two banks, two dates (#161)

A card payment appears on both statements, as money leaving one account and
arriving at the other. 0.10.3 recognised the two sides when they were dated
the same day and the other side was already in the budget. A monthly import
produces two cases it did not cover, and both wrote the payment twice:

- The other side arrives in the same batch as an ordinary row, because the
  card statement calls it "PAYMENT RECEIVED" rather than naming an account.
- The two banks post it on different days, which is the normal case.

Both are recognised now, within a day either side, and the reply says which
rows it took to be the same movement and on which dates, so you can tell it is
wrong. Rows are paired one to one: three payments of the same amount in one
week stay three payments. `create_transfer` makes the same check before
writing.

### reconcile_account stays inside the window it names (#179)

A date range written as one object drops its upper bound in AQL, with no
error. Measured over five consecutive days, asking for the 24th to the 26th
returned the 27th as well.

`reconcile_account` used that form in both of its searches, so transactions
dated after the cutoff were offered as explanations for a difference the
compared balance does not count, and a row on another account eleven days past
the cutoff was offered first, as the most telling. The closing line counted
them too. The correct form now lives in one place, with a test over the syntax
tree that fails on the wrong shape anywhere in the source.

### Known, and not fixed here

- In a currency with no decimal places (JPY, KRW, IRR), amounts are out by a
  factor of a hundred in both directions: asking to spend 100 records 10,000,
  and a real 1,000 is reported as 10.00. Budgets in any other currency are
  unaffected. (#141)
- `allow_duplicate` in a batch is still all or nothing. To let one legitimate
  repeat through, it switches off the approximate checks for every row in the
  call. The `imported_id` checks stay on. (#175)

## 0.10.3

### Your reads now see what the Actual app sees (#126)

A server left running answered from the copy of the budget it had downloaded.
Two transactions recategorised in the app came back with their old figures
three times, until a bank sync happened to move it, and nothing said the
figures were behind.

Every read now pulls from the Actual server first. Three limits keep that from
costing a round trip on every call: a copy pulled less than a minute ago counts
as current, a read waits at most 20 seconds for the pull, and after a pull that
fails or runs past that the next minute of reads answers from the local copy
instead of trying again.

When the pull did not happen the reply says so, how old the figures are, and
why: an out of sync budget points at `repair_sync`, a refused login at your
credentials, an expired session at restarting the server. Without that, a
server that is down goes quietly back to answering with figures from hours ago.

If you run this as a process that stays up, an always on bot or a service,
there is a section in the README that covers it: "Running it for days at a
time".

### A batch can record the transfers a month of entries contains (#154)

`create_transaction` has treated a payee that names one of your accounts as a
transfer for a while. `create_transactions` refused the same row and sent you
to `create_transfer`, saying a batch could not mix transfers with ordinary
rows, which was not true. So a month of entries, where the card spending, the
payment that clears the card and a contribution that leaves the budget all
arrive together, had to be split up and sent one movement at a time.

The batch now applies the same rule, and the reply lists the rows that became
transfers at the end, with the direction and what each did to your budget.

Two checks came with it, because a transfer writes two rows:

- Reading a card payment off both statements gives two rows that are one
  movement seen from each account. Sending both used to record the payment
  twice. They are now recognised as the same movement, and a there and back on
  the same day still goes through.
- A transfer whose other side is already in the target account, imported from
  your bank, is refused before it lands on top of it, rather than leaving the
  money showing up twice.

Account names are also matched more carefully: a payee with spaces around an
account name is recognised, and two accounts whose names differ only in case
are refused rather than guessed between.

### Currency reconciliation says what it is comparing (#108)

`reconcile_currency_residual` compares against every transaction in the account
up to today, which is unchanged, and the adjustment it writes is the same
amount as before.

What is new is that it tells you how much of that figure is not marked cleared,
what the marked rows come to on their own, and what the adjustment would have
been against that. A bank statement generally shows only what has posted, so if
your account holds rows nobody has ticked off, the two figures may not be
measuring the same thing. It does not decide that for you, and nothing appears
when every row is marked.

The adjustment is now written marked as cleared.

### A correction to 0.10.2

0.10.2 said a transfer keeps its category in every case. Between two accounts
that are both outside your budget it does not: Actual discards it, because
nothing could count it. The row is there for a moment after it is written and
then the category is gone, which is why it was recorded the other way round.
Both tools now say what happens instead of claiming the category is stored.

### Known, and not fixed here

- In a currency with no decimal places (JPY, KRW, IRR), amounts are out by a
  factor of a hundred in both directions: asking to spend 100 records 10,000,
  and a real 1,000 is reported as 10.00. Budgets in any other currency are
  unaffected. (#141)
- In one batch, a payment sent as a transfer from one side and as an ordinary
  row from the other is not recognised as the same movement, and neither is one
  whose two sides are dated a day apart. (#161)

## 0.10.2

Five things that went wrong in use, and one of them changes how a transaction
is recorded, so it is worth reading before you update.

### A payee that is also an account name (#137)

Writing another account's name as the payee is how you ask for a transfer, and
that is unchanged. What changed is what happens when you also give a category.

A prepaid card topped up at a station called "Fuel Station" means there is an
account by that name and a shop by that name. Asking for
`payee: "Fuel Station", category: "Fuel"` used to move money between the two
accounts, drop the category, and leave you to delete it and start again.

Now the category decides, but only between two accounts that are both inside
your budget: there the money has not gone anywhere, so a category means you
are recording a purchase. If either account is outside the budget the money
really is crossing its edge, so it stays a transfer and keeps the category.
That covers putting money into an investment account with a category on it.

Either way, when it does make a transfer, the reply says so: which account,
which direction, and whether the money entered your budget, left it, or only
moved inside it.

### Fixes

- The duplicate check now covers transfers and split transactions. Before, only
  a plain transaction was checked, so the same transfer or the same split could
  be recorded twice with no warning. A transfer is a repeat when it is between
  the same two accounts on the same date for the same amount, and a split is
  judged on its total, which is what your bank shows. Two identical transfers
  on one day are ordinary, a withdrawal split across two operations or a card
  paid twice, so `allow_duplicate` still creates it. (#98)
- Sending two rows with the same `imported_id` in one call wrote both of them,
  while the tool promised that resending a batch could not duplicate anything.
  A bank id identifies one movement within one account, so two rows carrying it
  are refused, and `allow_duplicate` does not override that: the same id in two
  different accounts is two movements and is still written. (#143)
- `get_transactions` returned an empty list when you filtered by a category's
  id instead of its name, which reads as "this category has nothing". It takes
  either now, and when nothing matches at all it says so rather than showing an
  empty list. (#136)
- Actual reports an unknown problem opening your budget for anything it has no
  specific case for, including a sync that failed while the budget was already
  open, so the message sent people to check a file, a sync id and a password
  that were all fine. It now explains what that sentence covers, and what to do
  depends on what Actual said underneath: a wrong encryption password, an
  expired session or a damaged local copy are each named, and the server is
  pointed at only when no more specific reason came with it. Actual's own
  wording is kept after the explanation. (#142)

### Known, and not fixed here

- In a currency with no decimal places (JPY, KRW, IRR), amounts are out by a
  factor of a hundred in both directions: asking to spend 100 records 10,000,
  and a real 1,000 is reported as 10.00. Budgets in any other currency are
  unaffected. (#141)
- The duplicate check for transfers only looks at transfers. A row imported
  from your bank that was never linked to its other half is not one, so a
  transfer you create afterwards is not matched against it.

### Maintenance

- Dependency updates for Actual's library and the MCP SDK are now watched
  daily, so a release that this server cannot open is noticed here before it is
  noticed in someone's budget. (#146)

## 0.10.1

A patch release, and one that asks something of you before you install it: see
*Before you update* below. Five things that went wrong while this server was in
use, and one that is still open.

### Before you update

- **Node 22.14 or newer.** Actual's SQLite library is built against N-API 10,
  which arrives in that release; on an older Node it crashes rather than
  failing, with no message. The server now refuses to start there and says so.
  The Desktop Extension runs on the Node that Claude Desktop ships, which has
  been newer than this every time it was checked.
- **On Linux, glibc 2.34 or newer.** The SQLite library Actual uses ships a
  Linux binary that requires it, so Debian 11, Ubuntu 20.04 and RHEL 8 cannot
  run this release directly. The Docker image carries its own glibc and works
  on all of them.
- **If your Actual server is older than 26.10, update it first.** Opening your
  budget with this version migrates it to the newer format, and the next sync
  uploads that. An Actual app still on the older version can then no longer
  open it. Actual's own apps do this too when they update; the
  difference is that this one can reach your budget before you have updated
  anything else. The server now warns about this on startup, before it
  downloads anything.
- **Installing from a clone** needs Python available, or `npm ci
  --ignore-scripts`. Nothing is lost by the latter: it is what the extension
  and the Docker image already do.

### Fixes

- With Actual 26.10, the Desktop Extension could not open budgets at all: every
  tool answered `No budget file is open`, and nothing in the logs said why. The
  budget had been migrated by the newer Actual and the extension carried an
  older library, which cannot read it. This version carries Actual 26.10, so it
  opens. And when a budget cannot be opened for any reason, the server now says
  which reason and what to do about it, instead of naming a file. (#139)
- An Actual server that accepted the connection and then stopped answering held
  every write for five minutes. There is now a 60-second limit on how long this
  server waits for your Actual server to *start* replying; the reply itself can
  take as long as it needs, so a slow budget download is not cut off. Raise it with
  `ACTUAL_HTTP_TIMEOUT_MS`, or with *Server reply timeout (ms)* if you use the
  desktop extension. Worth knowing if your bank is slow: of the bank sync
  providers, GoCardless was the only one without a limit of its own, so it is
  the one this setting governs. (#99)
- Two tool calls arriving together could each act on a budget the other was
  halfway through changing. A delete and a create sent at once refused the new
  transaction as a duplicate of the row the delete had just removed; a batch
  sent beside a single create wrote the same movement twice; and a batch could
  write into an account that had just been deleted, leaving a row no account
  view can show. Every tool that changes transactions now takes its turn,
  including batches, bank syncs and deletes. One consequence to expect: while a
  bank sync runs, other writes wait for it. (#111)
- `transfer_between_categories` leaves a note on the month saying what moved,
  and it formatted the amount as though every currency had two decimal places.
  In a currency that has none, the note read a hundred times too small: moving
  10,000 was written down as 100.00. It uses the budget's own currency now.
  This was the note's wording only; in those same currencies the amount you ask
  for is still converted wrongly, which is the open bug listed below. (#115)
- `category_trends` divided one month by the next even when the sign had
  changed, so a category that stopped spending and started receiving money was
  reported as a fall of 707.5%. It now says the direction changed, in both the
  single-category and the top-categories view, and the average no longer mixes
  reimbursements in with what was spent. (#133)

### Known, and not fixed here

- In a currency with no decimal places (JPY, KRW, IRR), amounts are out by a
  factor of a hundred in both directions: asking to spend 100 records 10,000,
  and a real 1,000 is reported as 10.00. Budgets in any other currency are
  unaffected. (#141)

## 0.10.0

Most of this release comes from using the server against a real budget and
finding that it reported figures it had not checked. Several of the arithmetic
fixes below are numbers someone had already read and believed.

### New

- Compare an account against the balance your bank reports, and get back what
  might explain a difference: a charge entered twice, the amount sitting on
  another account, a row dated past the cutoff. When nothing explains it, it
  says so instead of offering a coincidence. `reconcile_account` (#85)
- Record several movements in one call. Twenty-two movements of one day used to
  be twenty-two calls, and sending them at once took the server down. Every row
  is checked before anything is written, so a batch is created whole or not at
  all. `create_transactions` (#83)
- Move budgeted money between categories, instead of two transactions that
  cancel out and stay on the card forever. `transfer_between_categories` (#86)
- Adjust a budget by saying "10,000 more" rather than working out the absolute
  figure by hand. `update_budget_amount` with `mode: "delta"` (#84)
- Rename an account without opening the Actual app. `update_account` (#87)
- Ask for a past period directly: `month` anchors the window in
  `category_trends` and `get_category_balance`, and their defaults are defaults
  rather than limits. (#90)
- Search notes and payee text, including the note on the split a transaction
  belongs to, and list the transactions that still have no category. (#81, #82)

### Fixes that change figures you may have read

- A category marked as income inside a spending group was counted as spending.
  A salary showed up in the spending breakdown, `include_income: false` did not
  exclude it, and the share column read 104.2% of a total it was inflating.
  Income is now decided per category, in every tool that asks. (#116)
- `spending_by_category` did not follow split transactions and counted accounts
  outside the budget. Both halves of a split were invisible to it, so a
  category could be missing from the report altogether. On one real month the
  gap was 35,718.22. (#130)
- Money coming in was reported as money going out: a refund was listed as under
  budget by its whole amount, projected as spending, and trended as a month of
  expense. (#131)
- Spending shares could add up to more than 100%, because a category whose net
  was positive shrank the total every other row was divided by. (#128)
- A read issued immediately after a write could answer from before it, so a
  tool could report the state it had just replaced. (#105)
- Reconciling an account that holds transactions dated after today booked the
  difference as currency drift. A weekend card purchase posted with Monday's
  date is routine here, so the tool now reports those rows and books nothing
  until told whether your bank already counts them. (#100)
- `get_budget_month` compares what the budget module reports against the
  transactions behind it, and warns when they disagree. (#80)
- A write that reports failure may already have applied. The error now says
  what to check before retrying, because the retry is what duplicates. (#79)
- Creating a transaction that matches one already on the same account, date and
  amount reports the existing one and creates nothing until told otherwise.
  (#88)
- `delete_transaction` previews what it will delete, including rows dated in the
  future, which it used to preview as nothing and delete anyway. (#103)

### Changes you may notice

- A month outside 01-12 is refused everywhere a month is accepted. `2026-13`
  used to be taken and written to a month no reader ever looks at. (#90)
- `repair_sync` refuses to run when nothing is listening at your server. A
  closed desktop app and a broken sync state fail the same way and it can only
  fix one of them. (#89)
- In `spending_by_category` the share column is now "% of spending", and a row
  that brought money in is shown without a share rather than with one. The
  footer separates spending, money in, and the net. (#128)
- `budget_vs_actual` no longer counts a category that received money into its
  under-budget total, and `spending_projection` counts categories already over
  budget, including those with nothing budgeted at all, which it used to report
  as zero at risk. (#131)

### Documentation

- The desktop extension is documented first, since it is the only route that
  needs no JSON edited, and it does not need Node installed.
- Setup for Codex and for ChatGPT, and no more pasting JSON for Cursor and VS
  Code users.
