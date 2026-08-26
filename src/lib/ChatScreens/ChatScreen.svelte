<script lang="ts">
    import { getCustomBackground, getEmotion } from "../../ts/util";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { CharEmotion, selectedCharID, openModuleListStore } from "../../ts/stores.svelte";
    import { v4 } from 'uuid';
    import ResizeBox from './ResizeBox.svelte'
    import DefaultChatScreen from "./DefaultChatScreen.svelte";
    import defaultWallpaper from '../../etc/bg.jpg'
    import ChatList from "../Others/ChatList.svelte";
    import TransitionImage from "./TransitionImage.svelte";
    import BackgroundDom from "./BackgroundDom.svelte";
    import SideBarArrow from "../UI/GUI/SideBarArrow.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    import RisuBardSaveSlotsDialog from '../SideBars/RisuBardSaveSlotsDialog.svelte';
    import { ensureChatHydrated } from 'src/ts/storage/chatStorage';
    import { notifySuccess } from 'src/ts/alert';
    import { changeChatTo, forageStorage, requestImmediateSave } from 'src/ts/globalApi.svelte';
    import { completeMemoryWikiFork } from 'src/ts/risubard/memoryWikiFork';
    import { createMemorySaveSlot, latestChatMessageId, prepareMemorySaveLoad, type MemorySaveSlotSummary } from 'src/ts/risubard/memorySaveSlots';
    import { resolveChatTextSurface } from 'src/ts/gui/textTheme';
    let openChatList = $state(false)
    let openModuleList = $state(false)
    let saveSlotsOpen = $state(false)
    let saveSlotsMode = $state<'save' | 'load'>('load')
    let savingSlot = $state(false)
    let currentCharacter = $derived(
        $selectedCharID >= 0 ? DBState.db.characters[$selectedCharID] : undefined
    )

    function openSaveSlots(mode: 'save' | 'load'): void {
        if(savingSlot) return
        saveSlotsMode = mode
        saveSlotsOpen = true
    }

    async function saveCurrentChat(saveId?: string): Promise<MemorySaveSlotSummary> {
        const character = currentCharacter
        if(savingSlot || !character) throw new Error('현재 채팅을 저장할 수 없습니다.')
        const chatIdx = character.chatPage
        savingSlot = true
        try {
            if(character.chats[chatIdx]?._placeholder){
                await ensureChatHydrated(character.chats, chatIdx, character.chaId)
            }
            const chat = character.chats[chatIdx]
            if(!chat || chat._placeholder){
                throw new Error('채팅 전체 내용을 불러오지 못했습니다.')
            }
            if(chat.isStreaming){
                throw new Error('응답 생성이 끝난 뒤 채팅을 저장해 주세요.')
            }
            if(!character.chaId || !chat.id){
                throw new Error('채팅 저장에는 안정적인 캐릭터와 채팅 ID가 필요합니다.')
            }
            const saved = await createMemorySaveSlot({
                characterId: character.chaId,
                chat,
                saveId: saveId ?? v4(),
                overwrite: saveId !== undefined,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            notifySuccess('채팅, 변수와 Memory Wiki를 저장했습니다.')
            return saved
        }
        finally {
            savingSlot = false
        }
    }

    async function loadSavedChat(saveId: string): Promise<void> {
        const character = currentCharacter
        if(!character?.chaId) return
        const chatIdx = character.chatPage
        if(character.chats[chatIdx]?._placeholder){
            await ensureChatHydrated(character.chats, chatIdx, character.chaId)
        }
        const currentChat = character.chats[chatIdx]
        if(!currentChat?.id || currentChat._placeholder){
            throw new Error('현재 채팅 전체 내용을 불러오지 못했습니다.')
        }
        if(currentChat.isStreaming){
            throw new Error('응답 생성이 끝난 뒤 저장 파일을 불러와 주세요.')
        }
        const destinationChatId = currentChat.id
        const prepared = await prepareMemorySaveLoad({
            characterId: character.chaId,
            saveId,
            currentChat,
            destinationChatId,
            fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        })
        const loadedChat = prepared.chat
        loadedChat.id = destinationChatId
        loadedChat.isStreaming = false
        delete loadedChat.activeStreamingDisplayOptimizationMode
        delete loadedChat._placeholder
        character.chats[chatIdx] = loadedChat
        character.chats = character.chats
        try {
            await requestImmediateSave({
                forceFullWrite: true,
                rejectOnFailure: true,
            })
        }
        catch(error){
            character.chats[chatIdx] = currentChat
            character.chats = character.chats
            await completeMemoryWikiFork({
                characterId: character.chaId,
                destinationChatId,
                forkToken: prepared.forkToken,
                action: 'discard',
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            }).catch(() => undefined)
            await requestImmediateSave({
                forceFullWrite: true,
                rejectOnFailure: true,
            })
            throw error
        }
        await completeMemoryWikiFork({
            characterId: character.chaId,
            destinationChatId,
            forkToken: prepared.forkToken,
            action: 'finalize',
            fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        })
        changeChatTo(chatIdx)
        saveSlotsOpen = false
        notifySuccess('스토리 불러오기 완료', { duration: 3000 })
    }

    $effect(() => {
        if ($openModuleListStore) {
            openModuleList = true
            openModuleListStore.set(false)
        }
    })

    const wallPaper = `background: url(${defaultWallpaper})`
    const chatTextSurface = $derived(resolveChatTextSurface(DBState.db.colorScheme, DBState.db))
    const externalStyles = $derived(chatTextSurface.active ?
            ("background: " + chatTextSurface.background + ';\n')
        +   (DBState.db.textBorder ? "text-shadow: -1px -1px 0 var(--color-shadow), 1px -1px 0 var(--color-shadow), -1px 1px 0 var(--color-shadow), 1px 1px 0 var(--color-shadow);" : '')
        +   (DBState.db.textScreenRounded ? "border-radius: 2rem; padding: 1rem;" : '')
        +   (DBState.db.textScreenBorder ? `border: 0.3rem solid ${DBState.db.textScreenBorder};` : '') : '')
    let bgImg= $state('')
    let lastBg = $state('')
    $effect.pre(() => {
        (async () =>{
            if(DBState.db.customBackground !== lastBg){
                lastBg = DBState.db.customBackground
                bgImg = await getCustomBackground(DBState.db.customBackground)
            }
        })()
    });
</script>

{#snippet chatChrome()}
    <SideBarArrow />
{/snippet}

{#if DBState.db.theme === 'waifu'}
    <div class="grow h-full min-h-0 flex justify-center relative overflow-hidden" style="{bgImg.length < 4 ? wallPaper : bgImg}">
        {@render chatChrome()}
        <BackgroundDom />
        {#if $selectedCharID >= 0}
            {#if DBState.db.characters[$selectedCharID].viewScreen !== 'none'}
                <div class="h-full mr-10 flex justify-end halfw" style:width="{42 * (DBState.db.waifuWidth2 / 100)}rem">
                    <TransitionImage classType="waifu" src={getEmotion(DBState.db, $CharEmotion, 'plain')}/>
                </div>
            {/if}
        {/if}
        <div class="h-full w-2xl" style:width="{42 * (DBState.db.waifuWidth / 100)}rem" class:halfwp={$selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== 'none'}>
            <DefaultChatScreen customStyle={`${externalStyles}backdrop-filter: blur(4px);`} bind:openChatList bind:openModuleList onSaveChat={() => openSaveSlots('save')} onOpenChatLoad={() => openSaveSlots('load')} {savingSlot}/>
        </div>
    </div>
{:else if DBState.db.theme === 'waifuMobile'}
    <div class="grow h-full min-h-0 relative overflow-hidden" style={bgImg.length < 4 ? wallPaper : bgImg}>
        {@render chatChrome()}
        <BackgroundDom />
        <div class="w-full absolute z-10 bottom-0 left-0"
            class:per33={$selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== 'none'}
            class:h-full={!($selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== 'none')}
        >
            <DefaultChatScreen customStyle={`${externalStyles}backdrop-filter: blur(4px);`} bind:openChatList bind:openModuleList onSaveChat={() => openSaveSlots('save')} onOpenChatLoad={() => openSaveSlots('load')} {savingSlot}/>
        </div>
        {#if $selectedCharID >= 0}
            {#if DBState.db.characters[$selectedCharID].viewScreen !== 'none'}
                <div class="h-full w-full absolute bottom-0 left-0 max-w-full">
                    <TransitionImage classType="mobile" src={getEmotion(DBState.db, $CharEmotion, 'plain')}/>
                </div>
            {/if}
        {/if}
    </div>
{:else}
    <div class="grow h-full min-h-0 min-w-0 relative justify-center flex overflow-hidden">
        {@render chatChrome()}
        <BackgroundDom />
        <div style={bgImg} class="h-full w-full" class:max-w-6xl={DBState.db.classicMaxWidth}>
            {#if $selectedCharID >= 0}
                {#if DBState.db.characters[$selectedCharID].viewScreen !== 'none' && (!(DBState.db.characters[$selectedCharID] as import('src/ts/storage/database.svelte').character).inlayViewScreen)}
                    <ResizeBox />
                {/if}
            {/if}
            <DefaultChatScreen customStyle={externalStyles} bind:openChatList bind:openModuleList onSaveChat={() => openSaveSlots('save')} onOpenChatLoad={() => openSaveSlots('load')} {savingSlot}/>
        </div>
    </div>
{/if}
{#if openChatList}
    <ChatList close={() => {openChatList = false}}/>
{:else if openModuleList}
    <ModuleChatMenu close={() => {openModuleList = false}}/>
{/if}

{#if currentCharacter?.chaId}
    <RisuBardSaveSlotsDialog
        open={saveSlotsOpen}
        bind:mode={saveSlotsMode}
        characterId={currentCharacter.chaId}
        currentChatId={currentCharacter.chats[currentCharacter.chatPage]?.id}
        currentLatestMessageId={latestChatMessageId(
            currentCharacter.chats[currentCharacter.chatPage]?.message ?? []
        )}
        onOpenChange={(open) => { saveSlotsOpen = open }}
        onLoad={loadSavedChat}
        onSave={saveCurrentChat}
    />
{/if}

<style>
    .halfw{
        max-width: calc(50% - 5rem);
    }
    .halfwp{
        max-width: calc(50% - 5rem);
    }
    .per33{
        height: 33.333333%;
    }
</style>
