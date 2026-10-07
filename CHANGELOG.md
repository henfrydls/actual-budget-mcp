# Changelog

## 0.10.1

A patch release, and one that asks something of you before you install it: see
*Before you update* below. Five things that went wrong while this server was in
use, and one that is still open.

### Before you update

- **Node 22.14 or newer.** Actual's SQLite library is built against N-API 10,
  which arrives in that release; on an older Node it crashes rather than
  failing, with no message. The server now refuses to start there and says so.
  The Desktop Extension is unaffected — it uses the Node Claude Desktop ships.
- **On Linux, glibc 2.34 or newer.** Actual's Linux binary requires it, so
  Debian 11, Ubuntu 20.04 and RHEL 8 cannot run this release directly. The
  Docker image carries its own and works on all of them.
- **If your Actual server is older than 26.10, update it first.** Opening your
  budget with this version migrates it to the newer format, and the next sync
  uploads that — after which an Actual app still on the older version can no
  longer open it. Actual's own apps do this too when they update; the
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
