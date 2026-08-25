# Standalone release readiness

This fork is intentionally not coupled to the upstream release channel. Official builds use `TripleHwang/RisuVault` and never download upstream release artifacts.

The release identity is fixed as follows:

- `RISU_UPDATE_REPOSITORY` defaults to `TripleHwang/RisuVault` and can be overridden by downstream builds.
- `RISU_UPDATE_URL=https://…` can supply a compatible GitHub Release API response for update checks.
- `RISU_RELEASE_ARTIFACT_PREFIX` defaults to `RisuVault` and must match release asset names.
- The display name is `RisuVault` and the macOS identifier is `io.github.triplehwang.risuvault`. Signing and notarization remain optional release-owner policies.

The release workflow refuses tags that do not equal `v` plus `package.json`'s version. It runs the standalone release-contract check and the compatibility suite before creating draft artifacts. Draft releases require a human review and explicit publication.

## Compatibility fixtures

`test/fixtures/compatibility/manifest.json` is tracked and contains safe, synthetic legacy-format cases. Its assertions cover character, chat, message, persona, and asset round trips on a real server.

Real user backups and externally supplied upstream samples must never be committed. Keep them outside the repository and run the optional `upstream-import.test.ts` locally; it discovers `test/fixtures/upstream/upstream-backup.bin` when present. Before a public release, run representative, consented backups from each supported source version and record their provenance and hashes in the release checklist.

## Local release gate

```powershell
pnpm check
pnpm build
pnpm test:release
```

For a downstream source-update test, set `RISU_UPDATE_REPOSITORY` explicitly; official builds use this repository by default.
