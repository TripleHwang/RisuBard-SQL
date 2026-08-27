import { get } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import { parseKeyValue } from '../util'

function getSelectedChat() {
    const selectedChar = get(selectedCharID)
    const char = DBState.db.characters[selectedChar]
    return char?.chats?.[char.chatPage]
}

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

export function setChatVar(key:string, value:string): boolean {
    const selectedChar = get(selectedCharID)
    const chat = DBState.db.characters[selectedChar].chats[DBState.db.characters[selectedChar].chatPage]
    chat.scriptstate ??= {}
    const stateKey = '$' + key
    if(chat.scriptstate[stateKey] === value){
        return false
    }
    chat.scriptstate[stateKey] = value
    return true
}

export function getGlobalChatVar(key:string): string {
    if(localGlobalVarsEnabled()){
        const localValue = getGLChatVar(key)
        if(localValue !== undefined){
            return localValue
        }
    }
    return DBState.db.globalChatVariables[key] ?? 'null'
}

function localGlobalVarsEnabled(): boolean {
    const chat = getSelectedChat()
    return !DBState.db.disableToggleBinding && chat?.useLocallySetGlobalVariables === true
}

export function getGLChatVar(key:string): string | undefined {
    const chat = getSelectedChat()
    if(!chat?.GLGlobalVariables || !Object.hasOwn(chat.GLGlobalVariables, key)) return undefined
    return chat.GLGlobalVariables[key]
}

export function setGLChatVar(key:string, value:string): boolean {
    const chat = getSelectedChat()
    if(!chat) return false
    chat.GLGlobalVariables ??= {}
    if(chat.GLGlobalVariables[key] === value) return false
    chat.GLGlobalVariables[key] = value
    return true
}

export function setGlobalChatVar(key:string, value:string): boolean {
    if(localGlobalVarsEnabled()){
        return setGLChatVar(key, value)
    }
    if(!DBState.db.disableToggleBinding){
        const chat = getSelectedChat()
        if(chat?.GLGlobalVariables && Object.hasOwn(chat.GLGlobalVariables, key)){
            delete chat.GLGlobalVariables[key]
        }
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
    const chat = getSelectedChat()
    if(!chat?.GLGlobalVariables || !Object.hasOwn(chat.GLGlobalVariables, key)) return false
    delete chat.GLGlobalVariables[key]
    return true
}
