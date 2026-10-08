# Changelog

## 1.0.0

- Rebuild for Paseo 0.11 with separate client/server entries and the official SDK.
- Discover SSH aliases and online Tailscale peers without a plugin peer/password registry.
- Copy or move one workspace with Git history, staged/unstaged changes, and native Claude/Codex conversations.
- Register workspaces and import agents through Paseo; stop writing daemon registry files and calculating internal path hashes.
- Refuse occupied destinations, session collisions, changed previews, running agents, unsupported conversations, and unsafe paths.
- Verify destination contents before archiving a moved source.
- Add isolated-daemon, Git, SSH, plugin-runtime, and real-provider resume verification.
