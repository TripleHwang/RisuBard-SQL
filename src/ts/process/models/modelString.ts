import { getDatabase, getCurrentChat } from "src/ts/storage/database.svelte";
import { resolveChatModelBinding } from "../request/modelPresetBinding";

export function getGenerationModelString(name?:string){
    const db = getDatabase()
    // Keep the initial display label on the same regime/binding resolution as
    // the request dispatcher, including global preset/legacy mode locks.
    if(name === undefined){
        const binding = resolveChatModelBinding(getCurrentChat(), 'model')
        if(binding.kind === 'modelPreset') return binding.preset.name
    }
    switch (name ?? db.aiModel){
        case 'reverse_proxy':
            return 'custom-' + (db.reverseProxyOobaMode ? 'ooba' : db.customProxyRequestModel)
        case 'openrouter':
            return 'openrouter-' + db.openrouterRequestModel
        case 'nanogpt': {
            const modelLabel = db.nanogptRequestModelName || db.nanogptRequestModel
            return 'NanoGPT ' + modelLabel + (db.nanogptUseSubscriptionEndpoint ? ' [SUB]' : '')
        }
        default:
            return name ?? db.aiModel
    }
}
