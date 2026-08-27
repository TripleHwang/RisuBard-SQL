<script lang="ts">
    import type { character, Message, StreamingDisplayOptimizationMode } from 'src/ts/storage/database.svelte';
    import { mount, onDestroy, tick, unmount } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, selectedCharID, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { scrollWithinContainer } from './scrollWithin';
    import { estimateSpacerHeight, getChatWindow, restoreMessageAnchor } from 'src/ts/chatWindow';
    import { updateRuntimeResources } from 'src/ts/performance/performanceReport';
    
    const getCurrentChatRoomId = () => {
        const charId = get(selectedCharID);
        if (charId < 0) return null;
        const char = DBState.db.characters[charId];
        if (!char) return null;
        return char.chats?.[char.chatPage]?.id ?? null;
    };

    let {
        messages,
        currentCharacter,
        onReroll,
        onNextSwipe = () => {},
        unReroll,
        onDeleteSwipe = () => {},
        onConfirmMemory = async () => false,
        onUndoCanonical = async () => false,
        currentUsername,
        userIcon,
        pageStart = 0,
        pageEnd = messages.length,
        // Task 8's SaverModeCoordinator owns the reactive source and will pass
        // this hook; no saver store exists yet, so normal mode is the default.
        saverMode = false,
        userIconPortrait,
        hasNewUnreadMessage = $bindable(false)
    }:{
        messages: Message[]
        currentCharacter: character
        onReroll: () => void
        onNextSwipe?: () => void
        unReroll: () => void
        onDeleteSwipe?: () => void
        onConfirmMemory?: (messageId: string) => Promise<boolean>
        onUndoCanonical?: (
            messageId: string,
            documentId?: string
        ) => Promise<boolean>
        currentUsername: string
        userIcon: string
        // These define the locally loaded range, not a user-visible page.
        pageStart?: number
        pageEnd?: number
        saverMode?: boolean
        userIconPortrait?: boolean
        hasNewUnreadMessage?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    let messageHost: HTMLDivElement;
    type ChatInstance = {
        updateStreamingDisplay?: (state: {
            isOptimizedStreamingMessage: boolean
            streamingOptimizationMode: StreamingDisplayOptimizationMode
            rawStreamingText: string
        }) => void
    }
    type MountedChat = { instance: ChatInstance, element: HTMLDivElement, signature: string }
    let mountInstances: Map<string, MountedChat> = new Map();
    let measuredRowHeights: number[] = [];
    let windowAnchor = $state(-1);
    let windowKey = $state('');

    function getDomLimit(): 60 | 40 {
        return saverMode ? 40 : 60;
    }

    function getBoundedDomWindow() {
        const anchor = Math.max(0, Math.min(messages.length - 1, windowAnchor < 0 ? messages.length - 1 : windowAnchor));
        return getChatWindow({
            total: messages.length,
            anchorIndex: anchor,
            limit: getDomLimit(),
        });
    }

    export const revealOlderMessages = async (): Promise<boolean> => {
        if (!chatBody || !messageHost) return false;
        const currentWindow = getBoundedDomWindow();
        if (currentWindow.start <= 0) return false;

        const scroller = chatBody.parentElement as HTMLElement | null;
        const scrollerRect = scroller?.getBoundingClientRect();
        const firstVisible = scroller && scrollerRect
            ? Array.from(messageHost.querySelectorAll<HTMLElement>('[data-chat-id]'))
                .map((element) => ({ element, top: element.getBoundingClientRect().top }))
                .filter(({ element }) => element.getBoundingClientRect().bottom >= scrollerRect.top)
                .sort((left, right) => left.top - right.top)[0]
            : undefined;
        const anchor = firstVisible?.element.dataset.chatId
            ? { id: firstVisible.element.dataset.chatId, top: firstVisible.top }
            : null;

        // Center the next window on the old first row. This shifts by half a
        // window while retaining that row as a stable viewport anchor.
        windowAnchor = currentWindow.start;
        await tick();
        if (scroller && anchor) {
            const restored = messageHost.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(anchor.id)}"]`);
            restoreMessageAnchor(scroller, anchor, restored);
        }
        return true;
    }

    export const revealNewerMessages = async (): Promise<boolean> => {
        if (!chatBody || !messageHost) return false;
        const currentWindow = getBoundedDomWindow();
        if (currentWindow.end >= messages.length) return false;
        windowAnchor = Math.min(messages.length - 1, currentWindow.end);
        await tick();
        return true;
    }

    export const revealMessage = async (index: number): Promise<boolean> => {
        if (!chatBody || index < 0 || index >= messages.length) return false;
        windowAnchor = index;
        await tick();
        return true;
    }

    function stableMessageId(message: Message): string {
        // Legacy imported rows receive their durable identity before becoming a
        // mounted owner; there is no mutable-index identity fallback.
        message.chatId ??= crypto.randomUUID();
        return message.chatId;
    }

    const updateChatBody = () => {
        if(!chatBody){
            return
        }

        if (!messageHost) return;
        const currentIds = new Set<string>();
        let nextRow: Element | null = null;
        const charImage = getCharImage(currentCharacter.image, 'css')
        const userImage = getCharImage(userIcon, 'css')
        const simpleChar = createSimpleCharacter(currentCharacter);
        const currentChat = currentCharacter.chats?.[currentCharacter.chatPage]
        const configuredPerformanceMode = DBState.db.streamingDisplayOptimizationMode ?? 'off';
        const performanceMode = currentChat?.isStreaming
            ? currentChat.activeStreamingDisplayOptimizationMode ?? configuredPerformanceMode
            : configuredPerformanceMode
        const activeStreamingIndex = performanceMode !== 'off' && currentChat?.isStreaming
            ? messages.length - 1
            : -1
        const domLimit = getDomLimit();
        let domWindow = getBoundedDomWindow();
        // A live stream stays mounted even when the user has paged away from its tail.
        if (currentChat?.isStreaming && activeStreamingIndex >= 0 && (activeStreamingIndex < domWindow.start || activeStreamingIndex >= domWindow.end)) {
            const end = messages.length;
            const start = Math.max(0, end - domLimit);
            domWindow = { start, end, beforeCount: start, afterCount: 0 };
        }
        const loadStart = domWindow.end - 1
        const loadEnd = domWindow.start
        measuredRowHeights = Array.from(messageHost.querySelectorAll('[data-chat-row]'))
            .map((element) => (element as HTMLElement).getBoundingClientRect().height)
            .filter(height => height > 0);
        const spacerHeight = (count: number) => estimateSpacerHeight(measuredRowHeights, count);
        const afterSpacer = chatBody.querySelector('[data-chat-spacer="after"]') as HTMLElement | null;
        const beforeSpacer = chatBody.querySelector('[data-chat-spacer="before"]') as HTMLElement | null;
        if (afterSpacer) afterSpacer.style.height = `${spacerHeight(domWindow.afterCount)}px`;
        if (beforeSpacer) beforeSpacer.style.height = `${spacerHeight(domWindow.beforeCount)}px`;
        // Find the last real (non-comment, non-disabled) char message index
        // Only show reroll if it's the actual last non-disabled message
        let lastRealCharIdx = -1;
        let lastNonDisabledIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i].isComment && !messages[i].disabled) {
                lastNonDisabledIdx = i;
                break;
            }
        }
        if (lastNonDisabledIdx >= 0 && messages[lastNonDisabledIdx].role === 'char') {
            lastRealCharIdx = lastNonDisabledIdx;
        }

        const reloadPointerMap = get(ReloadChatPointer);

        for(let i=loadStart ; i >= loadEnd; i--){
            if(i < 0) break; // Prevent out of bounds
            const message = messages[i];
            const messageLargePortrait = message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false);
            const messageId = stableMessageId(message);
            const reloadPointer = reloadPointerMap[messageId] ?? 0;
            const isRerollTarget = i === lastRealCharIdx;
            const activeStreamingMessage = i === activeStreamingIndex && message.role === 'char';
            const hashMessageData = activeStreamingMessage ? '' : message.data;
            const signature = `${hashMessageData}|${messageLargePortrait}|${message.disabled}|${reloadPointer}|${message.swipeId ?? 0}|${message.swipes?.length ?? 0}|${isRerollTarget}|${message.risubardMemoryConfirmed ?? false}|${JSON.stringify(message.risubardCanonicalReceipt ?? null)}`;
            currentIds.add(messageId);
            const mounted = mountInstances.get(messageId);
            if (!mounted || mounted.signature !== signature) {
                if (mounted) {
                    unmount(mounted.instance);
                    mounted.element.remove();
                    mountInstances.delete(messageId);
                }
                const b = document.createElement('div');
                b.setAttribute('data-chat-row', messageId);
                b.setAttribute('data-chat-id', messageId);
                b.classList.add('chat-message-container');
                const swipes = message.swipes;
                const swipeId = message.swipeId ?? 0;
                const inst = mount(Chat, {
                    target: b,
                    props: {
                        message: message.data,
                        isLastMemory: false,
                        idx: i,
                        messageId,
                        totalLength: messages.length,
                        img: message.role === 'user' ? userImage : charImage,
                        onReroll: onReroll,
                        onNextSwipe: i === lastRealCharIdx ? onNextSwipe : () => {},
                        unReroll: unReroll,
                        onDeleteSwipe: i === lastRealCharIdx ? onDeleteSwipe : () => {},
                        onConfirmMemory,
                        onUndoCanonical,
                        memoryConfirmed:
                            message.risubardMemoryConfirmed === true,
                        canonicalReceipt: message.risubardCanonicalReceipt,
                        rerollIcon: i === lastRealCharIdx ? 'force' : false,
                        character: simpleChar,
                        largePortrait: message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false),
                        messageGenerationInfo: message.generationInfo,
                        role: message.role,
                        name: message.role === 'user' ? currentUsername : currentCharacter.name,
                        isComment: message.isComment ?? false,
                        disabled: message.disabled ?? false,
                        isOptimizedStreamingMessage: activeStreamingMessage,
                        streamingOptimizationMode: performanceMode,
                        rawStreamingText: message.data,
                        ...(i === lastRealCharIdx ? {
                            currentPage: (swipeId ?? 0) + 1,
                            totalPages: swipes?.length ?? 1,
                        } : {}),
                    },

                })
                mountInstances.set(messageId, { instance: inst, element: b, signature });
                if(nextRow){
                    messageHost.insertBefore(b, nextRow.nextSibling);
                }
                else{
                    messageHost.prepend(b);
                }
            }
            else{
                mounted.instance.updateStreamingDisplay?.({
                    isOptimizedStreamingMessage: activeStreamingMessage,
                    streamingOptimizationMode: performanceMode,
                    rawStreamingText: message.data,
                })
            }
            nextRow = mountInstances.get(messageId)?.element ?? nextRow;
        }

        for (const [id, mounted] of mountInstances) {
            if (!currentIds.has(id)) {
                unmount(mounted.instance);
                mounted.element.remove();
                mountInstances.delete(id);
            }
        }
        updateRuntimeResources({ mountedMessages: mountInstances.size });
    };

    onDestroy(() => {
        console.log('Unmounting Chats');
        mountInstances.forEach((inst) => {
            unmount(inst);
        });
        mountInstances.clear();
        updateRuntimeResources({ mountedMessages: 0 });
    })

    function checkIfAtBottom() {
        if (!chatBody || !chatBody.parentElement || !messageHost) return true;
        const sc = chatBody.parentElement;
        const lastEl = messageHost.firstElementChild;
        if (!lastEl) return true;
        const rect = lastEl.getBoundingClientRect();
        const scRect = sc.getBoundingClientRect();
        return rect.top <= scRect.bottom + 100;
    }

    export const showLatestMessage = async (): Promise<void> => {
        if(!chatBody || !messageHost) return;
        windowAnchor = Math.max(0, messages.length - 1);
        await tick();
        const latestId = messages.at(-1) ? stableMessageId(messages.at(-1)!) : '';
        const element = latestId
            ? messageHost.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(latestId)}"]`)
            : null;
        const chatScreen = chatBody.parentElement;
        if(!element || !chatScreen) return;
        scrollWithinContainer(element, chatScreen, { block: 'end', behavior: 'instant' });
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        void showLatestMessage();
    }

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
        const nextWindowKey = `${getCurrentChatRoomId() ?? ''}/${getDomLimit()}`;
        if (nextWindowKey !== windowKey) {
            windowKey = nextWindowKey;
            windowAnchor = Math.max(0, messages.length - 1);
        }
        const wasAtBottom = checkIfAtBottom();
        updateChatBody()

        const currentChatRoomId = getCurrentChatRoomId();
        const isSameChat = currentChatRoomId === previousChatRoomId;

        // Only auto-scroll if it's the same chat and new messages were added
        if(isSameChat && messages.length > previousLength){
            const lastMsg = messages[messages.length - 1];
            if(lastMsg && lastMsg.role === 'char' && DBState.db.autoScrollToNewMessage){
                if(wasAtBottom || DBState.db.alwaysScrollToNewMessage){
                    setTimeout(() => {
                        void showLatestMessage();
                    }, 700);
                } else {
                    hasNewUnreadMessage = true;
                }
            }
        }
        previousLength = messages.length;
        previousChatRoomId = currentChatRoomId;
    })

</script>

<div class="flex flex-col-reverse" bind:this={chatBody}>
    <!-- In reverse flex order, newer omitted rows belong first (visual bottom). -->
    <div data-chat-spacer="after" aria-hidden="true"></div>
    <div class="contents" bind:this={messageHost}></div>
    <div data-chat-spacer="before" aria-hidden="true"></div>
</div>
