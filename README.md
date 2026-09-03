# Sync

A Paseo plugin that keeps **selected** projects in sync between two Paseo
daemons — their workspaces, git history and chat history together — so a tab
closed on one machine can be picked up on the other.

Scope is per-project and opt-in. A project you have not selected is never read,
never compared, and never touched.

Nothing is specific to a particular machine, user or OS: both endpoints describe
themselves, and every path rule is derived from what the two daemons report.

## Install

```bash
npm install
npm run typecheck
paseo plugin install "$(pwd)" --id sync
paseo plugin ls          # must show: sync  running
```

Reinstalling requires `paseo plugin remove sync` first — install refuses an id
that is already configured. `remove` clears configuration only, never source.

## Using it

1. **Peers** — add the other daemon (`user@host`, plus a key path). Sync probes
   it and reads back its paseo home, projects root and daemon user. Every path
   translation downstream derives from those answers.
2. **Projects** — tick the projects you want synced. Only projects checked out on
   *both* sides can be selected: Sync moves history between existing checkouts,
   it does not clone repositories.
3. **Preview** — pick a direction, then read exactly what would move, grouped by
   project, with byte totals and an explicit skipped-with-reason list.
4. **Run** — apply the plan you just previewed, with live per-step progress.

## How it works, and why

### Workspaces go through the API, never the file

`workspaces.json` is loaded once at daemon startup and then rewritten *wholesale*
on every mutation. There is no file watch. So editing it under a running daemon
is both invisible and doomed — the daemon's next write clobbers it.

Sync therefore creates workspaces through the daemon's own API. The cost is that
`workspace.create.request` always mints a fresh `wks_…`, so ids differ per
machine; Sync keeps its own `localId ↔ remoteId` map in
`<paseo home>/sync/state.json` instead of pretending otherwise.

### Worktree paths are recomputed, not substituted

Paseo names a worktree's directory by hashing the **absolute** repo root, so the
same repository lands under a different hash on every machine:

```
2bsdr8ws  <mac>/projects/acme-api
2i9p34za  <linux>/projects/acme-api
```

A prefix substitution — what a naive migration does — produces a path the far
daemon will never look at. `paths.server.ts` reimplements the daemon's hash and
recomputes it against the target's own repo root. Both that port and Claude's
project-folder encoder are verified against live directories on two machines.

### Chat resume actually works

Verified end to end: a closed workspace's transcript was carried across, and
resumed on the far side returning real prior conversation under its original
title, appending in place rather than forking.

Two things must be fixed in transit or the tab arrives broken:

- `persistence.metadata.mcpServers` carries a bearer token and `callerAgentId`
  scoped to the **origin** daemon's MCP endpoint. Carried verbatim, the resumed
  agent talks to the wrong daemon. Sync strips it; the receiving daemon reissues
  its own.
- `workspaceId` must name a workspace that exists locally, and `cwd` must match
  it, or the daemon refuses the import.

Claude resolves `--resume <id>` globally by session id — the encoded folder gates
discovery, not resume. Codex indexes by thread id; its dated directory is
cosmetic.

Each daemon has its own CLI install, its own credentials and, where a routing
layer is in use, its own account pool. A carried session only resumes where that provider
actually works, so the preview says so before the transfer rather than after.

### What of a workspace survives, and what does not

A workspace is recreated on the far side, not copied. `paseo import` finds or
creates a workspace for the target cwd and attaches the carried session, so the
tab that appears there is a **new** workspace that happens to hold the same
conversation.

Carried:

| | |
|---|---|
| transcript | the conversation itself, appended in place on resume |
| session record | provider, model, cwd, timestamps |
| title | via `update-workspace-title` |

**Not** carried — re-apply by hand on the receiving side:

| | |
|---|---|
| `pinnedAt` | a synced tab arrives unpinned |
| `archivedAt` | arrives un-archived, regardless of its state at the source |
| `labels` | dropped |

This is a consequence of creating workspaces through the daemon API rather than
by editing `workspaces.json` (see above). The API mints the workspace; it does
not take a pinned flag or a label set. Editing the file instead would carry all
three — and be silently clobbered by the daemon's next write, which is why Sync
does not.

Because `workspace.create.request` always mints a fresh `wks_…`, ids differ per
machine. Sync's `localId ↔ remoteId` map in `<paseo home>/sync/state.json` is
what stops a second run creating duplicate tabs instead of updating the first.

### Git moves over a direct remote, and only ever fetches

Measured on a real repository: direct SSH remote 427ms warm against 799ms for the
shared forge, and — more decisively — `ls-remote` on the direct remote exposes
branches that were never pushed, which is exactly what paseo worktree branches
are.

It is always a fetch. Pushing into a non-bare checkout is refused by git for its
checked-out branch, and typically only one side of a pair is reachable, so "the
receiving side fetches" is the only shape that works in both directions.

### Uncommitted work is carried as a stash

`git stash create` builds a commit without touching the working tree or the stash
list, so the sending side is left exactly as you had it. The receiving side gets
it via `git stash store` as an ordinary stash entry, recoverable with the normal
`git stash` commands. Every stash carried is named in the preview.

### Ownership is checked before anything is written

The daemon writes every record atomically: a dot-prefixed temp file beside the
target, then a rename. That needs write permission on the **directory**, not
just on the files in it.

A state directory owned by another uid — left by a migration run as root, or an
rsync that preserved the sending machine's owner — therefore reads perfectly and
fails *every* write:

```
EACCES: permission denied, open '~/.paseo/agents/<project>/.<id>.json.<pid>.<ts>.tmp'
```

The daemon looks healthy while silently persisting nothing. Sync probes for this
when a peer is added or re-probed and says so up front. Its own remote writes go
through `sudo -u <daemon user>`, so files it creates are owned correctly; the
check is for damage done by other tools.

The fix is a chown on the receiving side:

```bash
chown -R <daemon-user> ~/.paseo ~/.claude ~/.codex
```

Stale `.tmp` files left by the failed writes are inert and safe to delete.

### Conflicts stop, they do not resolve

If the receiving side's copy of a workspace is newer, Sync emits a conflict
instead of a step and refuses to run until you choose. Nothing is ever
overwritten because it happened to be second.

### Re-runs are cheap

`<paseo home>/sync/state.json` holds per-project cursors — transcript size and
mtime per session, last-fetched ref, file mtimes. A re-run with nothing changed
does one `ls-remote` and one metadata comparison per session, and moves zero
bytes.

## Files

| file | role |
|---|---|
| `index.ts` | contributions; the only place `*.server` bindings may appear |
| `contracts.shared.ts` | Zod RPC contracts, namespace `sync.*` |
| `peers.server.ts` | peer registry, SSH, remote introspection |
| `paths.server.ts` | path translation, worktree hash + Claude folder encoder |
| `inventory.server.ts` | one-round-trip snapshot of either daemon |
| `plan.server.ts` | the diff engine — builds a plan, moves nothing |
| `transfer.server.ts` | git, stashes, transcripts, files |
| `apply.server.ts` | executes a plan with progress |
| `state.server.ts` | id map, cursors, journal |
| `surface.client.tsx` / `ui.client.tsx` | the panel |

`.server.ts` is excluded from the client bundle. A `*.server` binding referenced
outside a bare `plugin.handle(...)` call leaves an undefined symbol that crashes
the app *after* `plugin ls` already reports the plugin running.

## Development

```bash
npm run typecheck
paseo plugin reload sync
paseo plugin logs sync
```

Never restart the daemon to pick up plugin changes — it kills running agents.

## Notes

- **Always name an SSH key.** Without one, ssh offers every key the agent holds;
  a host that refuses too many answers "Too many authentication failures" and,
  where fail2ban is watching, bans the client for its ban window. Sync passes
  `IdentitiesOnly=yes` for exactly this reason.
- Remote writes go through the daemon user, so nothing lands root-owned in a home
  the daemon then cannot read.
