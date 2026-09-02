import type { Chat, character } from "../storage/database.svelte"
import type { WikiWritingLanguage } from "../risubard/wikiWritingLanguage"
import {
    createWikiRebootJob,
    projectWikiRebootTurns,
    type WikiRebootBatchSize,
    type WikiRebootJob,
} from "../risubard/wikiReboot"
import {
    ensurePromptHistoryResident,
    type PromptHistoryPreloadOptions,
    type PromptHistoryPreloadProgress,
} from "../storage/sql/promptHistoryPreload"
import { beginResidencyPin, endResidencyPin } from "../storage/sql/residencyPin"

/**
 * Starting, resuming and un-wedging a BardWiki reboot.
 *
 * WHY THIS IS NOT IN `process/index.svelte.ts`
 *
 * The three things below are the parts of the reboot that were wrong, and every
 * one of them is an ORDERING: load before you validate, persist before you
 * commit, unpin only after the last read. `index.svelte.ts` cannot be executed
 * under test -- it reaches `DBState`, the selected-character store and the
 * whole generation pipeline -- so orderings that live in it are checked by
 * matching its source text, which is how all three of these got shipped. They
 * live here instead, driven against a real hydrated chat, and `index.svelte.ts`
 * keeps only the wiring that supplies the real save, the real runner and the
 * real conversation.
 *
 * WHAT THE REBOOT NEEDS FROM THE HISTORY, AND WHY IT IS NOT A SEND'S NEED
 *
 * `startCurrentWikiReboot` takes a `startChatIndex` and calls
 * `projectWikiRebootTurns(chat.message, startChatIndex)`: it indexes the
 * resident array FROM THE FRONT and rebuilds the wiki from that point to the
 * end of the conversation. A chat opens on its newest 40 messages, so on any
 * long conversation that array is a slice of the newest end -- and indexing a
 * slice from the front is indexing the wrong messages. With the default
 * `startChatIndex` of 0 the requirement is therefore the ENTIRE conversation,
 * and there is no budget-shaped answer to it: `ensurePromptHistoryResident`'s
 * prompt bounds (`targetMessages`, the token ceiling, the residency ceiling)
 * all stop at the newest end, which is precisely the wrong end. So the load
 * runs in `loadEntireHistory` mode, and anything short of the true start of the
 * conversation is a refusal rather than a shorter rebuild.
 *
 * That necessarily exceeds `MAX_RESIDENT_MESSAGES` on any conversation longer
 * than it -- being whole is the point, and the bound and being whole cannot
 * both hold. The consequence is that residency trimming, which releases the
 * NEWEST end, would undo the load the moment the next page request fires. So a
 * residency pin is held across the WHOLE operation -- the load, the save, and
 * the reboot run that reads `chat.message` batch after batch -- and released in
 * a `finally`. Not just across the load: the reboot persists its progress
 * through `saveChatToServer`, which refuses a windowed chat, so a trim halfway
 * through the run would turn every remaining checkpoint into an error. Once the
 * operation ends the pin drops and the next page load trims as it always did:
 * the bound is deferred for the length of a reboot, not abandoned.
 *
 * WHY THE JOB IS ASSIGNED WHERE IT IS
 *
 * `chat.risuBardWikiReboot` is what every reboot control reads, and it is chat
 * extension data, so it outlives the session. It used to be assigned before the
 * save that persists it, and `saveChatToServer` throws on a windowed chat --
 * deliberately, since writing a slice replaces the stored history with it. The
 * throw left the job behind with status `running` and nothing running it, and
 * from that state the UI offers Stop (which only sets `stop-requested`, a
 * status only the runner's loop can clear), disables the button while it is
 * `stop-requested`, and renders Cancel for neither. The reporting user has been
 * looking at "정지 대기 중…" ever since. So the assignment is rolled back on a
 * failed save: a start that does not start leaves the chat exactly as it was.
 */

type PreloadFn = (options: PromptHistoryPreloadOptions) => Promise<{
    holdsNewestEnd: boolean
    reachedStartOfHistory: boolean
    resident: number
    total: number
    requests: number
}>

/** Storage caps a page at 100, and a whole-history walk wants every one. */
export const WIKI_REBOOT_PAGE_SIZE = 100

export interface WikiRebootHistoryLoad {
    character: character
    chatIndex: number
    onProgress?: (progress: PromptHistoryPreloadProgress) => void
    /**
     * The load is done and the reboot itself is about to start. The load is the
     * only part of this with a progress dialog, and a reboot runs for minutes,
     * so the caller needs a point at which to take the dialog down that is not
     * "when everything finishes".
     */
    onHistoryReady?: (history: WikiRebootHistory) => void
    signal?: AbortSignal
    /** Test seam. Production always uses the real preload. */
    preload?: PreloadFn
}

export interface WikiRebootHistory {
    resident: number
    total: number
    requests: number
}

/**
 * Make the whole conversation resident, or throw.
 *
 * The caller must already hold a residency pin on this chat: a whole history is
 * over the residency bound by construction on any long conversation, and
 * without a pin the next page load releases the newest end of what was just
 * loaded. {@link beginWikiReboot} and {@link resumeWikiReboot} hold it.
 */
export async function ensureWikiRebootHistoryResident(
    input: WikiRebootHistoryLoad,
): Promise<WikiRebootHistory> {
    const preload = input.preload ?? ensurePromptHistoryResident
    const result = await preload({
        character: input.character,
        chatIndex: input.chatIndex,
        loadEntireHistory: true,
        // Both are inert under `loadEntireHistory` and both are required by the
        // options type. The measure is never called for a budget that is never
        // consulted, so it measures nothing rather than tokenizing a history
        // whose size no decision here depends on.
        budgetTokens: Number.POSITIVE_INFINITY,
        measure: async () => 0,
        pageSize: WIKI_REBOOT_PAGE_SIZE,
        onProgress: input.onProgress,
        signal: input.signal,
    })
    // The walk under `loadEntireHistory` ends only at the start of the history
    // or in a throw, so neither of these should be reachable. They are checked
    // anyway: the failure they would represent is a rebuild indexed into a
    // slice, which produces a plausible-looking wiki built from the wrong
    // messages and nothing anywhere that says so.
    if (!result.reachedStartOfHistory || !result.holdsNewestEnd) {
        throw new Error(
            "Could not load the whole conversation for the BardWiki reboot: it holds "
            + `${result.resident} of ${result.total} messages. The reboot rebuilds the wiki `
            + "from a position in the full history, so it was not started.",
        )
    }
    const history = { resident: result.resident, total: result.total, requests: result.requests }
    input.onHistoryReady?.(history)
    return history
}

export interface BeginWikiRebootInput extends WikiRebootHistoryLoad {
    /** The chat's own id, resolved before the load so the pin can be released. */
    chatId: string
    batchSize: WikiRebootBatchSize
    /** Position in the WHOLE conversation to rebuild from. */
    startChatIndex: number
    jobId: string
    stagingChatId: string
    writingLanguage?: WikiWritingLanguage
    /** The real `saveChatToServer`, with its windowed-chat guard intact. */
    saveChat: (chat: Chat) => Promise<void>
    /** The real `runWikiReboot`. Receives the chat the job was written into. */
    run: (chat: Chat) => Promise<boolean>
    /**
     * True when the application is no longer looking at the chat this started
     * on. Loading a long history is many round trips and the reader is free to
     * switch chats while they are in the air; a job written into a chat nobody
     * asked about is not something to paper over.
     */
    targetMoved?: () => boolean
    /**
     * Re-read of the chat slot after the load. `loadNewestChatMessages` can
     * replace the object in the array, so the chat the job is written into must
     * be the one the array holds now -- not the one this started from.
     */
    resolveChat: () => Chat | undefined
}

/**
 * Start a reboot: load the whole history, then commit the job, or leave nothing
 * behind.
 *
 * Returns false when there is nothing to rebuild (no turns from that point on).
 * Throws when the history could not be loaded, the chat moved underneath, the
 * start position is not in the conversation, or the job could not be persisted
 * -- and in every one of those cases `chat.risuBardWikiReboot` is exactly what
 * it was before the call.
 */
export async function beginWikiReboot(input: BeginWikiRebootInput): Promise<boolean> {
    // Pinned before the first page request and released after the last read of
    // `chat.message`, which is inside `run`. See the module comment.
    beginResidencyPin(input.chatId)
    try {
        await ensureWikiRebootHistoryResident(input)
        if (input.targetMoved?.()) {
            throw new Error(
                "The selected chat changed while this conversation's history was loading for the "
                + "BardWiki reboot, so the reboot was not started.",
            )
        }
        const chat = input.resolveChat()
        if (!chat || chat.id !== input.chatId) {
            throw new Error(
                `Chat ${input.chatId} is no longer in the position it was loaded for, so the `
                + "BardWiki reboot was not started.",
            )
        }
        // Only now is this a position in the conversation rather than a position
        // in whatever window happened to be resident. Validating it before the
        // load is what rejected "rebuild from message 200" on a 40-message
        // window of a 400-message chat -- for the wrong reason, since message
        // 200 was there all along.
        const messageCount = chat.message?.length ?? 0
        if (!Number.isInteger(input.startChatIndex) || input.startChatIndex < 0
            || input.startChatIndex >= messageCount) {
            throw new Error(
                `Cannot start the BardWiki reboot from message ${input.startChatIndex}: this `
                + `conversation has ${messageCount} messages.`,
            )
        }
        const turns = projectWikiRebootTurns(chat.message, input.startChatIndex)
        if (turns.length === 0) return false
        const job = createWikiRebootJob({
            jobId: input.jobId,
            stagingChatId: input.stagingChatId,
            writingLanguage: input.writingLanguage,
            batchSize: input.batchSize,
            targetAssistantMessageIds: turns.map((turn) => turn.assistantMessageId),
        })
        // The job has to be in the chat for the save to persist it, so the
        // rollback is the only ordering available. Identity-checked: if
        // something else replaced the job while the write was in flight, that
        // replacement is not ours to delete.
        chat.risuBardWikiReboot = job
        try {
            await input.saveChat(chat)
        }
        catch (error) {
            if (chat.risuBardWikiReboot === job) delete chat.risuBardWikiReboot
            throw error
        }
        // `return await`, not `return`: a bare `return` of the promise runs the
        // `finally` immediately and drops the pin while the reboot is still
        // reading the history it just loaded.
        return await input.run(chat)
    }
    finally {
        endResidencyPin(input.chatId)
    }
}

export interface ResumeWikiRebootInput extends WikiRebootHistoryLoad {
    chatId: string
    /** The persisted job, already known to be `paused` or `failed`. */
    job: WikiRebootJob
    saveChat: (chat: Chat) => Promise<void>
    run: (chat: Chat) => Promise<boolean>
    resolveChat: () => Chat | undefined
    targetMoved?: () => boolean
}

/**
 * Resume a paused or failed reboot.
 *
 * The load is not optional here either, and for a sharper reason than at the
 * start. `runWikiReboot` picks its next batch by matching the job's
 * `targetAssistantMessageIds` against the turns it can project out of
 * `chat.message`; targets that are not resident are not missing, they are
 * simply absent from the projection. Resuming on a 40-message window would
 * therefore work through the handful of targets that happen to be resident,
 * find no more, and treat that as "every target is done" -- finalizing a
 * replacement wiki built from a fraction of the conversation, with a full
 * progress bar. So a resume that cannot load the whole history refuses, and the
 * job stays exactly as it was: paused or failed, and resumable again later.
 */
export async function resumeWikiReboot(input: ResumeWikiRebootInput): Promise<boolean> {
    beginResidencyPin(input.chatId)
    try {
        await ensureWikiRebootHistoryResident(input)
        if (input.targetMoved?.()) {
            throw new Error(
                "The selected chat changed while this conversation's history was loading for the "
                + "BardWiki reboot, so it was not resumed.",
            )
        }
        const chat = input.resolveChat()
        if (!chat || chat.id !== input.chatId) {
            throw new Error(
                `Chat ${input.chatId} is no longer in the position it was loaded for, so the `
                + "BardWiki reboot was not resumed.",
            )
        }
        const job = chat.risuBardWikiReboot
        if (!job || job !== input.job) {
            throw new Error(
                "The BardWiki reboot job changed while this conversation's history was loading, "
                + "so it was not resumed.",
            )
        }
        const previousStatus = job.status
        const previousError = job.lastError
        job.status = 'running'
        delete job.lastError
        job.updatedAt = Date.now()
        try {
            await input.saveChat(chat)
        }
        catch (error) {
            // Same rule as the start: a resume that could not be recorded must
            // leave the job in the state the reader last saw, which is the state
            // whose controls still work.
            job.status = previousStatus
            if (previousError !== undefined) job.lastError = previousError
            job.updatedAt = Date.now()
            throw error
        }
        return await input.run(chat)
    }
    finally {
        endResidencyPin(input.chatId)
    }
}

/**
 * Move a job that cannot make progress to `paused`, in place.
 *
 * A `running` or `stop-requested` job is a claim that a runner is working on
 * it. `runWikiReboot` is the only thing that can be that runner, it registers
 * its operation id in `activeWikiReboots` synchronously before its first
 * `await`, and it removes it in a `finally` -- so within this session the
 * absence of that id is exact evidence that no loop is running. `hasRunner` is
 * that answer plus one more: a start or resume holds its own claim from before
 * the job is written until the runner has taken over, because the persist in
 * between is an `await` and a job mid-start is not a job nothing is running.
 * Without either, neither status can ever change again on its own:
 * `stop-requested` is turned into `paused` inside the runner's loop, and there
 * is no loop.
 *
 * Two things leave a job in that state. Closing the app or the tab mid-reboot
 * is the ordinary one. The other is the start-failure this module now prevents,
 * which is how the reporting user's chat got there and why recovery has to
 * reach a job that is already persisted rather than only new ones.
 *
 * `paused` is the correct destination and not merely a convenient one: it is
 * the status the UI renders Resume AND Cancel for, and it is the same status
 * `normalizeWikiRebootJob` already assigns to every interrupted job it reads
 * out of storage at load time. So this changes no meaning; it applies the
 * meaning storage already has to a job that reached memory by another route.
 *
 * Nothing else is touched -- not the receipts, not the completed ids, not the
 * staging chat, not `inFlightAssistantMessageIds`, which a resume needs in
 * order to reclaim the batch that was in flight. A reboot genuinely running in
 * another tab keeps its own copy of the job in its own memory and rewrites the
 * status on its next checkpoint; the worst this can do to it is offer a
 * Resume/Cancel button in a tab that is not the one doing the work, which is
 * exactly what that tab already gets from load-time normalization today.
 */
export function recoverStalledWikiRebootJob(
    job: WikiRebootJob | undefined,
    hasRunner: boolean,
    now: number = Date.now(),
): boolean {
    if (!job || hasRunner) return false
    if (job.status !== 'running' && job.status !== 'stop-requested') return false
    job.status = 'paused'
    job.updatedAt = now
    return true
}
