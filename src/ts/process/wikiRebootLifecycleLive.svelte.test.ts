// @vitest-environment node
/**
 * Starting, resuming and recovering a BardWiki reboot, against a REAL spawned
 * server and a REAL hydrated chat.
 *
 * Node environment for the same reason as `promptHistoryPreloadLive.svelte.test.ts`:
 * happy-dom's `fetch` enforces the same-origin policy and cannot reach
 * `http://127.0.0.1:<port>`.
 *
 * Nothing below the HTTP boundary is stubbed. The chat is hydrated by the real
 * `ensureChatMessageWindow` out of real SQLite rows, so it is windowed the way
 * a user's chat is windowed; the history is paged in by the real
 * `ensurePromptHistoryResident`; the completeness guard is the real
 * `isChatHistoryIncomplete`, the one `saveChatToServer` refuses on; the turn
 * projection is the real `projectWikiRebootTurns`. Only the two things that
 * cannot run in a test are injected: the write to the server's chat blob and
 * the reboot runner itself, which calls a language model.
 *
 * THE REPORT THIS COVERS
 *
 * A user opened a long chat and pressed "위키 리부트". They were told to load
 * the whole chat. They scrolled all the way back and pressed it again, and the
 * button has said "정지 대기 중…" ever since. The chain:
 * `startCurrentWikiReboot` assigned the job to the chat BEFORE the save that
 * persists it, `saveChatToServer` refused the windowed chat, and the job stayed
 * behind with status `running` and nothing running it -- a state with no exit,
 * since Stop only sets `stop-requested`, the button is disabled while it says
 * that, and Cancel renders for neither status.
 */
import { flushSync } from "svelte";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Chat, Database, character } from "../storage/database.svelte";

const activeStorage = vi.hoisted(() => ({ current: null as any }));

vi.mock("../storage/sql/sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

const { NodeSqliteStorage } = await import("../storage/sql/nodeSqliteStorage");
const { ensureChatMessageWindow, MAX_RESIDENT_MESSAGES } = await import("../storage/sql/sqlRuntimeHydration");
const { conversationMessageCount, getSqlWindow, isSqlWindowPartial } = await import("../storage/sql/sqlRuntimeWindow");
const { getResidencyPinCount, resetResidencyPinsForTesting } = await import("../storage/sql/residencyPin");
const { isChatHistoryIncomplete } = await import("../storage/chatHistoryCompleteness");
const { ensurePromptHistoryResident } = await import("../storage/sql/promptHistoryPreload");
const { createWikiRebootJob, projectWikiRebootTurns } = await import("../risubard/wikiReboot");
const {
  beginWikiReboot,
  ensureWikiRebootHistoryResident,
  recoverStalledWikiRebootJob,
  resumeWikiReboot,
} = await import("./wikiRebootLifecycle");
const { createClient } = await import("../../../test/compat/helpers/client");
const { spawnServer } = await import("../../../test/compat/helpers/spawnServer");
type ServerHandle = Awaited<ReturnType<typeof spawnServer>>;

const CHARACTER_ID = "character-wiki-reboot";

/** What a chat opens on. `chatStorage.ts` passes exactly this. */
const OPEN_PAGE = 40;
/** Comfortably past MAX_RESIDENT_MESSAGES (320): a whole load must exceed it. */
const LONG = 420;

interface Seed {
  chatId: string;
  length: number;
  /** `disabled === 'allBefore'`, which ends the PROMPT's interest in older messages. */
  cutOffAt?: number;
}

function seededMessage(chatId: string, index: number, seed: Seed) {
  return {
    role: index % 2 === 0 ? "user" : "char",
    data: `message ${String(index).padStart(4, "0")}`.padEnd(40, "."),
    chatId: `${chatId}-msg-${String(index).padStart(4, "0")}`,
    ...(seed.cutOffAt === index ? { disabled: "allBefore" } : {}),
  };
}

function legacyDatabase(seeds: Seed[]): Database {
  return {
    apiType: "openai",
    username: "reporter",
    maxContext: 4000,
    personas: [{ name: "Default", icon: "", personaPrompt: "" }],
    botPresets: [],
    botPresetsId: 0,
    modules: [],
    pluginCustomStorage: {},
    characters: [{
      chaId: CHARACTER_ID,
      type: "character",
      name: "Ada",
      image: "",
      desc: "",
      firstMessage: "Hello, this is the greeting.",
      alternateGreetings: [],
      chatPage: 0,
      chats: seeds.map((seed, chatIndex) => ({
        id: seed.chatId,
        name: `Chat ${chatIndex}`,
        note: "",
        localLore: [],
        message: Array.from({ length: seed.length }, (_, index) => seededMessage(seed.chatId, index, seed)),
      })),
    }],
  } as unknown as Database;
}

/** The live database exactly as the app holds it: `$state`, chat unhydrated. */
function reactiveDatabase(chatId: string): character {
  const db = $state({
    characters: [{
      chaId: CHARACTER_ID,
      chatPage: 0,
      chats: [{
        id: chatId,
        name: "Chat 0",
        note: "",
        localLore: [],
        message: [] as any[],
        _placeholder: true,
        messagesLoaded: false,
      }],
    }],
  });
  return db.characters[0] as unknown as character;
}

/** Open a chat the way `hydrateRecentChatPage` does: newest 40, nothing else. */
async function openChat(chatId: string, limit = OPEN_PAGE): Promise<character> {
  const character = reactiveDatabase(chatId);
  await ensureChatMessageWindow(character, 0, limit);
  flushSync();
  return character;
}

let server: ServerHandle;
let storage: InstanceType<typeof NodeSqliteStorage>;

/**
 * `saveChatToServer`, minus the one line that reaches the network.
 *
 * The guard is the real one -- the same function the real `saveChatToServer`
 * calls, imported from the module it lives in -- so a save here refuses exactly
 * the chats the real save refuses and accepts exactly the ones it accepts.
 */
function recordingSave(options: { fail?: () => Error } = {}) {
  const saved: Array<{ resident: number; hasJob: boolean }> = [];
  const save = async (chat: Chat) => {
    if (isChatHistoryIncomplete(chat)) {
      throw new Error(
        `Refusing to save chat ${chat.id}: only part of its history is loaded, so writing it `
        + "would replace the server's full copy with a slice. Load the whole chat first.",
      );
    }
    const failure = options.fail?.();
    if (failure) throw failure;
    saved.push({ resident: chat.message?.length ?? 0, hasJob: Boolean(chat.risuBardWikiReboot) });
  };
  return { save, saved };
}

describe("a BardWiki reboot on a chat that opened on its newest page", () => {
  beforeAll(async () => {
    server = await spawnServer();
    const client = await createClient(server.port, server.password);
    storage = new NodeSqliteStorage((input, init) => client.fetch(String(input), init));
    expect(await storage.init()).toBe(true);
    expect(await storage.replaceDatabase(legacyDatabase([
      { chatId: "reboot-start", length: LONG },
      { chatId: "reboot-witness", length: LONG },
      { chatId: "reboot-index", length: LONG },
      { chatId: "reboot-out-of-range", length: LONG },
      { chatId: "reboot-load-fails", length: LONG },
      { chatId: "reboot-save-fails", length: LONG },
      { chatId: "reboot-stuck", length: LONG },
      { chatId: "reboot-resume", length: LONG },
      { chatId: "reboot-cut-off", length: LONG, cutOffAt: LONG - 10 },
    ]))).toBe(true);
    activeStorage.current = storage;
  }, 120_000);

  afterEach(() => {
    resetResidencyPinsForTesting();
    activeStorage.current = storage;
  });

  afterAll(async () => {
    activeStorage.current = null;
    await server?.cleanup();
  });

  // ── The state the report starts from ────────────────────────────────────

  it("witnesses the shipped ordering: the save refuses and the job is left behind", async () => {
    const character = await openChat("reboot-witness");
    const chat = character.chats[0];

    // This is what the user was looking at when they pressed the button: a
    // normally opened chat, 40 of 420 messages resident.
    expect(chat.message).toHaveLength(OPEN_PAGE);
    expect(isSqlWindowPartial(chat)).toBe(true);
    expect(isChatHistoryIncomplete(chat)).toBe(true);

    // ...and this is `startCurrentWikiReboot` as it shipped: job first, save
    // second. The save refuses -- correctly, it would replace 420 stored
    // messages with 40 -- and the job stays on the chat with nothing running it.
    const { save } = recordingSave();
    const job = createWikiRebootJob({
      jobId: "witness",
      stagingChatId: "reboot-witness-staging",
      batchSize: 1,
      targetAssistantMessageIds: projectWikiRebootTurns(chat.message, 0).map((turn) => turn.assistantMessageId),
    });
    chat.risuBardWikiReboot = job;
    await expect(save(chat)).rejects.toThrow(/only part of its history is loaded/);

    expect(chat.risuBardWikiReboot?.status).toBe("running");
    // Pressing Stop from there is the whole wedge: `stop-requested` is cleared
    // only inside the runner's loop, and there is no loop.
    chat.risuBardWikiReboot!.status = "stop-requested";
    expect(recoverStalledWikiRebootJob(chat.risuBardWikiReboot, true)).toBe(false);
  });

  // ── 1. A reboot starts without the user scrolling ───────────────────────

  it("loads the whole conversation and starts, with no scrolling by the user", async () => {
    const character = await openChat("reboot-start");
    expect(character.chats[0].message).toHaveLength(OPEN_PAGE);
    expect(conversationMessageCount(character.chats[0])).toBe(LONG);

    const { save, saved } = recordingSave();
    const seenByRunner: Array<{ resident: number; targets: number; pinned: number; hasNewer: boolean }> = [];

    const started = await beginWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-start",
      batchSize: 1,
      startChatIndex: 0,
      jobId: "job-start",
      stagingChatId: "reboot-job-start",
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async (chat) => {
        seenByRunner.push({
          resident: chat.message.length,
          targets: chat.risuBardWikiReboot?.targetAssistantMessageIds.length ?? 0,
          pinned: getResidencyPinCount("reboot-start"),
          hasNewer: getSqlWindow(chat)?.hasNewer === true,
        });
        return true;
      },
    });
    flushSync();

    expect(started).toBe(true);
    const chat = character.chats[0];
    // The whole conversation is resident, from its first message.
    expect(chat.message).toHaveLength(LONG);
    expect(chat.message[0].chatId).toBe("reboot-start-msg-0000");
    expect(isSqlWindowPartial(chat)).toBe(false);
    // Which is exactly what the save that used to refuse now accepts.
    expect(isChatHistoryIncomplete(chat)).toBe(false);
    expect(saved).toEqual([{ resident: LONG, hasJob: true }]);

    // Every assistant turn in the conversation is a target: 210 of 420.
    expect(chat.risuBardWikiReboot?.targetAssistantMessageIds).toHaveLength(LONG / 2);
    expect(chat.risuBardWikiReboot?.targetAssistantMessageIds[0]).toBe("reboot-start-msg-0001");

    // The runner saw the same whole history, above the residency bound, with
    // the pin holding the newest end in place. That is the point of the pin:
    // 420 > 320, so the next page load would otherwise have released the tail.
    expect(seenByRunner).toEqual([{ resident: LONG, targets: LONG / 2, pinned: 1, hasNewer: false }]);
    expect(LONG).toBeGreaterThan(MAX_RESIDENT_MESSAGES);
    // ...and the pin is released when the reboot ends, so the bound resumes.
    expect(getResidencyPinCount("reboot-start")).toBe(0);
  });

  it("holds the residency pin while the runner is awaiting, not only while it starts", async () => {
    const character = await openChat("reboot-start");
    const { save } = recordingSave();
    const pinnedAt: Record<string, number> = {};

    // A runner that yields, the way the real one yields to a language model for
    // minutes at a time. This is what separates `return await input.run(chat)`
    // from `return input.run(chat)`: a bare return evaluates the returned
    // promise and runs the `finally` immediately, dropping the pin while the
    // reboot is still reading the history it just loaded -- and the very next
    // page load would then release the newest end, turning every remaining
    // checkpoint save into a refusal. A runner that never awaits cannot tell
    // the two apart, so this one does.
    const started = await beginWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-start",
      batchSize: 1,
      startChatIndex: 0,
      jobId: "job-pin",
      stagingChatId: "reboot-job-pin",
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async (chat) => {
        pinnedAt.beforeAwait = getResidencyPinCount("reboot-start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        pinnedAt.afterAwait = getResidencyPinCount("reboot-start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        pinnedAt.late = getResidencyPinCount("reboot-start");
        pinnedAt.residentLate = chat.message.length;
        pinnedAt.hasNewerLate = getSqlWindow(chat)?.hasNewer === true ? 1 : 0;
        return true;
      },
    });

    expect(started).toBe(true);
    expect(LONG).toBeGreaterThan(MAX_RESIDENT_MESSAGES);
    expect(pinnedAt).toEqual({
      beforeAwait: 1,
      afterAwait: 1,
      late: 1,
      // ...and the newest end is still there: 420 resident, no hole at the end.
      residentLate: LONG,
      hasNewerLate: 0,
    });
    // Released once the operation is over, so the bound resumes.
    expect(getResidencyPinCount("reboot-start")).toBe(0);
  });

  it("refuses a load that reports success without reaching the start of the history", async () => {
    const character = await openChat("reboot-load-fails");
    const { save, saved } = recordingSave();

    // The walk itself should never end short without throwing. If it ever did,
    // the failure would be a wiki rebuilt from the wrong messages with nothing
    // anywhere saying so, so the result is checked rather than trusted.
    await expect(beginWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-load-fails",
      batchSize: 1,
      startChatIndex: 0,
      jobId: "job-short-load",
      stagingChatId: "reboot-job-short-load",
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async () => {
        throw new Error("the runner must not be reached from a short history");
      },
      preload: async () => ({
        holdsNewestEnd: true,
        reachedStartOfHistory: false,
        resident: 120,
        total: LONG,
        requests: 2,
      }),
    })).rejects.toThrow(`it holds 120 of ${LONG} messages`);

    expect(character.chats[0].risuBardWikiReboot).toBeUndefined();
    expect(saved).toEqual([]);
    expect(getResidencyPinCount("reboot-load-fails")).toBe(0);
  });

  // ── 2. A failed start leaves the chat exactly as it was ─────────────────

  it("leaves no job behind when the history cannot be loaded", async () => {
    const character = await openChat("reboot-load-fails");
    const { save, saved } = recordingSave();
    const controller = new AbortController();
    controller.abort();

    await expect(beginWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-load-fails",
      batchSize: 1,
      startChatIndex: 0,
      jobId: "job-load-fails",
      stagingChatId: "reboot-job-load-fails",
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async () => true,
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/);

    expect(character.chats[0].risuBardWikiReboot).toBeUndefined();
    expect(saved).toEqual([]);
    expect(getResidencyPinCount("reboot-load-fails")).toBe(0);
  });

  it("leaves no job behind when the load fails after pages have already landed", async () => {
    const character = await openChat("reboot-load-fails");
    const { save, saved } = recordingSave();
    const controller = new AbortController();
    let requestsSeen = 0;

    // A load that fails BEFORE it starts is the easy case. This one is the
    // dangerous one: pages have landed, the resident array is longer than the
    // window it opened on and still shorter than the conversation, and it is
    // exactly the array a reboot would index from the front if it proceeded.
    await expect(beginWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-load-fails",
      batchSize: 1,
      startChatIndex: 0,
      jobId: "job-load-fails-partway",
      stagingChatId: "reboot-job-load-fails-partway",
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async () => {
        throw new Error("the runner must not be reached from a partial history");
      },
      signal: controller.signal,
      onProgress: (progress) => {
        requestsSeen = progress.requests;
        if (progress.requests >= 2) controller.abort();
      },
    })).rejects.toThrow();
    flushSync();

    const chat = character.chats[0];
    expect(requestsSeen).toBeGreaterThanOrEqual(2);
    expect(chat.message.length).toBeGreaterThan(OPEN_PAGE);
    expect(chat.message.length).toBeLessThan(LONG);
    expect(chat.risuBardWikiReboot).toBeUndefined();
    expect(saved).toEqual([]);
    expect(getResidencyPinCount("reboot-load-fails")).toBe(0);
    // The chat is still honestly marked incomplete, so the real save still
    // refuses it: nothing wrote a partial history anywhere.
    expect(isSqlWindowPartial(chat)).toBe(true);
    expect(isChatHistoryIncomplete(chat)).toBe(true);
  });

  it("leaves no job behind when the job cannot be persisted", async () => {
    const character = await openChat("reboot-save-fails");
    const { save, saved } = recordingSave({ fail: () => new Error("saveChatContent error: 507") });

    await expect(beginWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-save-fails",
      batchSize: 2,
      startChatIndex: 0,
      jobId: "job-save-fails",
      stagingChatId: "reboot-job-save-fails",
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async () => {
        throw new Error("the runner must not be reached when the job was not persisted");
      },
    })).rejects.toThrow("saveChatContent error: 507");
    flushSync();

    // The failure is the one the report is about, and this is the assertion the
    // report asked for: nothing of the attempt is left on the chat.
    expect(character.chats[0].risuBardWikiReboot).toBeUndefined();
    expect(saved).toEqual([]);
    expect(getResidencyPinCount("reboot-save-fails")).toBe(0);
  });

  // ── 3. `startChatIndex` is a position in the conversation ────────────────

  it("accepts a start position beyond the resident window", async () => {
    const character = await openChat("reboot-index");
    // The window this index used to be validated against holds 40 messages, so
    // 200 was rejected as out of range. It is message 200 of 420.
    expect(character.chats[0].message).toHaveLength(OPEN_PAGE);

    const { save } = recordingSave();
    const started = await beginWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-index",
      batchSize: 1,
      startChatIndex: 200,
      jobId: "job-index",
      stagingChatId: "reboot-job-index",
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async () => true,
    });
    flushSync();

    expect(started).toBe(true);
    const targets = character.chats[0].risuBardWikiReboot?.targetAssistantMessageIds ?? [];
    // Assistant messages are the odd indices, so 201, 203 ... 419: 110 turns,
    // and the projection indexed the FULL history rather than a slice of it.
    expect(targets).toHaveLength((LONG - 200) / 2);
    expect(targets[0]).toBe("reboot-index-msg-0201");
    expect(targets.at(-1)).toBe(`reboot-index-msg-${String(LONG - 1).padStart(4, "0")}`);
  });

  it("refuses a start position past the end of the conversation, and says how long it is", async () => {
    const character = await openChat("reboot-out-of-range");
    const { save, saved } = recordingSave();

    await expect(beginWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-out-of-range",
      batchSize: 1,
      startChatIndex: LONG + 1,
      jobId: "job-out-of-range",
      stagingChatId: "reboot-job-out-of-range",
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async () => true,
    })).rejects.toThrow(`this conversation has ${LONG} messages`);

    expect(character.chats[0].risuBardWikiReboot).toBeUndefined();
    expect(saved).toEqual([]);
  });

  // ── 4. A job with no runner becomes recoverable ─────────────────────────

  it("recovers a job stuck at stop-requested and lets the reader resume it", async () => {
    const character = await openChat("reboot-stuck");
    const chat = character.chats[0];
    // Exactly the state the report ends in, on a chat that is still windowed:
    // a job persisted on the chat, saying it is stopping, with no runner.
    const job = createWikiRebootJob({
      jobId: "job-stuck",
      stagingChatId: "reboot-job-stuck",
      batchSize: 1,
      targetAssistantMessageIds: [`reboot-stuck-msg-0001`],
    });
    job.status = "stop-requested";
    chat.risuBardWikiReboot = job;

    // A live runner is never disturbed...
    expect(recoverStalledWikiRebootJob(chat.risuBardWikiReboot, true)).toBe(false);
    expect(chat.risuBardWikiReboot?.status).toBe("stop-requested");

    // ...and without one, the job becomes one the UI offers Resume and Cancel for.
    expect(recoverStalledWikiRebootJob(chat.risuBardWikiReboot, false)).toBe(true);
    expect(chat.risuBardWikiReboot?.status).toBe("paused");
    // Recovery is a status change and nothing else.
    expect(chat.risuBardWikiReboot?.targetAssistantMessageIds).toEqual(["reboot-stuck-msg-0001"]);
    expect(chat.risuBardWikiReboot?.stagingChatId).toBe("reboot-job-stuck");
    // Idempotent: a second pass has nothing to do.
    expect(recoverStalledWikiRebootJob(chat.risuBardWikiReboot, false)).toBe(false);
  });

  it("loads the whole conversation before resuming, so no target is silently skipped", async () => {
    const character = await openChat("reboot-resume");
    const chat = character.chats[0];
    const job = createWikiRebootJob({
      jobId: "job-resume",
      stagingChatId: "reboot-job-resume",
      batchSize: 1,
      // Every assistant turn of the conversation, including ones far outside
      // the resident window. Resuming on the window would have found only the
      // last twenty and called the rebuild finished.
      targetAssistantMessageIds: Array.from(
        { length: LONG / 2 },
        (_, turn) => `reboot-resume-msg-${String(turn * 2 + 1).padStart(4, "0")}`,
      ),
    });
    job.status = "paused";
    job.lastError = "리부트 배치 완료 영수증을 저장하지 못했습니다.";
    chat.risuBardWikiReboot = job;

    const { save, saved } = recordingSave();
    let projectedTurns = 0;
    let pinnedDuringRun = -1;
    let residentDuringRun = -1;
    const resumed = await resumeWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-resume",
      job,
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async (resumedChat) => {
        projectedTurns = projectWikiRebootTurns(resumedChat.message).length;
        // A resume runs the same long loop as a start, checkpointing through
        // the same guarded save after every batch, so its pin has to survive
        // the same yields. Asserted here rather than in a second test: it is a
        // property of this run, not a separate one.
        await new Promise((resolve) => setTimeout(resolve, 5));
        pinnedDuringRun = getResidencyPinCount("reboot-resume");
        residentDuringRun = resumedChat.message.length;
        return true;
      },
    });
    flushSync();

    expect(resumed).toBe(true);
    expect(projectedTurns).toBe(LONG / 2);
    expect(pinnedDuringRun).toBe(1);
    expect(residentDuringRun).toBe(LONG);
    expect(job.status).toBe("running");
    expect(job.lastError).toBeUndefined();
    expect(saved).toEqual([{ resident: LONG, hasJob: true }]);
    expect(getResidencyPinCount("reboot-resume")).toBe(0);
  });

  it("leaves a resumed job in the state the reader saw when the save refuses", async () => {
    const character = await openChat("reboot-resume");
    const chat = character.chats[0];
    const job = createWikiRebootJob({
      jobId: "job-resume-fails",
      stagingChatId: "reboot-job-resume-fails",
      batchSize: 1,
      targetAssistantMessageIds: ["reboot-resume-msg-0001"],
    });
    job.status = "failed";
    job.lastError = "리부트 배치 완료 영수증을 저장하지 못했습니다.";
    chat.risuBardWikiReboot = job;

    const { save } = recordingSave({ fail: () => new Error("saveChatContent error: 507") });
    await expect(resumeWikiReboot({
      character,
      chatIndex: 0,
      chatId: "reboot-resume",
      job,
      saveChat: save,
      resolveChat: () => character.chats[0],
      run: async () => {
        throw new Error("the runner must not be reached when the resume was not persisted");
      },
    })).rejects.toThrow("saveChatContent error: 507");

    expect(job.status).toBe("failed");
    expect(job.lastError).toBe("리부트 배치 완료 영수증을 저장하지 못했습니다.");
  });

  // ── The load itself ─────────────────────────────────────────────────────

  it("pages past a marker that would end a prompt's interest in older messages", async () => {
    const character = await openChat("reboot-cut-off");
    // `disabled === 'allBefore'` is resident from the moment the chat opens, and
    // it stops the prompt's own preload dead: the prompt reads nothing older, so
    // loading it would be waste. The reboot's projection has no such rule and
    // rebuilds across the marker, so stopping there would be a rebuild missing
    // everything before it.
    const promptShaped = await ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens: Number.MAX_SAFE_INTEGER,
      measure: async () => 0,
    });
    expect(promptShaped.reachedStartOfHistory).toBe(false);
    expect(character.chats[0].message).toHaveLength(OPEN_PAGE);

    const whole = await ensureWikiRebootHistoryResident({ character, chatIndex: 0 });
    flushSync();
    expect(whole).toEqual({ resident: LONG, total: LONG, requests: expect.any(Number) });
    expect(character.chats[0].message).toHaveLength(LONG);
    expect(isChatHistoryIncomplete(character.chats[0])).toBe(false);
  });
});
