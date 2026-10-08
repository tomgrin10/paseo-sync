# Sync

Sync is a Paseo plugin for developers who want to continue a workspace on another host. Tom requested a maintained replacement for paseo-plugin-sync, updated to current Paseo, simplified using current features, tested with real transfers, and described in the same concise style as his other plugins.

The primary task is selecting a source workspace, a receiving host and new directory, previewing the transfer, then copying or moving. Copy preserves the source. Move archives it only after verification. Git history, local changes, and Claude/Codex conversations travel together. This is a one-shot transfer, not continuous synchronization.

The plugin runs inside Paseo on desktop, web, iOS, and Android. SSH transport targets Linux/macOS environments. It inherits Paseo's theme and app chrome. Loading, no available workspaces, SSH failure, stale previews, active agents, occupied destinations, verification failure, and partial transfer are explicit product states.
