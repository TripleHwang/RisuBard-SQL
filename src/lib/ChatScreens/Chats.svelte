<script lang="ts">
    import type { character, Message, StreamingDisplayOptimizationMode } from 'src/ts/storage/database.svelte';
    import { mount, onDestroy, tick, unmount } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, selectedCharID, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { scrollWithinContainer } from './scrollWithin';
    import { estimateSpacerHeight, getChatWindow, stepChatWindowCenter, type ChatWindow } from 'src/ts/chatWindow';
    import { publishMountedMessageIds, releaseMountedMessageIds } from 'src/ts/chatMountRegistry';
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
        currentUsername,
        userIcon,
        /**
         * The scroll has reached the oldest message this screen is holding and
         * there is nothing resident left to mount. Whether anything older
         * exists is storage's question, not this component's.
         */
        onReachOldestMounted = () => {},
        /** Which ends of the resident history the mounted window now covers. */
        onWindowChange = () => {},
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
        currentUsername: string
        userIcon: string
        onReachOldestMounted?: () => void
        onWindowChange?: (state: { atOldestEnd: boolean, atNewestEnd: boolean }) => void
        saverMode?: boolean
        userIconPortrait?: boolean
        hasNewUnreadMessage?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    let messageHost: HTMLDivElement;
    let olderSentinel: HTMLDivElement | undefined = $state();
    let newerSentinel: HTMLDivElement | undefined = $state();
    /**
     * The message the mounted window is centred on, by stable id -- never by
     * index.
     *
     * `null` means "pinned to the newest end", which is where a chat opens and
     * where it returns to. An index would be wrong the moment storage prepends
     * an older page: every index shifts by the size of that page, and a
     * window that followed the number instead of the message would drag the
     * reader backwards by a page each time one arrived.
     */
    let anchorId: string | null = $state(null);
    let anchoredChatRoomId: string | null = null;
    let reportedAtOldestEnd: boolean | null = null;
    let reportedAtNewestEnd: boolean | null = null;
    /**
     * How far outside the viewport an end has to come before it counts as
     * reached. Wide enough that the next rows are mounted, or the next page
     * requested, before the reader arrives at blank spacer.
     */
    const SCROLL_END_MARGIN_PX = 600;
    type ChatInstance = {
        updateStreamingDisplay?: (state: {
            isOptimizedStreamingMessage: boolean
            streamingOptimizationMode: StreamingDisplayOptimizationMode
            rawStreamingText: string
        }) => void
    }
    type MountedChat = { instance: ChatInstance, element: HTMLDivElement, signature: string }
    let mountInstances: Map<string, MountedChat> = new Map();
    /**
     * Identity of this screen in the mount registry. Storage-side residency
     * trimming refuses to release any row published here, so the token has to
     * outlive every render and be retracted exactly once, on destroy.
     */
    const mountRegistryToken = {};
    let measuredRowHeights: number[] = [];

    function stableMessageId(message: Message): string {
        // Legacy imported rows receive their durable identity before becoming a
        // mounted owner; there is no mutable-index identity fallback.
        message.chatId ??= crypto.randomUUID();
        return message.chatId;
    }

    const domLimit = (): 60 | 40 => saverMode ? 40 : 60;

    /**
     * Where the anchored message sits now.
     *
     * A missing anchor falls back to the newest end rather than to zero: an id
     * that is no longer in the array means the row was released or deleted, and
     * silently re-centring on the start of the array would look like the chat
     * had jumped to its beginning on its own.
     */
    function resolveAnchorIndex(): number {
        const total = messages.length;
        if (total === 0) return 0;
        if (anchorId === null) return total - 1;
        const found = messages.findIndex((message) => message.chatId === anchorId);
        return found >= 0 ? found : total - 1;
    }

    function currentDomWindow(): ChatWindow {
        return getChatWindow({ total: messages.length, anchorIndex: resolveAnchorIndex(), limit: domLimit() });
    }

    /**
     * Slide the mounted window one step. Returns false when it did not move,
     * which at the older end is the signal that only storage can supply more.
     */
    function slideDomWindow(direction: -1 | 1): boolean {
        const total = messages.length;
        if (total === 0) return false;
        const limit = domLimit();
        const current = currentDomWindow();
        const centre = stepChatWindowCenter(current, total, limit, direction);
        const next = getChatWindow({ total, anchorIndex: centre, limit });
        if (next.start === current.start && next.end === current.end) return false;
        // Reaching the newest end drops the anchor entirely, so a message
        // appended after this point keeps the window pinned to the tail.
        anchorId = next.end >= total ? null : stableMessageId(messages[centre]);
        return true;
    }

    function handleOlderEndVisible() {
        // A slide that lands on the oldest resident row is the last one this
        // component can make, so storage is asked in the same turn rather than
        // on a later sentinel report. That report may never come: the terminal
        // slide mounts only the remainder of the array, which can be one row,
        // and if that is not tall enough to push the sentinel back outside the
        // root margin then IntersectionObserver -- which does not re-notify a
        // target that stays intersecting -- has nothing left to fire. The chat
        // would sit at its oldest resident message with the rest of its history
        // on disk, no spinner, no error and no way forward.
        const moved = slideDomWindow(-1);
        if (moved && currentDomWindow().beforeCount > 0) return;
        onReachOldestMounted();
    }

    function handleNewerEndVisible() {
        slideDomWindow(1);
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
        const limit = domLimit();
        const anchoredWindow = currentDomWindow();
        let domWindow = anchoredWindow;
        // A live stream stays mounted even when the user has scrolled away from its tail.
        if (currentChat?.isStreaming && activeStreamingIndex >= 0 && (activeStreamingIndex < domWindow.start || activeStreamingIndex >= domWindow.end)) {
            const end = messages.length;
            const start = Math.max(0, end - limit);
            domWindow = { start, end, beforeCount: start, afterCount: 0 };
        }
        // These two answer different questions, so they are read from different
        // windows.
        //
        // `atOldestEnd` is about the rows: it gates the "start of the
        // conversation" block, which must never be drawn above a window that
        // does not actually reach the start. That is the mounted window.
        //
        // `atNewestEnd` is about the reader: it gates the only control that
        // returns them to the latest messages. The streaming override above
        // mounts the tail without the reader asking for it, and reading the
        // flag from that window would report "already at the newest end" --
        // removing the control at the exact moment the override has swapped
        // the rows they were reading for a spacer they are now scrolled into.
        // The anchor is where the reader actually is.
        const atOldestEnd = domWindow.beforeCount === 0;
        const atNewestEnd = anchoredWindow.afterCount === 0;
        if (atOldestEnd !== reportedAtOldestEnd || atNewestEnd !== reportedAtNewestEnd) {
            reportedAtOldestEnd = atOldestEnd;
            reportedAtNewestEnd = atNewestEnd;
            onWindowChange({ atOldestEnd, atNewestEnd });
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
        // Published after the sweep, so what the registry holds is what is
        // actually mounted right now -- never a row this pass just unmounted.
        // The trimmer refuses to release anything named here.
        publishMountedMessageIds(mountRegistryToken, mountInstances.keys());
        updateRuntimeResources({ mountedMessages: mountInstances.size });
    };

    onDestroy(() => {
        console.log('Unmounting Chats');
        mountInstances.forEach((inst) => {
            unmount(inst);
        });
        mountInstances.clear();
        releaseMountedMessageIds(mountRegistryToken);
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

    function scrollLatestIntoChatScreen() {
        if(!chatBody || !messageHost) return;
        const element = messageHost.firstElementChild as HTMLElement | null;
        const chatScreen = chatBody.parentElement;
        if(!element || !chatScreen) return;
        scrollWithinContainer(element, chatScreen, { block: 'start', behavior: 'instant' });
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        if (anchorId !== null) {
            // The newest messages are not mounted yet. Re-pin first, then scroll
            // once the rows they refer to actually exist.
            anchorId = null;
            void tick().then(() => scrollLatestIntoChatScreen());
            return;
        }
        scrollLatestIntoChatScreen();
    }

    /** Mount the window around `index`, for jumps that do not come from scrolling. */
    export const revealMessage = (index: number) => {
        const total = messages.length;
        if (total === 0) return;
        const clamped = Math.max(0, Math.min(total - 1, Math.floor(index)));
        const next = getChatWindow({ total, anchorIndex: clamped, limit: domLimit() });
        anchorId = next.end >= total ? null : stableMessageId(messages[clamped]);
    }

    /** Same, addressed by stable id; ignored when that message is not resident. */
    export const revealMessageById = (id: string | null) => {
        if (!id) {
            anchorId = null;
            return;
        }
        const index = messages.findIndex((message) => message.chatId === id);
        if (index < 0) return;
        revealMessage(index);
    }

    /** The anchor, for a caller that wants to restore this view later. */
    export const getAnchorId = (): string | null => anchorId;

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    // Opening a different chat starts at its newest messages. Kept out of the
    // render effect below so writing the anchor cannot re-trigger the render
    // that reads it.
    $effect(() => {
        const roomId = getCurrentChatRoomId();
        if (roomId === anchoredChatRoomId) return;
        anchoredChatRoomId = roomId;
        anchorId = null;
    })

    /**
     * Both ends of the scroll, watched directly.
     *
     * `scrollTop` is deliberately never read: this container is
     * `flex-col-reverse`, where its sign and origin differ between browsers,
     * and the previous attempt at scroll loading did arithmetic on it -- which
     * is what made the screen jump and blank. An observer reports "this element
     * is on screen", which means the same thing everywhere.
     */
    $effect(() => {
        const older = olderSentinel;
        const newer = newerSentinel;
        const root = chatBody?.parentElement ?? null;
        if (!older || !newer || !root) return;
        if (typeof IntersectionObserver === 'undefined') {
            console.error('[Chats] IntersectionObserver is unavailable, so scrolling to the top of this chat will not load earlier messages.');
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                if (entry.target === older) handleOlderEndVisible();
                else if (entry.target === newer) handleNewerEndVisible();
            }
        }, { root, rootMargin: `${SCROLL_END_MARGIN_PX}px 0px` });
        observer.observe(older);
        observer.observe(newer);
        return () => observer.disconnect();
    })

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
    <!-- In reverse flex order, newer omitted rows belong first (visual bottom).
         Each sentinel sits between its spacer and the mounted rows, so it marks
         the edge of what is on screen. Mounting rows on the far side of a
         sentinel pushes it back out of range, which is what stops one gesture
         from sliding the window forever. -->
    <div data-chat-spacer="after" aria-hidden="true"></div>
    <div data-chat-sentinel="newer" aria-hidden="true" class="h-px w-full shrink-0" bind:this={newerSentinel}></div>
    <div class="contents" bind:this={messageHost}></div>
    <div data-chat-sentinel="older" aria-hidden="true" class="h-px w-full shrink-0" bind:this={olderSentinel}></div>
    <div data-chat-spacer="before" aria-hidden="true"></div>
</div>
