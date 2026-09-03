import type { PluginContext } from "@getpaseo/plugin";
import {
  peerProbe,
  peerRemove,
  peerSave,
  peersList,
  planBuild,
  tabList,
  projectsList,
  projectsSelect,
  runCancel,
  runStart,
  runStatus,
  settingsGet,
  settingsSave,
} from "./contracts.shared";
import {
  handlePeerProbe,
  handlePeerRemove,
  handlePeerSave,
  handlePeersList,
  handlePlanBuild,
  handleTabList,
  handleProjectsList,
  handleProjectsSelect,
  handleRunCancel,
  handleRunStart,
  handleRunStatus,
  handleSettingsGet,
  handleSettingsSave,
} from "./handlers.server";
import { SyncSurface } from "./surface.client";

/**
 * This file is bundled for BOTH the daemon subprocess and the app client.
 * Paseo's compiler textually removes `*.server` imports from the client bundle,
 * so a `*.server` binding may only ever appear inside a bare `plugin.handle(...)`
 * statement — referencing one anywhere else leaves an undefined symbol that
 * crashes the app after `plugin ls` already reports the plugin as running.
 */
export default function contribute(plugin: PluginContext) {
  plugin.handle(peersList, handlePeersList);
  plugin.handle(peerSave, handlePeerSave);
  plugin.handle(peerRemove, handlePeerRemove);
  plugin.handle(peerProbe, handlePeerProbe);
  plugin.handle(projectsList, handleProjectsList);
  plugin.handle(projectsSelect, handleProjectsSelect);
  plugin.handle(planBuild, handlePlanBuild);
  plugin.handle(tabList, handleTabList);
  plugin.handle(runStart, handleRunStart);
  plugin.handle(runStatus, handleRunStatus);
  plugin.handle(runCancel, handleRunCancel);
  plugin.handle(settingsGet, handleSettingsGet);
  plugin.handle(settingsSave, handleSettingsSave);

  plugin.addSurface("sync", SyncSurface);
  plugin.addSidebarItem({ id: "sync", title: "Sync", icon: "RefreshCw", surface: "sync" });

  return () => {};
}
