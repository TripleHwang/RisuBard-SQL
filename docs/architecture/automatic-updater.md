# Standalone automatic updater

## Default safety posture

This fork has no inherited update channel. Update checks and self-updates are disabled until the release owner explicitly sets `RISU_UPDATE_REPOSITORY=owner/repository` or supplies `RISU_UPDATE_URL`. This fail-closed default prevents a standalone installation from downloading an incompatible upstream release.

`RISU_UPDATE_REPOSITORY` selects the GitHub Release repository used by both the server and portable updater. `RISU_UPDATE_URL` may point to a compatible GitHub Release API response for update checks; it does not enable portable self-update without a repository.

## Artifact contract

Portable artifacts use `RisuBard-Standalone` by default:

| Platform | Artifact |
| --- | --- |
| Windows x64 | `RisuBard-Standalone-vX.Y.Z-win-x64.zip` |
| Linux x64 | `RisuBard-Standalone-vX.Y.Z-linux-x64.tar.gz` |
| Linux ARM64 | `RisuBard-Standalone-vX.Y.Z-linux-arm64.tar.gz` |
| macOS ARM64 | `RisuBard-Standalone-vX.Y.Z-macos-arm64.tar.gz` |

Set `RISU_RELEASE_ARTIFACT_PREFIX` only when the server, updater, and release workflow are configured to use the same value. The release workflow produces a draft release and requires a tag exactly matching `v` plus `package.json`'s version.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RISU_UPDATE_CHECK=false` | Disables update checks even when a channel is configured. |
| `RISU_UPDATE_REPOSITORY` | Required `owner/repository` for portable and source self-update. |
| `RISU_UPDATE_URL` | Overrides the release-check API with a GitHub Release-compatible endpoint. |
| `RISU_RELEASE_ARTIFACT_PREFIX` | Overrides the portable artifact prefix; defaults to `RisuBard-Standalone`. |

## Release-owner responsibilities

Before public distribution, choose the final display name, package identifier, repository, code-signing identity, notarization policy, and update channel. The neutral `local.risubard.standalone` macOS identifier is pre-release only and must not be reused by unrelated products.

The release workflow runs `pnpm check:standalone-release` and `pnpm test:compat` before building artifacts. Review and publish the resulting draft release manually.
