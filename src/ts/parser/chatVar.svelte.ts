import { get } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import { parseKeyValue } from '../util'

export function getChatVar(key:string): string {
    const selectedChar = get(selectedCharID)
    const char = DBState.db.characters[selectedChar]
    if(!char){
        return 'null'
    }
    const chat = char.chats[char.chatPage]
    chat.scriptstate ??= {}
    const state = (chat.scriptstate['$' + key])
    if(state === undefined || state === null){
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(DBState.db.templateDefaultVariables))
        const findResult = defaultVariables.find((f) => {
            return f[0] === key
        })
        if(findResult){
            return findResult[1]
        }
        return 'null'
    }
    return state.toString()
}

export function setChatVar(key:string, value:string): void {
    const selectedChar = get(selectedCharID)
    if(!DBState.db.characters[selectedChar].chats[DBState.db.characters[selectedChar].chatPage].scriptstate){
        DBState.db.characters[selectedChar].chats[DBState.db.characters[selectedChar].chatPage].scriptstate = {}
    }
    DBState.db.characters[selectedChar].chats[DBState.db.characters[selectedChar].chatPage].scriptstate['$' + key] = value
}

export function getGlobalChatVar(key:string): string {
    const localValue = getGLChatVar(key)
    if(localValue !== undefined){
        return localValue
    }
    return DBState.db.globalChatVariables[key] ?? 'null'
}

function getCurrentChatForVars() {
    const selectedChar = get(selectedCharID)
    const char = DBState.db.characters[selectedChar]
    return char?.chats?.[char.chatPage]
}

export function getGLChatVar(key:string): string | undefined {
    return getCurrentChatForVars()?.GLGlobalVariables?.[key]
}

export function setGLChatVar(key:string, value:string): boolean {
    const chat = getCurrentChatForVars()
    if(!chat) return false
    chat.GLGlobalVariables ??= {}
    if(chat.GLGlobalVariables[key] === value) return false
    chat.GLGlobalVariables[key] = value
    return true
}

export function setGlobalChatVar(key:string, value:string): boolean {
    const chat = getCurrentChatForVars()
    if(chat?.useLocallySetGlobalVariables){
        return setGLChatVar(key, value)
    }
    if(chat?.GLGlobalVariables && key in chat.GLGlobalVariables){
        delete chat.GLGlobalVariables[key]
    }
    DBState.db.globalChatVariables ??= {}
    if(DBState.db.globalChatVariables[key] === value) return false
    DBState.db.globalChatVariables[key] = value
    return true
}

export function isLocallyHandledGlobalChatVar(key:string): boolean {
    return getGLChatVar(key) !== undefined
}

export function removeLocallyHandledGlobalChatVar(key:string): boolean {
    const chat = getCurrentChatForVars()
    if(!chat?.GLGlobalVariables || !(key in chat.GLGlobalVariables)) return false
    delete chat.GLGlobalVariables[key]
    return true
}
