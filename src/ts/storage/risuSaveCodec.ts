import { Unpackr, decode } from "msgpackr/index-no-eval"
import * as fflate from "fflate"

/**
 * The framing of a `.bin` save block, and the decoder for the two framings the
 * server actually writes.
 *
 * This module exists because `risuSave.ts` -- the full decoder -- reaches the
 * Svelte runtime, `globalApi`, and the live database through its imports. The
 * SQL migration client has to read `/api/chat-content` responses while running
 * *underneath* all of that, so it needs the frame check and the msgpack decode
 * without the app graph attached. Keeping the magic headers here rather than
 * copying them means there is still exactly one definition of the format:
 * `risuSave.ts` imports these same constants.
 *
 * Only the framings `encodeRisuSaveLegacy` produces are decoded here. The
 * gzip-stream and `RisuSaveDecoder` framings need capabilities this module
 * deliberately does not have, so they are reported as unsupported rather than
 * guessed at -- an unreadable block must never come back as an empty object.
 */

export const RISU_SAVE_MAGIC_HEADER = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
export const RISU_SAVE_MAGIC_COMPRESSED_HEADER = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8])
export const RISU_SAVE_MAGIC_STREAM_COMPRESSED_HEADER = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9])
export const RISU_SAVE_MAGIC_RISUSAVE_HEADER = new TextEncoder().encode("RISUSAVE\0")

export type RisuSaveHeader = "none" | "compressed" | "raw" | "stream" | "risusave"

const unpackr = new Unpackr({
    int64AsType: 'number',
    useRecords: false,
})

function startsWith(data: Uint8Array, magic: Uint8Array): boolean {
    if (data.length < magic.length) return false
    for (let index = 0; index < magic.length; index++) {
        if (data[index] !== magic[index]) return false
    }
    return true
}

/**
 * Which framing a block carries, or `false` when it is shorter than any header.
 *
 * The `false` return and the exact precedence of the checks are preserved from
 * the original in-line implementation in `risuSave.ts`, which still calls this.
 */
export function checkRisuSaveHeader(data: Uint8Array): RisuSaveHeader | false {
    if (data.length < RISU_SAVE_MAGIC_HEADER.length) return false
    if (startsWith(data, RISU_SAVE_MAGIC_HEADER)) return 'raw'
    if (startsWith(data, RISU_SAVE_MAGIC_COMPRESSED_HEADER)) return 'compressed'
    if (startsWith(data, RISU_SAVE_MAGIC_STREAM_COMPRESSED_HEADER)) return 'stream'
    if (startsWith(data, RISU_SAVE_MAGIC_RISUSAVE_HEADER)) return 'risusave'
    return 'none'
}

/**
 * Decode a block written by `encodeRisuSaveLegacy` (raw or deflate-compressed),
 * or a bare msgpack payload.
 *
 * Every failure throws. There is no fallback chain here on purpose: this
 * decoder is used by the legacy-to-SQL migration, where a block that cannot be
 * read is a reason to stop, never a reason to write an empty chat.
 */
export function decodeLegacyRisuSaveBlock(data: Uint8Array): unknown {
    const header = checkRisuSaveHeader(data)
    switch (header) {
        case 'raw':
            return unpackr.decode(data.slice(RISU_SAVE_MAGIC_HEADER.length))
        case 'compressed':
            return decode(fflate.decompressSync(data.slice(RISU_SAVE_MAGIC_COMPRESSED_HEADER.length)))
        case 'stream':
        case 'risusave':
            throw new Error(
                `Unsupported save framing "${header}" for a legacy block: this decoder handles only ` +
                'the framings encodeRisuSaveLegacy writes. Use decodeRisuSave for the others.',
            )
        default:
            return unpackr.decode(data)
    }
}
