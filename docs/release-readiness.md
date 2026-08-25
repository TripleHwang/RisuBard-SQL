# Standalone release readiness

This fork is intentionally not coupled to an upstream release channel. By default it does not check for, download, or install upstream releases.

Before publishing, the maintainer must make these decisions and set them in the distribution environment:

- `RISU_UPDATE_REPOSITORY=owner/repository` selects the GitHub repository allowed to supply portable and source updates.
- `RISU_UPDATE_URL=https://…` can supply a compatible GitHub Release API response for update checks.
- `RISU_RELEASE_ARTIFACT_PREFIX` defaults to `RisuBard-Standalone` and must match release asset names.
- Final display name, package identifier, code-signing identity, update repository, and signing/notarization policy remain release-owner decisions. The current `local.risubard.standalone` bundle identifier is only a neutral pre-release identifier.

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

For a source update test, explicitly set `RISU_UPDATE_REPOSITORY`; otherwise the updater exits without changing any files. This fail-closed behavior is intentional.
