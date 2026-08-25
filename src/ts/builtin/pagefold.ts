import pageFoldSource from "./pagefold-0.1.1-fix.js?raw";
import type { RisuPlugin } from "../plugins/plugins.svelte";

/**
 * PageFold is shipped with RisuBard instead of being copied into every user
 * database. It still runs through the API v3 sandbox, so the provider keeps
 * the same permission and isolation boundaries as an installed plugin.
 */
export const builtInPageFoldPlugin: RisuPlugin = Object.freeze({
  name: "pagefold",
  displayName: "PageFold (built-in)",
  script: pageFoldSource,
  arguments: {},
  realArg: {},
  version: "3.0",
  customLink: [],
  argMeta: {},
  versionOfPlugin: "0.1.1",
  enabled: true,
  builtIn: true,
});
