<script lang="ts">
    import type { character, Message, StreamingDisplayOptimizationMode } from 'src/ts/storage/database.svelte';
    import { mount, onDestroy, unmount } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, selectedCharID, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { scrollWithinContainer } from './scrollWithin';
    import { estimateSpacerHeight, getChatWindow } from 'src/ts/chatWindow';
    
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
        pageStart,
        pageEnd,
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
        pageStart: number
        pageEnd: number
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
    let legacyMessageIds = new WeakMap<object, string>();
    let measuredRowHeights: number[] = [];

    function stableMessageId(message: Message, index: number): string {
        if (message.chatId) return message.chatId;
        const objectMessage = message as object;
        let id = legacyMessageIds.get(objectMessage);
        if (!id) {
            id = `legacy:${crypto.randomUUID?.() ?? `${index}:${message.role}`}`;
            legacyMessageIds.set(objectMessage, id);
        }
        return id;
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
        const domLimit: 60 | 40 = saverMode ? 40 : 60;
        const pageAnchor = Math.max(pageStart, Math.min(pageEnd - 1, Math.floor((pageStart + pageEnd - 1) / 2)));
        let domWindow = getChatWindow({ total: messages.length, anchorIndex: pageAnchor, limit: domLimit });
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
            const reloadPointer = reloadPointerMap[i] ?? 0;
            const isRerollTarget = i === lastRealCharIdx;
            const activeStreamingMessage = i === activeStreamingIndex && message.role === 'char';
            const hashMessageData = activeStreamingMessage ? '' : message.data;
            const messageId = stableMessageId(message, i);
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
    };

    onDestroy(() => {
        console.log('Unmounting Chats');
        legacyMessageIds = new WeakMap();
        mountInstances.forEach((inst) => {
            unmount(inst);
        });
        mountInstances.clear();
    })

    function checkIfAtBottom() {
        if (!chatBody || !chatBody.parentElement) return true;
        const sc = chatBody.parentElement;
        const lastEl = chatBody.firstElementChild;
        if (!lastEl) return true;
        const rect = lastEl.getBoundingClientRect();
        const scRect = sc.getBoundingClientRect();
        return rect.top <= scRect.bottom + 100;
    }

    function scrollLatestIntoChatScreen() {
        if(!chatBody) return;
        const element = chatBody.firstElementChild as HTMLElement | null;
        const chatScreen = chatBody.parentElement;
        if(!element || !chatScreen) return;
        scrollWithinContainer(element, chatScreen, { block: 'start', behavior: 'instant' });
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        scrollLatestIntoChatScreen();
    }

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
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
                        scrollLatestIntoChatScreen();
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
