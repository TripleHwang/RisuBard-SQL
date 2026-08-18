<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { v4 } from "uuid";
    import Sortable from 'sortablejs/modular/sortable.core.esm.js';
    import { DownloadIcon, PencilIcon, HardDriveUploadIcon, MenuIcon, TrashIcon, SplitIcon, FolderPlusIcon, BookmarkCheckIcon, PackageIcon, CopyIcon, LoaderCircleIcon, PlusIcon, ChevronRightIcon } from "@lucide/svelte";

    import type { Chat, ChatFolder, character } from "src/ts/storage/database.svelte";
    import { newChatModelDefaults } from "src/ts/storage/database.svelte";
    import { ensureChatHydrated } from "src/ts/storage/chatStorage";
    import { DBState, ReloadGUIPointer } from 'src/ts/stores.svelte';
    import { selectedCharID, chatDeselected } from "src/ts/stores.svelte";

    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import ShButton from "../UI/GUI/ShButton.svelte";
    import SolarAssetIcon from "../UI/Icons/SolarAssetIcon.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import feedIcon from "src/assets/solar-bold/feed-bold.svg";
    import loadIcon from "src/assets/solar-bold/undo-left-square-bold.svg";

    import { exportChat, importChat, exportAllChats } from "src/ts/characters";
    import { alertConfirm, alertError, alertInput, alertSelect, alertStore, notifySuccess, notifyError } from "src/ts/alert";
    import { findCharacterbyId, sleep, sortableOptions } from "src/ts/util";

    import { bookmarkListOpen, openModuleListStore } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import Toggles from "./Toggles.svelte";
    import PersonaBind from "./PersonaBind.svelte";
    import PromptBind from "./PromptBind.svelte";
    import ModelBind from "./ModelBind.svelte";
    import RisuBardSaveSlotsDialog from "./RisuBardSaveSlotsDialog.svelte";
    import { changeChatTo, createChatCopyName, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { forageStorage } from "src/ts/globalApi.svelte";
    import { completeMemoryWikiFork, forkMemoryWiki } from "src/ts/risubard/memoryWikiFork";
    import {
        createMemorySaveSlot,
        prepareMemorySaveLoad,
    } from "src/ts/risubard/memorySaveSlots";

    interface Props {
        chara: character;
    }

    let { chara = $bindable() }: Props = $props();
    let editMode = $state(false)

    // Safety net: chats whose folderId references a deleted folder would
    // otherwise be invisible (excluded from both the no-folder section and
    // any folder section). Render them in the no-folder section instead.
    // The server-side fix prevents new orphans; this guard rescues existing
    // ones until boot-time normalize touches the disk.
    const validFolderIds = $derived(
        new Set((chara.chatFolders ?? []).map(f => f.id).filter(Boolean))
    )
    const isOrphanFolder = (folderId: string | null | undefined): boolean =>
        folderId != null && !validFolderIds.has(folderId)

    let chatsStb: Sortable[] = []
    let folderStb: Sortable = null

    let folderEles: HTMLDivElement = $state()
    let listEle: HTMLDivElement = $state()
    let sorted = $state(0)
    let opened = 0
    let saveSlotsOpen = $state(false)
    let savingSlot = $state(false)
    let chatListExpanded = $state(false)
    const activeChat = $derived(chara.chats[chara.chatPage])

    function createNewChat(): void {
        const newChat = {
            message: [] as any[],
            note: '',
            name: `New Chat ${chara.chats.length + 1}`,
            localLore: [] as any[],
            fmIndex: -1,
            id: v4(),
            ...newChatModelDefaults(),
        }
        chara.chats.unshift(newChat)
        chara.chats = chara.chats
        changeChatTo(0)
        void requestImmediateSave()
        $ReloadGUIPointer += 1
    }

    async function renameCurrentChat(): Promise<void> {
        if(!activeChat) return
        const nextName = await alertInput(
            `${language.edit} ${language.Chat}`,
            [],
            activeChat.name,
        )
        if(!nextName?.trim()) return
        activeChat.name = nextName.trim()
        chara.chats = chara.chats
        void requestImmediateSave()
    }

    async function deleteCurrentChat(): Promise<void> {
        if(!activeChat) return
        if(chara.chats.length === 1){
            notifyError(language.errors.onlyOneChat)
            return
        }
        const confirmed = await alertConfirm(
            `${language.removeConfirm}${activeChat.name}`
        )
        if(!confirmed) return
        const index = chara.chats.indexOf(activeChat)
        if(index < 0) return
        chara.chats.splice(index, 1)
        chara.chats = chara.chats
        changeChatTo(0)
        $ReloadGUIPointer += 1
        void requestImmediateSave()
    }

    async function saveCurrentChat(): Promise<void> {
        if(savingSlot) return
        const chatIdx = chara.chatPage
        if(chara.chats[chatIdx]?._placeholder){
            await ensureChatHydrated(chara.chats, chatIdx, chara.chaId)
        }
        const chat = chara.chats[chatIdx]
        if(!chat || chat._placeholder){
            notifyError('채팅 전체 내용을 불러오지 못했습니다.')
            return
        }
        if(chat.isStreaming){
            notifyError('응답 생성이 끝난 뒤 채팅을 저장해 주세요.')
            return
        }
        if(!chara.chaId || !chat.id){
            notifyError('채팅 저장에는 안정적인 캐릭터와 채팅 ID가 필요합니다.')
            return
        }
        savingSlot = true
        try {
            await createMemorySaveSlot({
                characterId: chara.chaId,
                chat,
                saveId: v4(),
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            notifySuccess('채팅, 변수와 Memory Wiki를 저장했습니다.')
        }
        catch(error){
            notifyError(
                `채팅 저장 실패: ${error instanceof Error
                    ? error.message
                    : String(error)}`
            )
        }
        finally {
            savingSlot = false
        }
    }

    async function loadSavedChat(saveId: string): Promise<void> {
        const destinationChatId = v4()
        const prepared = await prepareMemorySaveLoad({
            characterId: chara.chaId,
            saveId,
            destinationChatId,
            fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        })
        const loadedChat = prepared.chat
        loadedChat.id = destinationChatId
        loadedChat.name = `${loadedChat.name} (Load)`
        loadedChat.isStreaming = false
        delete loadedChat.activeStreamingDisplayOptimizationMode
        delete loadedChat._placeholder
        chara.chats.unshift(loadedChat)
        chara.chats = chara.chats
        try {
            await requestImmediateSave({
                forceFullWrite: true,
                rejectOnFailure: true,
            })
        }
        catch(error){
            chara.chats.splice(chara.chats.indexOf(loadedChat), 1)
            chara.chats = chara.chats
            await completeMemoryWikiFork({
                characterId: chara.chaId,
                destinationChatId,
                forkToken: prepared.forkToken,
                action: 'discard',
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            }).catch(() => undefined)
            void requestImmediateSave({ forceFullWrite: true })
            throw error
        }
        await completeMemoryWikiFork({
            characterId: chara.chaId,
            destinationChatId,
            forkToken: prepared.forkToken,
            action: 'finalize',
            fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        })
        changeChatTo(0)
        saveSlotsOpen = false
        notifySuccess('세이브를 새 채팅으로 불러왔습니다.')
    }

    async function copyChatWithMemory(chat: Chat): Promise<void> {
        const confirmed = await alertConfirm(
            `${language.copyChatConfirm}${chat.name}`
        )
        if(!confirmed) return
        const chatIdx = chara.chats.indexOf(chat)
        if(chara.chats[chatIdx]?._placeholder){
            await ensureChatHydrated(
                chara.chats,
                chatIdx,
                (chara as character).chaId
            )
        }
        const sourceChat = chara.chats[chatIdx]
        if(sourceChat?._placeholder){
            alertError('Failed to load chat data.')
            return
        }
        if(!sourceChat?.id || !(chara as character).chaId){
            alertError('Memory Wiki copy requires stable chat and character IDs.')
            return
        }
        const newChat = $state.snapshot(sourceChat)
        newChat.name = createChatCopyName(newChat.name, 'Copy')
        newChat.id = v4()
        try {
            const forkReceipt = await forkMemoryWiki({
                characterId: (chara as character).chaId,
                sourceChatId: sourceChat.id,
                destinationChatId: newChat.id,
                mode: 'copy',
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            chara.chats.unshift(newChat)
            chara.chats = chara.chats
            try {
                await requestImmediateSave({
                    forceFullWrite: true,
                    rejectOnFailure: true,
                })
            }
            catch(error) {
                chara.chats.splice(chara.chats.indexOf(newChat), 1)
                chara.chats = chara.chats
                let cleanupError: unknown
                try {
                    await completeMemoryWikiFork({
                        characterId: (chara as character).chaId,
                        destinationChatId: newChat.id,
                        forkToken: forkReceipt.forkToken,
                        action: 'discard',
                        fetchImpl: fetch,
                        createAuth: () => forageStorage.createAuth(),
                    })
                }
                catch(discardError) {
                    cleanupError = discardError
                }
                void requestImmediateSave({ forceFullWrite: true })
                if(cleanupError){
                    throw new Error(
                        `${error instanceof Error ? error.message : String(error)}; `
                        + `Memory Wiki cleanup failed: ${cleanupError instanceof Error
                            ? cleanupError.message
                            : String(cleanupError)}`
                    )
                }
                throw error
            }
            try {
                await completeMemoryWikiFork({
                    characterId: (chara as character).chaId,
                    destinationChatId: newChat.id,
                    forkToken: forkReceipt.forkToken,
                    action: 'finalize',
                    fetchImpl: fetch,
                    createAuth: () => forageStorage.createAuth(),
                })
            }
            catch(error){
                alertError(
                    `Chat copy was saved, but Memory Wiki finalization failed: `
                    + `${error instanceof Error ? error.message : String(error)}`
                )
                return
            }
            changeChatTo(0)
            notifySuccess(language.copyChatSuccess)
        }
        catch(error){
            alertError(
                `Memory Wiki copy failed: ${error instanceof Error
                    ? error.message
                    : String(error)}`
            )
        }
    }

    const createStb = () => {
        for (let chat of listEle.querySelectorAll('.risu-chat')) {
            chatsStb.push(new Sortable(chat, {
                group: 'chats',
                onEnd: async (event) => {
                    const currentChatPage = chara.chatPage
                    const newChats: Chat[] = []

                    // const chats: HTMLElement = event.to
                    // chats.querySelectorAll()
                    
                    listEle.querySelectorAll('[data-risu-chat-folder-idx]').forEach(folder => {
                        const folderIdx = parseInt(folder.getAttribute('data-risu-chat-folder-idx'))
                        folder.querySelectorAll('[data-risu-chat-idx]').forEach(chatInFolder => {
                            const chatIdx = parseInt(chatInFolder.getAttribute('data-risu-chat-idx'))
                            const newChat = chara.chats[chatIdx]
                            newChat.folderId = chara.chatFolders[folderIdx].id
                            newChats.push(newChat)
                        })
                    })

                    listEle.querySelectorAll('[data-risu-chat-idx]').forEach(chatEle => {
                        const idx = parseInt(chatEle.getAttribute('data-risu-chat-idx'))
                        const newChat = chara.chats[idx]
                        if (newChats.includes(newChat) == false) {
                            if (newChat.folderId != null)
                                newChat.folderId = null
                            newChats.push(newChat)
                        }
                    })

                    changeChatTo(newChats.indexOf(chara.chats[currentChatPage]))
                    chara.chats = newChats

                    try {
                        this.destroy()
                    } catch (e) {}
                    sorted += 1
                    await sleep(1)
                    createStb()
                },
                ...sortableOptions
            }))
        }
        folderStb = Sortable.create(folderEles, {
            group: 'folders',
            onEnd: async (event) => {
                const newFolders: ChatFolder[] = []
                const newChats: Chat[] = []
                const folders: HTMLElement[] = Array.from<HTMLElement>(event.to.children)

                const currentChatPage = chara.chatPage

                folders.forEach(folder => {
                    const folderIdx = parseInt(folder.getAttribute('data-risu-chat-folder-idx'))
                    newFolders.push(chara.chatFolders[folderIdx])

                    folder.querySelectorAll('[data-risu-chat-idx]').forEach(chatEle => {
                        const idx = parseInt(chatEle.getAttribute('data-risu-chat-idx'))
                        newChats.push(chara.chats[idx])
                    })
                })

                listEle.querySelectorAll('[data-risu-chat-idx]').forEach(chatEle => {
                    const idx = parseInt(chatEle.getAttribute('data-risu-chat-idx'))
                    if (newChats.includes(chara.chats[idx]) == false) {
                        newChats.push(chara.chats[idx])
                    }
                })
                
                chara.chatFolders = newFolders
                changeChatTo(newChats.indexOf(chara.chats[currentChatPage]))
                chara.chats = newChats
                try {
                    folderStb.destroy()
                } catch (e) {}
                sorted += 1
                await sleep(1)
                createStb()
            },
            ...sortableOptions
        })
    }

    onMount(createStb)

    onDestroy(() => {
        if (folderStb) {
            try {
                folderStb.destroy()
            } catch (error) {}
        }
        chatsStb.map(stb => {
            try {
                stb.destroy()
            } catch (error) {}
        })
    })
</script>
<div class="flex flex-col w-full">
    <section class="border-b border-darkborderc pb-2">
        <div data-chat-file-header class="flex min-h-10 items-center gap-1">
            <button
                type="button"
                data-chat-list-toggle
                aria-expanded={chatListExpanded}
                class="risu-button-lift flex min-w-0 grow items-center gap-1.5 rounded-md px-1.5 py-2 text-left text-textcolor hover:bg-selected/60"
                onclick={() => { chatListExpanded = !chatListExpanded }}
            >
                <ChevronRightIcon
                    size={17}
                    class={`shrink-0 transition-transform duration-150 ${chatListExpanded ? 'rotate-90' : ''}`}
                />
                <span class="truncate font-semibold">{activeChat?.name ?? language.newChat}</span>
            </button>

            <div data-chat-file-toolbar class="flex shrink-0 items-center gap-2">
                <ShButton data-risubard-save-chat variant="soft-primary" size="icon" className="relative" disabled={savingSlot} aria-label="현재 채팅 저장" title="현재 채팅을 저장된 파일로 보관" onclick={() => void saveCurrentChat()}>
                    <span aria-hidden="true" class="pointer-events-none absolute top-[2px] left-1/2 -translate-x-1/2 text-[8px] font-semibold leading-none tracking-[0.08em] text-textcolor/75">SAVE</span>
                    {#if savingSlot}
                        <span class="mt-2"><LoaderCircleIcon size={18} class="animate-spin" /></span>
                    {:else}
                        <span class="mt-2"><SolarAssetIcon src={feedIcon} name="feed-bold" size={22} /></span>
                    {/if}
                </ShButton>
                <ShButton data-risubard-load-chat variant="soft-primary" size="icon" className="relative" aria-label="채팅 불러오기" title="저장된 채팅 파일 열기" onclick={() => { saveSlotsOpen = true }}>
                    <span aria-hidden="true" class="pointer-events-none absolute top-[2px] left-1/2 -translate-x-1/2 text-[8px] font-semibold leading-none tracking-[0.08em] text-textcolor/75">LOAD</span>
                    <span class="mt-2"><SolarAssetIcon src={loadIcon} name="undo-left-square-bold" size={22} /></span>
                </ShButton>
            </div>
        </div>
    </section>

    <div class:hidden={!chatListExpanded}>
        <div data-chat-list-toolbar class="flex items-center gap-0.5 border-b border-darkborderc py-1.5">
            <ShButton data-sidebar-new-chat variant="ghost" size="icon-sm" aria-label={language.newChat} title={language.newChat} onclick={createNewChat}>
                <PlusIcon size={18} />
            </ShButton>
            <ShButton variant="ghost" size="icon-sm" aria-label={language.edit} title={language.edit} onclick={() => void renameCurrentChat()}>
                <PencilIcon size={18} />
            </ShButton>
            <ShButton variant="ghost" size="icon-sm" aria-label={language.copy} title={language.copy} onclick={() => { if(activeChat) void copyChatWithMemory(activeChat) }}>
                <CopyIcon size={18} />
            </ShButton>
            <ShButton variant="destructive" size="icon-sm" aria-label={language.remove} title={language.remove} onclick={() => void deleteCurrentChat()}>
                <TrashIcon size={18} />
            </ShButton>
            <ShButton variant="ghost" size="icon-sm" aria-label={language.download} title={language.download} onclick={exportAllChats}>
                <DownloadIcon size={18} />
            </ShButton>
            <ShButton variant="ghost" size="icon-sm" aria-label={language.import} title={language.import} onclick={importChat}>
                <HardDriveUploadIcon size={18} />
            </ShButton>
            <span class="mx-1 h-4 w-px bg-darkborderc"></span>
            <ShButton variant="ghost" size="icon-sm" aria-label="Branches" title="Branches" onclick={() => { alertStore.set({ type: 'branches', msg: '' }) }}>
                <SplitIcon size={18} />
            </ShButton>
            <ShButton variant="ghost" size="icon-sm" aria-label="Bookmarks" title="Bookmarks" onclick={() => { $bookmarkListOpen = true }}>
                <BookmarkCheckIcon size={18} />
            </ShButton>
            <ShButton variant="ghost" size="icon-sm" className="ml-auto" aria-label="New folder" title="New folder" onclick={() => {
                chara.chatFolders ??= []
                chara.chatFolders.unshift({
                    id: v4(),
                    name: `New Folder ${chara.chatFolders.length + 1}`,
                    folded: false,
                })
                chara.chatFolders = chara.chatFolders
                $ReloadGUIPointer += 1
            }}>
                <FolderPlusIcon size={18} />
            </ShButton>
        </div>

        {#key sorted}
        <div class="flex flex-col mt-1 overflow-y-auto max-h-80" bind:this={listEle}>
        <!-- folder div -->
        <div class="flex flex-col" bind:this={folderEles}>
            <!-- chat folder -->
            {#each chara.chatFolders as folder, i}
            <div data-risu-chat-folder-idx={i}
                class="flex flex-col mb-2 border-solid border-1 border-darkborderc cursor-pointer rounded-md">
                <!-- folder header -->
                <button 
                    onclick={() => {
                        if(!editMode) {
                            chara.chatFolders[i].folded = !folder.folded
                            $ReloadGUIPointer += 1
                        }
                    }}
                    class="flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
                    class:bg-red-900={folder.color === 'red'}
                    class:bg-yellow-900={folder.color === 'yellow'}
                    class:bg-green-900={folder.color === 'green'}
                    class:bg-blue-900={folder.color === 'blue'}
                    class:bg-indigo-900={folder.color === 'indigo'}
                    class:bg-purple-900={folder.color === 'purple'}
                    class:bg-pink-900={folder.color === 'pink'}
                >
                    {#if editMode}
                        <TextInput bind:value={chara.chatFolders[i].name} className="grow min-w-0" padding={false}/>
                    {:else}
                        <span>{folder.name}</span>
                    {/if}
                    <div class="grow flex justify-end">
                        <div role="button" tabindex="0" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                e.currentTarget.click()
                            }
                        }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={async (e) => {
                            e.stopPropagation()
                            const sel = parseInt(await alertSelect([language.changeFolderColor, language.cancel]))
                            switch (sel) {
                                case 0:
                                    const colors = ["red","green","blue","yellow","indigo","purple","pink","default"]
                                    const sel = parseInt(await alertSelect(colors))
                                    folder.color = colors[sel]
                                    break
                            }
                        }}>
                            <MenuIcon size={18}/>
                        </div>
                        <div role="button" tabindex="0" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                e.currentTarget.click()
                            }
                        }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={() => {
                            editMode = !editMode
                        }}>
                            <PencilIcon size={18}/>
                        </div>
                        <div role="button" tabindex="0" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                e.currentTarget.click()
                            }
                        }} class="text-textcolor2 hover:text-red-400 cursor-pointer" onclick={async (e) => {
                            e.stopPropagation()
                            const d = await alertConfirm(`${language.removeConfirm}${folder.name}`)
                            if (d) {
                                $ReloadGUIPointer += 1
                                const folders = chara.chatFolders
                                folders.splice(i, 1)
                                chara.chats.forEach(chat => {
                                    if (chat.folderId == folder.id) {
                                        chat.folderId = null
                                    }
                                })
                                chara.chatFolders = folders
                            }
                        }}>
                            <TrashIcon size={18}/>
                        </div>
                    </div>
                </button>
                <!-- chats in folder -->
                <div class="risu-chat flex flex-col w-full text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md {folder.folded ? 'hidden' : ''}">
                    {#if chara.chats.filter(chat => chat.folderId == chara.chatFolders[i].id).length == 0}
                    <span class="no-sort flex justify-center text-textcolor2">Empty</span>
                    <div></div>
                    {:else}
                    {#each chara.chats.filter(chat => chat.folderId == chara.chatFolders[i].id) as chat}
                    {@const chatIdx = chara.chats.indexOf(chat)}
                    <button data-chat-list-row data-risu-chat-idx={chatIdx} onclick={() => {
                        if(!editMode){
                            changeChatTo(chatIdx)
                        }
                    }} class="risu-chats flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"class:bg-selected={chatIdx === chara.chatPage && !$chatDeselected}>
                        <span class="truncate">{chat.name}</span>
                    </button>
                    {/each}
                    {/if}
                </div>
            </div>
            {/each}
        </div>
        <!-- chat without folder div -->
        <div class="risu-chat flex flex-col">
            {#each chara.chats as chat, i}
            {#if chat.folderId == null || isOrphanFolder(chat.folderId)}
            <button data-chat-list-row data-risu-chat-idx={i} onclick={() => {
                if(!editMode){
                    changeChatTo(i)
                }
            }}
            class="flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
            class:bg-selected={i === chara.chatPage && !$chatDeselected}>
                <span class="truncate">{chat.name}</span>
            </button>
            {/if}
            {/each}
        </div>
    </div>
    {/key}
    </div>

    <div class="border-t border-selected mt-2">
        {#if DBState.db.characters[$selectedCharID]?.chaId !== '§playground' && !$chatDeselected}
            {#if DBState.db.showModelInSidebar}
                <ModelBind />
            {/if}
            {#if DBState.db.showPresetInSidebar}
                <PromptBind />
            {/if}
            {#if DBState.db.showPersonaInSidebar}
                <PersonaBind />
            {/if}
            <Toggles bind:chara={chara} noContainer />
            <ShButton className="w-full mt-2" onclick={() => {
                const char = DBState.db.characters[$selectedCharID]
                if (!char) return
                char.chats[char.chatPage].modules ??= []
                openModuleListStore.set(true)
            }}>
                <PackageIcon size={16} class="shrink-0" />
                <span class="truncate">{language.modules}</span>
            </ShButton>
        {/if}
    </div>
</div>

<RisuBardSaveSlotsDialog
    open={saveSlotsOpen}
    characterId={chara.chaId}
    onOpenChange={(open) => { saveSlotsOpen = open }}
    onLoad={loadSavedChat}
/>
