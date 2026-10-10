# Changelog

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
