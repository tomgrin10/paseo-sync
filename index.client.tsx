import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SyncSurface } from "./client/surface";
export default function contribute(client: PluginClientContext) {
  const surface = client.addSurface("sync", SyncSurface);
  const sidebar = client.addSidebarItem({
    id: "sync",
    title: "Sync",
    icon: "ArrowRightLeft",
    surface: "sync",
  });
  return () => {
    sidebar();
    surface();
  };
}
