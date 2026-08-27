export interface PluginUpdateTarget {
    name: string
    updateURL?: string
}

export interface InstalledPluginSnapshot {
    name: string
    script: string
}

export interface PluginUpdateDependencies {
    fetcher: (url: string, init?: RequestInit) => Promise<Response>
    importer: (source: string, target: PluginUpdateTarget) => Promise<unknown>
    readInstalled: (name: string) => InstalledPluginSnapshot | undefined
}

export interface InstalledPluginUpdateActionDependencies {
    update: (plugin: PluginUpdateTarget) => Promise<boolean>
    reportSuccess: () => void
    reportFailure: () => void
}

// This is the action invoked by the installed-plugin row's `+` control. Keep
// reporting behind the awaited update so a duplicate/no-op import cannot look
// like a completed installation.
export async function runInstalledPluginUpdateAction(
    plugin: PluginUpdateTarget,
    dependencies: InstalledPluginUpdateActionDependencies,
): Promise<boolean> {
    try {
        const updated = await dependencies.update(plugin)
        if (updated) dependencies.reportSuccess()
        else dependencies.reportFailure()
        return updated
    } catch (error) {
        console.error('Failed to install plugin update:', error)
        dependencies.reportFailure()
        return false
    }
}

export async function runPluginUpdate(
    plugin: PluginUpdateTarget,
    dependencies: PluginUpdateDependencies,
): Promise<boolean> {
    if (!plugin.updateURL) return false

    try {
        const response = await dependencies.fetcher(plugin.updateURL, { cache: 'no-store' })
        if (!response.ok) return false

        const source = await response.text()
        const previousSource = dependencies.readInstalled(plugin.name)?.script
        await dependencies.importer(source, plugin)
        return previousSource !== source && dependencies.readInstalled(plugin.name)?.script === source
    } catch (error) {
        console.error('Failed to update plugin:', error)
        return false
    }
}
