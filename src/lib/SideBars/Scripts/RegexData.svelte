<script lang="ts">
    import { onDestroy } from "svelte";
    import { TriangleAlertIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { ReloadGUIPointer } from "src/ts/stores.svelte";
    import { alertConfirm } from "src/ts/alert";
    import type { customscript } from "src/ts/storage/database.svelte";
    import Check from "../../UI/GUI/CheckInput.svelte";
    import TextInput from "../../UI/GUI/TextInput.svelte";
    import TextAreaInput from "../../UI/GUI/TextAreaInput.svelte";
    import SelectInput from "../../UI/GUI/SelectInput.svelte";
    import OptionInput from "../../UI/GUI/OptionInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
  import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
  import { defaultScriptFlag, findUnknownScriptFlagActions, normalizeScriptFlag, scriptFlagContains, toggleScriptFlag, tryCompileScriptRegex } from "src/ts/process/scriptFlags";

interface Props {
    value: customscript;
    onRemove?: () => void;
    onClose?: () => void;
    onOpen?: () => void;
    idx: number;
  }

  let {
    value = $bindable(),
    onRemove = () => {},
    onClose = () => {},
    onOpen = () => {},
    idx
  }: Props = $props();

    // Both of these delegate to src/ts/process/scriptFlags.ts so the editor and the
    // script runner agree on where a <tag> ends and a RegExp flag letter begins.
    // Toggling used to edit the raw string, so turning a letter off deleted the
    // first matching character *inside* a tag: "<cbs>s" -> "<cb>s",
    // "<move_top>m" -> "<ove_top>m". The action then silently became unknown, and
    // since the free-text flag box below is commented out there was no way back.
    const checkFlagContain = (flag:string, matchFlag:string) => {
        return scriptFlagContains(matchFlag, flag)
    }

    const toggleFlag = (flag:string) => {
        value.flag = toggleScriptFlag(value.flag, flag)
    }

    // A script whose pattern cannot compile is dropped at render time forever and
    // silently. Surface it here, where it can actually be fixed.
    const regexError = $derived.by(() => {
        if(!value.in){
            return null
        }
        const flag = value.ableFlag ? normalizeScriptFlag(value.flag) : defaultScriptFlag
        const compiled = tryCompileScriptRegex(value.in, flag)
        if(compiled.error){
            return `Invalid regex /${value.in}/${flag} — ${compiled.error.message}`
        }
        return null
    })

    // Saves written before the toggle fix can carry a tag with a letter chewed
    // out of it (<cb>, <ove_top>). Guessing the intent back is not safe, so the
    // tag is reported rather than rewritten.
    const unknownActions = $derived(value.ableFlag ? findUnknownScriptFlagActions(value.flag) : [])

    const flagWarning = $derived(unknownActions.length === 0
        ? null
        : `Unknown flag action ${unknownActions.map((a) => `<${a}>`).join(', ')} — this does nothing. Remove it or pick the intended flag below.`)

    const scriptBroken = $derived(regexError !== null || flagWarning !== null)

    const getOrder = (flag:string) => {
        const order = flag.match(/<order (-?\d+)>/)?.[1]
        if(order === undefined || order === null){
            return 0
        }
        return parseInt(order)
    }

    const changeOrder = (order:number) => {
        if(value.flag.includes('<order')){
            value.flag = value.flag.replace(/<order (-?\d+)>/, `<order ${order}>`)
        }
        else{
            value.flag += `<order ${order}>`
        }
    }

    const flags = [
        //Vanila JS flags
        ['Global (g)', 'g'],
        ['Case Insensitive (i)', 'i'],
        ['Multi Line (m)', 'm'],
        ['Unicode (u)', 'u'],
        ['Dot All (s)', 's'],

        //Custom flags
        ['Move Top', '<move_top>'],
        ['Move Bottom', '<move_bottom>'],
        ['Repeat Back', '<repeat_back>'],
        ['IN CBS Parsing', '<cbs>'],
        ['No Newline Subfix', '<no_end_nl>'],
    ]

    let open = $state(false)

    // Single point that balances onOpen. Covers every way this row can go away:
    // deletion, the parent's array being swapped wholesale (character/preset/module
    // switch), and parent unmount. Without it an open row leaks the list's counter
    // and drag reordering stays dead with no UI left to close.
    onDestroy(() => {
        if(open){
            onClose()
        }
    })
</script>

<div class="w-full flex flex-col pt-2 mt-2 border-t border-t-selected first:pt-0 first:mt-0 first:border-0" data-risu-idx={idx}>
    <div class="flex items-center transition-colors w-full ">
        <button class="endflex valuer border-borderc" onclick={() => {
            open = !open
            if(open){
                onOpen()
            }
            else{
                onClose()
            }
        }}>
            <span>{value.comment.length === 0 ? 'Unnamed Script' : value.comment}</span>
            {#if scriptBroken}
                <!-- Visible while the row is collapsed too, so a broken script can be
                     found without opening every entry in the list. -->
                <span class="ml-2 flex items-center text-red-500" title={regexError ?? flagWarning}>
                    <TriangleAlertIcon size={16} />
                </span>
            {/if}
        </button>
        <button class="valuer" onclick={async () => {
            const d = await alertConfirm(language.removeConfirm + value.comment)
            if(d){
                // The each block is keyed, so this removes exactly this row and
                // onDestroy above settles the counter.
                onRemove()
            }
        }}>
            <XIcon />
        </button>
    </div>
    {#if open}
        <div class="seperator p-2">
            <span class="text-textcolor mt-6">{language.name}</span>
            <TextInput className="mt-2" bind:value={value.comment} onchange={(e) => {
                $ReloadGUIPointer += 1
            }} />
            <span class="text-textcolor mt-4">Modification Type</span>
            <SelectInput className="mt-2 mb-4" bind:value={value.type} onchange={(e) => {
                $ReloadGUIPointer += 1
            }}>
                <OptionInput value="editinput">{language.editInput}</OptionInput>
                <OptionInput value="editoutput">{language.editOutput}</OptionInput>
                <OptionInput value="editprocess">{language.editProcess}</OptionInput>
                <OptionInput value="editdisplay">{language.editDisplay}</OptionInput>
                <OptionInput value="edittrans">{language.editTranslationDisplay}</OptionInput>
                <OptionInput value="disabled">{language.disabled}</OptionInput>
            </SelectInput>
            <span class="text-textcolor mt-6">IN:</span>
            <TextInput className="mt-2" bind:value={value.in} />
            {#if regexError}
                <span class="text-red-500 text-sm mt-1 break-all">{regexError}</span>
            {/if}
            <span class="text-textcolor mt-6">OUT:</span>
            <TextAreaInput className="mt-2 mb-4" highlight autocomplete="off" bind:value={value.out} onInput={(e) => {
                $ReloadGUIPointer += 1
            }} />
            {#if value.ableFlag}
                <!-- <span class="text-textcolor mt-6">FLAG:</span>
                <TextInput bind:value={value.flag} /> -->
                <Accordion styled name="FLAGS">
                    {#if flagWarning}
                        <span class="text-red-500 text-sm break-all">{flagWarning}</span>
                    {/if}
                    <span class="text-textcolor mt-3">Normal Flag</span>
                    <div class="grid w-full grid-cols-2 rounded-md border border-darkborderc">
                        {#each flags as flag, i}
                            <button class="w-full bg-darkbg border-darkborderc text-sm py-1"
                                class:border-r-1={i % 2 === 0}
                                class:border-b-1={i < flags.length - 2}
                                class:text-textcolor2={!checkFlagContain(flag[1], value.flag)}
                                class:text-textcolor={checkFlagContain(flag[1], value.flag)}
                                onclick={() => {
                                    toggleFlag(flag[1])
                                }}
                            >
                                <span>{flag[0]}</span>
                                </button>     
                        {/each}
                    </div>

                    <span class="text-textcolor mt-3">Order Flag</span>
                    <NumberInput className="mt-2" value={getOrder(value.flag)} onChange={(e)=>{
                        changeOrder(parseInt(e.currentTarget.value))
                    }} />
                    
                </Accordion>
            {/if}
            <div class="flex items-center mt-4">
                <Check bind:check={value.ableFlag} onChange={() => {
                    if(!value.flag){
                        value.flag = 'g'
                    }
                }}/>
                <span>Custom Flag</span>
            </div>
       </div>
    {/if}
</div>

<style>
    .valuer:hover{
        color: rgba(16, 185, 129, 1);
        cursor: pointer;
    }

    .endflex{
        display: flex;
        flex-grow: 1;
        cursor: pointer;
    }

    .seperator{
        border: none;
        outline: 0;
        width: 100%;
        display: flex;
        flex-direction: column;
        margin-bottom: 0.5rem;
    }
    
</style>