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
    expect(builtInPageFoldPlugin.script).toContain("applyPresetRoute(await storage.getItem(CONFIG_KEY), args?.pagefold_route)");
    expect(builtInPageFoldPlugin.script).not.toContain("storage.setItem(CONFIG_KEY, args?.pagefold_route");
  });

  test("keeps PDF font-size customization within save-backed packaging settings", () => {
    expect(builtInPageFoldPlugin.script).toContain("function normalizePdfFontSize(value)");
    expect(builtInPageFoldPlugin.script).toContain("config2.pdfFontSize = normalizePdfFontSize(input.pdfFontSize)");
    expect(builtInPageFoldPlugin.script).toContain('field("pdf-font-size", "PDF \\uAE00\\uC790 \\uD06C\\uAE30 (pt)"');
    expect(builtInPageFoldPlugin.script).toContain("fontSize = currentConfig.pdfFontSize");
    expect(builtInPageFoldPlugin.script).toContain("fontSize * (LINE_HEIGHT / FONT_SIZE)");
  });

  test("is injected for per-preset dispatch without appearing as a standalone model", () => {
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
    expect(requestSource).toContain("const usePageFold = preset.usePageFold === true");
    expect(requestSource).toContain("const response = await dispatchPageFoldPreset(");

    const apiSource = readFileSync(
      "src/ts/plugins/apiV3/v3.svelte.ts",
      "utf8",
    );
    expect(apiSource).toContain("trustedBuiltInPlugins.has(pluginName)");
    expect(apiSource).toContain("Object.isFrozen(plugin)");
    expect(apiSource).toContain("removeV3Providers(pluginName)");
    expect(apiSource).toContain("const exposeInModelSelector = !(plugin.builtIn && plugin.name === 'pagefold')");
    expect(apiSource).toContain("pluginV2.builtInProviders.set(providerName, registeredProvider)");

    const uiSource = readFileSync(
      "src/lib/Setting/Pages/Model/ModelPresetSettings.svelte",
      "utf8",
    );
    expect(uiSource).toContain("editingPreset.usePageFold");
    expect(uiSource).toContain("modelPresetPageFoldEnable");
    expect(uiSource).toContain("getPageFoldPresetSupport(editingPreset)");
  });
});
