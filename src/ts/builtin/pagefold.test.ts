import { beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { loadBuiltInPageFoldPlugin } from "./pagefold";

describe("built-in PageFold provider", () => {
  let builtInPageFoldPlugin: Awaited<ReturnType<typeof loadBuiltInPageFoldPlugin>>;

  beforeAll(async () => {
    builtInPageFoldPlugin = await loadBuiltInPageFoldPlugin();
  });

  test("ships the fixed API v3 provider without persisting it in user data", () => {
    expect(builtInPageFoldPlugin).toMatchObject({
      name: "pagefold",
      displayName: "PageFold (built-in)",
      version: "3.0",
      versionOfPlugin: "0.1.1",
      enabled: true,
      builtIn: true,
    });
    expect(builtInPageFoldPlugin.script).toContain("//@name pagefold");
    expect(builtInPageFoldPlugin.script).toContain("addProvider(PAGEFOLD_PROVIDER_NAME");
  });

  test("prefers save-backed storage so SQL migration includes its settings", () => {
    expect(builtInPageFoldPlugin.script).toContain(
      "api.pluginStorage ?? (typeof api.getLocalPluginStorage",
    );
  });

  test("is injected into the same provider registry used by every request mode", () => {
    const source = readFileSync("src/ts/plugins/plugins.svelte.ts", "utf8");
    expect(source).toContain("loadBuiltInPageFoldPlugin");
    expect(source).toContain("!isBuiltInPluginName(p.name)");
    expect(source).toContain("const enabledPlugins = [");
    expect(source).toContain("await loadV3Plugins(pluginV3)");

    const requestSource = readFileSync(
      "src/ts/process/request/request.ts",
      "utf8",
    );
    expect(requestSource).toContain("export async function requestChatData(");
    expect(requestSource).toContain("case LLMFormat.Plugin:");
    expect(requestSource).toContain("return requestPlugin(targ)");

    const apiSource = readFileSync(
      "src/ts/plugins/apiV3/v3.svelte.ts",
      "utf8",
    );
    expect(apiSource).toContain("trustedBuiltInPlugins.has(pluginName)");
    expect(apiSource).toContain("Object.isFrozen(plugin)");
    expect(apiSource).toContain("removeV3Providers(pluginName)");
    expect(apiSource).toContain("customV3ProviderMetaStore[existingModel] = modelData");
  });
});
