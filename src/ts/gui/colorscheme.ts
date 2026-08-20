import { get, writable } from "svelte/store";
import { getDatabase, setDatabase } from "../storage/database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { BufferToText, selectSingleFile } from "../util";
import { notifyError } from "../alert";
import { isLite } from "../lite";
import { CustomCSSStore, SafeModeStore } from "../stores.svelte";
import {
    builtInColorSchemes,
    darkColorScheme,
    normalizeColorSchemeName,
    resolveBuiltInColorScheme,
} from "./colorschemePalettes";

export interface ColorScheme{
    bgcolor: string;
    darkbg: string;
    borderc: string;
    selected: string;
    draculared: string;
    textcolor: string;
    textcolor2: string;
    darkBorderc: string;
    darkbutton: string;
    primary: string;
    accentText: string;
    type:'light'|'dark';
}


export const defaultColorScheme: ColorScheme = { ...darkColorScheme }

const colorShemes = builtInColorSchemes

export const ColorSchemeTypeStore = writable('dark' as 'dark'|'light')

export const colorSchemeList = Object.keys(colorShemes) as (keyof typeof colorShemes)[]

export const colorSchemeLabels: Record<string, string> = {
    dark: "Dark",
    light: "Light",
    "pastel-pop": "Pastel Pop",
}

export function changeColorScheme(colorScheme: string){
    try {
        let db = getDatabase()
        const normalizedName = normalizeColorSchemeName(colorScheme)
        if(normalizedName !== 'custom'){
            db.colorScheme = safeStructuredClone(colorShemes[normalizedName])
        }
        db.colorSchemeName = normalizedName
        updateColorScheme()   
    } catch (error) {}
}

export function updateColorScheme(){
    try {
        let db = getDatabase()

        let colorScheme = db.colorScheme

        if(colorScheme == null){
            colorScheme = safeStructuredClone(defaultColorScheme)
        }

        const normalizedName = normalizeColorSchemeName(db.colorSchemeName)
        db.colorSchemeName = normalizedName
        colorScheme = resolveBuiltInColorScheme(normalizedName, colorScheme)
        db.colorScheme = colorScheme
        let appliedSchemeName = normalizedName

        if(get(isLite)){
            colorScheme = safeStructuredClone(darkColorScheme)
            appliedSchemeName = 'dark'
        }

        //set css variables
        document.documentElement.dataset.risuColorScheme = appliedSchemeName
        document.documentElement.style.setProperty("--risu-theme-bgcolor", colorScheme.bgcolor);
        document.documentElement.style.setProperty("--risu-theme-darkbg", colorScheme.darkbg);
        document.documentElement.style.setProperty("--risu-theme-borderc", colorScheme.borderc);
        document.documentElement.style.setProperty("--risu-theme-selected", colorScheme.selected);
        document.documentElement.style.setProperty("--risu-theme-draculared", colorScheme.draculared);
        document.documentElement.style.setProperty("--risu-theme-textcolor", colorScheme.textcolor);
        document.documentElement.style.setProperty("--risu-theme-textcolor2", colorScheme.textcolor2);
        document.documentElement.style.setProperty("--risu-theme-darkborderc", colorScheme.darkBorderc);
        document.documentElement.style.setProperty("--risu-theme-darkbutton", colorScheme.darkbutton);
        // Legacy data may lack `primary` (added later); fall back to default so
        // the toggle/CTA fill stays usable until the user picks a custom value.
        document.documentElement.style.setProperty("--risu-theme-primary", colorScheme.primary ?? defaultColorScheme.primary);
        document.documentElement.style.setProperty("--risu-theme-accenttext", colorScheme.accentText ?? colorScheme.textcolor);
        ColorSchemeTypeStore.set(colorScheme.type)
    } catch (error) {}
}

export function changeColorSchemeType(type: 'light'|'dark'){
    try {
        let db = getDatabase()
        db.colorScheme.type = type
        updateColorScheme()
        updateTextThemeAndCSS()
    } catch (error) {}
}

export function exportColorScheme(){
    let db = getDatabase()
    let json = JSON.stringify(db.colorScheme)
    downloadFile('colorScheme.json', json)
}

export async function importColorScheme(){
    const uarray = await selectSingleFile(['json'])
    if(uarray == null){
        return
    }
    const string = BufferToText(uarray.data)
    let colorScheme: ColorScheme
    try{
        colorScheme = JSON.parse(string)
        if(
            typeof colorScheme.bgcolor !== 'string' ||
            typeof colorScheme.darkbg !== 'string' ||
            typeof colorScheme.borderc !== 'string' ||
            typeof colorScheme.selected !== 'string' ||
            typeof colorScheme.draculared !== 'string' ||
            typeof colorScheme.textcolor !== 'string' ||
            typeof colorScheme.textcolor2 !== 'string' ||
            typeof colorScheme.darkBorderc !== 'string' ||
            typeof colorScheme.darkbutton !== 'string' ||
            typeof colorScheme.type !== 'string'
        ){
            notifyError('Invalid color scheme')
            return
        }
        // `primary` is optional in old export files (pre-primary-token migration).
        // Backfill from the default so a re-export round-trips with the field set.
        if(typeof colorScheme.primary !== 'string'){
            colorScheme.primary = defaultColorScheme.primary
        }
        if(typeof colorScheme.accentText !== 'string'){
            colorScheme.accentText = colorScheme.textcolor
        }
        changeColorScheme('custom')
        let db = getDatabase()
        db.colorScheme = colorScheme
        updateColorScheme()
    }
    catch(e){
        notifyError('Invalid color scheme')
        return
    
    }
}

export function updateTextThemeAndCSS(){
    let db = getDatabase()
    const root = document.querySelector(':root') as HTMLElement;
    if(!root){
        return
    }
    let textTheme = get(isLite) ? 'standard' : db.textTheme
    let colorScheme = get(isLite) ? 'dark' : db.colorScheme.type
    switch(textTheme){
        case "standard":{
            if(colorScheme === 'dark'){
                root.style.setProperty('--FontColorStandard', '#fafafa');
                root.style.setProperty('--FontColorItalic', '#8C8D93');
                root.style.setProperty('--FontColorBold', '#fafafa');
                root.style.setProperty('--FontColorItalicBold', '#8C8D93');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }else{
                root.style.setProperty('--FontColorStandard', '#0f172a');
                root.style.setProperty('--FontColorItalic', '#8C8D93');
                root.style.setProperty('--FontColorBold', '#0f172a');
                root.style.setProperty('--FontColorItalicBold', '#8C8D93');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }
            break
        }
        case "highcontrast":{
            if(colorScheme === 'dark'){
                root.style.setProperty('--FontColorStandard', '#f8f8f2');
                root.style.setProperty('--FontColorItalic', '#F1FA8C');
                root.style.setProperty('--FontColorBold', '#8BE9FD');
                root.style.setProperty('--FontColorItalicBold', '#FFB86C');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }
            else{
                root.style.setProperty('--FontColorStandard', '#0f172a');
                root.style.setProperty('--FontColorItalic', '#F1FA8C');
                root.style.setProperty('--FontColorBold', '#8BE9FD');
                root.style.setProperty('--FontColorItalicBold', '#FFB86C');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }
            break
        }
        case "custom":{
            root.style.setProperty('--FontColorStandard', db.customTextTheme.FontColorStandard);
            root.style.setProperty('--FontColorItalic', db.customTextTheme.FontColorItalic);
            root.style.setProperty('--FontColorBold', db.customTextTheme.FontColorBold);
            root.style.setProperty('--FontColorItalicBold', db.customTextTheme.FontColorItalicBold);
            root.style.setProperty('--FontColorQuote1', db.customTextTheme.FontColorQuote1 ?? '#8BE9FD');
            root.style.setProperty('--FontColorQuote2', db.customTextTheme.FontColorQuote2 ?? '#FFB86C');
            break
        }
    }

    switch(db.font){
        case "default":{
            root.style.setProperty('--risu-font-family', '"OpenAI Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif');
            break
        }
        case "timesnewroman":{
            root.style.setProperty('--risu-font-family', 'Times New Roman, serif');
            break
        }
        case "custom":{
            root.style.setProperty('--risu-font-family', db.customFont);
            break
        }
    }

    if(!get(SafeModeStore)){
        CustomCSSStore.set(db.customCSS ?? '')
    }
    else{
        CustomCSSStore.set('')
    }
}
