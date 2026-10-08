# Sync

Copy or move Paseo workspaces between hosts, with Git history, local changes, and agent conversations.

![Paseo 0.11+](https://img.shields.io/badge/Paseo-0.11%2B-blue)
![MIT](https://img.shields.io/badge/license-MIT-green)

## Install

```sh
paseo plugin install git:tomgrin10/paseo-sync
```

Requires Linux/macOS hosts (or WSL), Paseo **0.11.0 or newer**, Node **22 or newer**, and Git on both hosts. The destination must have the provider CLI and its own credentials for every conversation being transferred. Enable Paseo plugins if you have not already.

Only the host whose Sync screen you open needs the plugin. The other host needs a running Paseo daemon and SSH access as its daemon user. Sync uses each host's local Paseo credential; there is no daemon-password setup.

## Use

Open **Sync** in the sidebar. Choose a direction, an SSH host, and one workspace. Host suggestions come from your SSH config and online Tailscale peers; Paseo's saved host list is not exposed to plugins in 0.11. SSH aliases, custom users, ports, and keys work through your existing SSH config. Connect with normal `ssh` once to trust a new host's key.

Choose a **new directory** on the receiving host, then **Preview transfer**. The preview shows the destination, file count, conversation count, and bytes. If the source changes, preview again.

- **Copy** keeps the source workspace open.
- **Move** verifies the destination, checks that the source has not changed, then archives the source workspace through Paseo. Paseo may remove a managed worktree when archiving it. Moving a managed worktree with Git-ignored files is refused because those files are not carried; use Copy instead.

Stop running agents before transferring. A copy is an independent checkout, including when the source is a worktree. You can keep working on either machine afterward; this plugin does not continuously reconcile changes.

## What transfers

| Content              | Behavior                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Git history          | Local branches, tags, and the selected HEAD, including unpushed commits.                                         |
| Working tree         | Tracked files, staged and unstaged changes, non-ignored untracked files, executable bits, and internal symlinks. |
| Claude conversations | Native transcripts and saved subagent transcripts; the destination imports them through Paseo.                   |
| Codex conversations  | Native rollout files; the destination imports them through Paseo.                                                |
| Names and labels     | Workspace name and agent titles, labels, and archived state.                                                     |
| Directory workspaces | Plain files; `.git`, `node_modules`, `.venv`, and `__pycache__` directories are excluded.                        |

Git-ignored files such as `.env`, dependencies, provider credentials, daemon credentials, repository config/hooks, terminals, schedules, workspace pins, and provider-specific launch settings stay on the source. Imported agents use the target host's provider configuration. Conversation text stays intact; only structural `cwd` fields are translated.

Unsupported providers or missing saved conversations block the transfer rather than silently dropping history. Submodules, repositories without a commit, Git subdirectory workspaces, unmerged Git indexes, escaping symlinks, and snapshots above **128 MiB / 20,000 files** are not supported.

## Verification and recovery

Sync refuses an occupied destination or an existing native session ID. It verifies file bytes, modes, symlinks, Git HEAD, staged changes, transcript bytes, agent imports, and workspace registration. It never overwrites an existing checkout or edits Paseo's workspace/agent registry files.

A failure before workspace registration removes the new destination. A failure after registration preserves the partial destination for recovery and reports its path. The source stays open. If archiving fails or the source changes during a move, the verified destination remains available and the source stays open. Plugin reloads clear preview/status state; check both hosts before retrying a transfer interrupted by reload.

Transfers use SSH with normal host-key verification. Git bundles travel over the same connection, so the receiving host does not need reverse SSH access. Previews retain only metadata and a checksum, not workspace contents.

## Development

```sh
npm ci
npm run verify
npm run test:live
npx tsx scripts/ui-preview.tsx
paseo plugin install "$PWD"
paseo plugin reload sync
```

`npm run verify` typechecks and runs integration tests with two isolated Paseo daemons, real temporary Git repositories, and an encrypted SSH fixture. `npm run test:live` additionally compiles/loads the plugin, exercises a real plugin RPC, creates small Claude and Codex conversations, transfers them over SSH, and resumes both on the target to verify recall. It requires locally authenticated provider CLIs; its temporary homes and credential copies are removed afterward. The UI preview uses representative fixture RPC responses.

Paseo builds the split `index.server.ts` and `index.client.tsx` entries. `npm run prepare` regenerates the committed Node worker used over SSH; no plugin or npm dependencies need to be installed on the receiving host. Reload the plugin to pick up changes; do not restart your main daemon.

## Attribution

Rebuilt from [itsjustanks/paseo-plugin-sync](https://github.com/itsjustanks/paseo-plugin-sync), under its original MIT license. This version replaces the 0.6-era peer registry, password storage, path hashes, and direct registry writes with the current plugin SDK, Paseo CLI operations, and verified workspace snapshots.
