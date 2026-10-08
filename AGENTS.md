# Working on Sync

Use the official split Paseo plugin SDK: `index.server.ts` registers handlers, `index.client.tsx` registers the native surface, `shared/` contains runtime-neutral contracts. Never introduce a local SDK declaration shim.

`server/worker.ts` runs both locally and over SSH. `scripts/build.mjs` generates the committed `shared/worker-source.ts`. Run `npm run prepare` after any worker change and include the generated file in the commit. This keeps Git installs independent of npm preparation.

Use Paseo CLI/API operations to create workspaces, import agents, and archive sources. Agent registry files may be read for persistence handles, but must never be written. Provider credentials and MCP configuration do not transfer. Child CLI calls scrub originating agent scope, daemon password, and Codex thread IDs.

A transfer must use a new destination. Preserve staged/unstaged changes and verify files, Git HEAD/index, native transcripts, imports, and registration. Archive a source only after verification and a fresh source checksum. Never remove a source yourself. Preserve a registered partial target after failure.

Run `npm run verify`. For provider or import changes, run `npm run test:live` with authenticated provider CLIs; use isolated homes, clean them afterward, and never print credentials. The SSH fixture uses a temporary loopback server and pins its host key. `scripts/ui-preview.tsx` renders the actual component with fixture RPC responses.

Use host theme tokens and cross-platform React Native controls. Test desktop and compact layouts. Reload only this plugin (`paseo plugin reload sync`); restarting the main daemon kills active agents.
