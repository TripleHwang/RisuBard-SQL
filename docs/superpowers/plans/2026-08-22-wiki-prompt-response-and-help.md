# Wiki Prompt Response Guidance and Help Sheet Plan

**Goal:** Ship puzzle/clue preservation in the default Wiki prompt preset, add preset-bound response guidance, and make the preset editor transparent and usable.

## Design boundary

- Keep `both` limited to memory analysis and canonical rewriting.
- Add an explicit `response` target compiled from the same active Wiki prompt preset.
- Inject response guidance only when BardWiki narrative sources are present.
- Keep core and runtime injection blocks locked, but expose their reference text in read-only resizable fields.
- Preserve existing user presets; new defaults are added only when creating a new default preset.

## Tasks

1. Add failing tests for default puzzle blocks, response compilation/injection, locked-content visibility, resizing, sectioned UI, and prompting help.
2. Extend Wiki prompt types/compiler and add the two default editable blocks.
3. Add the puzzle/clue relationship-preservation rule to the locked memory-writing contract.
4. Inject compiled response guidance into the BardWiki response context without sending it to memory analysis.
5. Build separate writing/response editor sections, readable locked fields, resize handles, and a localized floating reference sheet.
6. Update canonical architecture documentation and run targeted tests plus type checking.
