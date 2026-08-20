import { getDatabase, saveImage, setDatabase } from "./storage/database.svelte"
import { selectSingleFile, sleep } from "./util"
import { alertError, alertStore, notifySuccess, notifyError } from "./alert"
import { AppendableBuffer, downloadFile, readImage } from "./globalApi.svelte"
import { language } from "src/lang"
import { reencodeImage } from "./process/files/inlays"
import { PngChunk } from "./pngChunk"
import { v4 } from "uuid"
import type { RisuPersona } from "./storage/database.svelte"

export async function selectPersonaImg(persona: RisuPersona): Promise<boolean> {
    const selected = await selectSingleFile(['png'])
    if (!selected) {
        return false
    }
    persona.icon = await saveImage(selected.data)
    persona.id ??= v4()
    return true
}

export async function selectUserImg() {
    const db = getDatabase()
    const persona = db.personas[db.selectedPersona]
    if (!persona || !await selectPersonaImg(persona)) return
    db.userIcon = persona.icon
    saveUserPersona()
}

export function saveUserPersona() {
    let db = getDatabase()
    const persona = db.personas[db.selectedPersona]
    if (!persona) return
    persona.name = db.username
    persona.icon = db.userIcon
    persona.personaPrompt = db.personaPrompt
    persona.note = db.userNote
}

export function changeUserPersona(id: number, save: 'save' | 'noSave' = 'save') {
    if (save === 'save') {
        saveUserPersona()
    }
    let db = getDatabase()
    const pr = db.personas[id]
    if (!pr) return
    db.personaPrompt = pr.personaPrompt
    db.username = pr.name
    db.userIcon = pr.icon
    db.userNote = pr.note
    db.selectedPersona = id
}

interface PersonaCard {
    name: string
    personaPrompt: string
    note?: string
}

export async function exportUserPersona(persona?: RisuPersona) {
    const db = getDatabase({ snapshot: true })
    const current = persona ?? db.personas[db.selectedPersona]
    if ((!current?.name) || (!current.personaPrompt)) {
        notifyError("username or persona prompt is empty")
        return
    }

    let img: Uint8Array
    if (!current.icon) {
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 256
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = 'rgb(100, 116, 139)'
        ctx.fillRect(0, 0, 256, 256)
        const dataUrl = canvas.toDataURL('image/png')
        const base64 = dataUrl.split(',')[1]
        img = new Uint8Array(Buffer.from(base64, 'base64'))
    } else {
        img = await readImage(current.icon)
    }

    let card: PersonaCard = safeStructuredClone({
        name: current.name,
        personaPrompt: current.personaPrompt,
        note: current.note,
    })

    alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing Exif)'
    })

    await sleep(10)

    img = (await PngChunk.write(await reencodeImage(img), {
        "persona": Buffer.from(JSON.stringify(card)).toString('base64')
    })) as Uint8Array

    alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing)'
    })

    await sleep(10)
    await downloadFile(`${current.name.replace(/[<>:"/\\|?*\.\,]/g, "")}_export.png`, img)

    notifySuccess(language.successExport)
}

export async function importUserPersona(target?: RisuPersona[]): Promise<RisuPersona | null> {
    try {
        const v = await selectSingleFile(['png'])
        if (!v) {
            return null
        }
        const readGenerator = PngChunk.readGenerator(v.data)
        let decoded: string | undefined;

        for await (const chunk of readGenerator) {
            if (chunk && !(chunk instanceof AppendableBuffer) && chunk.key === 'persona') {
                decoded = chunk.value
                break
            }
        }

        if (!decoded) {
            alertError(language.errors.noData)
            return null
        }
        const data: PersonaCard = JSON.parse(Buffer.from(decoded, 'base64').toString('utf-8'))
        if (data.name && data.personaPrompt) {
            const db = getDatabase()
            const imported: RisuPersona = {
                name: data.name,
                icon: await saveImage(await reencodeImage(v.data)),
                personaPrompt: data.personaPrompt,
                note: data.note,
                id: v4()
            }
            ;(target ?? db.personas).push(imported)
            notifySuccess(language.successImport)
            return imported
        } else {
            alertError(language.errors.noData)
        }
    } catch (error) {
        alertError(error)
        return null
    }
    return null
}
