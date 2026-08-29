# Safe write mode

Status: approved, not yet implemented
Target release: 0.8.0 (breaking)

## Problem

The server exposes 23 write tools with no confirmation step and no way to turn
them off. Every other finance MCP of comparable maturity does the opposite:
s-stefanov ships read-only and takes `--enable-write`, oliverames hides its
write tools from discovery unless `YNAB_ALLOW_WRITES=1`, Intuit's QuickBooks
server carries `DISABLE_WRITE/UPDATE/DELETE` kill switches, and type0labs makes
deletes a two-step call. Being the outlier here is a real gap for a server that
holds someone's finances, and the MCP specification names exactly this as the
mitigation against prompt injection.

Two things make it concrete rather than theoretical:

- `delete_category` destroys the category's budget and rollover history. Actual
  cannot undo it, and the loss is not obvious until a later month is reviewed.
- #44 showed this server can corrupt financial data while reporting success. The
  lesson there was that a guard has to live in one place or it gets forgotten;
  the same reasoning applies to confirmation.

Today `delete_account` is the only tool with any guardrail. It is inconsistent
that deleting an account takes two deliberate steps while deleting a category —
which silently takes the budget with it — takes one.

## Decisions

**The default does not change.** All 37 tools stay exposed exactly as they are
today. Making the server read-only by default would match the segment leaders,
but it breaks every current user at once and silently: the agent simply reports
that a tool does not exist. Writing is the point of this server.

**Safety ships on by default only where damage is irreversible** — the deletes.
A confirmation step costs an agent nothing and is the part that actually closes
the gap. The read-only flag is the complement for people who want it.

**Binary, not graduated.** A middle `no-delete` level was considered and
rejected: once deletes require explicit two-step confirmation by default, that
level adds almost nothing and costs a third code path to maintain and test.

## Design

### 1. Read-only mode (opt-in)

`src/utils/mode.ts` exports `isReadOnly()`, the single place that reads
`ACTUAL_READ_ONLY`. `registerAllTools` skips the write block when it returns
true. The aggregator is already split into Read / Analysis / Write sections, so
this is a conditional around an existing block.

Hidden tools are not registered at all, rather than registered and refused. An
agent cannot be talked into calling a tool it cannot see; a tool that exists and
says no still burns context and invites retries.

Two deliberate exceptions:

- **`repair_sync` stays visible.** It does not touch budget data — it repairs
  sync state. Hiding it would leave the server unusable with no way out in
  exactly the situation that motivated #41, where the budget goes out of sync
  and every other tool starts failing.
- **`run_bank_sync` is hidden.** It pulls new transactions in, which is a write.

Concretely: 22 of the 23 write tools are hidden, leaving 15 tools exposed
(9 read + 5 analysis + `repair_sync`) instead of 37.

On startup the server writes one line to **stderr** (never stdout, which carries
JSON-RPC) naming the mode and how many write tools are hidden.

The README's tool count and the `--verify` output both need updating to describe
the mode.

### 2. Confirmation on the remaining deletes (on by default)

The shape of the guard follows how the target is identified:

| tool | guard | reasoning |
|---|---|---|
| `delete_category`, `delete_category_group`, `delete_payee` | preview + `confirm` + `confirm_name` | resolved **by name**, which is where the real risk lives: "delete Adicionales" resolving to "Ingresos Adicionales" |
| `delete_transaction`, `delete_rule` | preview + `confirm` | identified by **exact id**; there is no ambiguity for `confirm_name` to catch, so requiring it would be empty ceremony |

The first call always previews and deletes nothing. Each preview states what
would be lost:

- **category** — transactions affected, an explicit warning that budget and
  rollover history go with it, and a pointer to the `transfer_to` parameter the
  tool already has as the non-destructive path.
- **category group** — the categories inside it.
- **payee** — how many transactions reference it.
- **transaction** — date, payee, amount, and whether it is a split parent or
  child (deleting a split parent removes its children too).
- **rule** — what the rule does, since a rule is unreadable from its id alone.

### 3. One shared helper

`delete_account` implements the pattern inline. Copying it five times recreates
the condition that caused #44: a guard that the next tool's author forgets. The
pattern moves to `src/utils/confirm.ts` and `delete_account` migrates onto it.

The helper owns: the "preview until confirmed" decision, the `confirm_name`
mismatch rejection, and the shape of the preview block. Each tool supplies what
it is deleting and what would be lost.

## Testing

Per tool: preview deletes nothing; `confirm` deletes; a wrong `confirm_name` is
rejected and deletes nothing. Plus one test asserting that with
`ACTUAL_READ_ONLY` set the write tools are **not registered** — the actual
security property, rather than that they refuse when called.

## Out of scope

`dry_run` on bulk operations (there are no batch tools yet), session backup and
audit log (gap #4 in the market analysis, its own piece of work), and
`update_rule`.

## Release

0.8.0. The delete guards are a breaking change for anyone calling those tools
unattended: a single call now previews instead of deleting. The release notes
must say so plainly and show the two-call form.
