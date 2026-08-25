# Standalone automatic updater

## Update channel

This fork never inherits the upstream update channel. Official builds default to `TripleHwang/RisuVault`; downstream distributions can override it with `RISU_UPDATE_REPOSITORY=owner/repository` or `RISU_UPDATE_URL`. `RISU_UPDATE_CHECK=false` disables checks entirely.

`RISU_UPDATE_REPOSITORY` selects the GitHub Release repository used by both the server and portable updater. `RISU_UPDATE_URL` may point to a compatible GitHub Release API response for update checks; it does not enable portable self-update without a repository.

## Artifact contract

Portable artifacts use `RisuVault` by default:

| Platform | Artifact |
| --- | --- |
| Windows x64 | `RisuVault-vX.Y.Z-win-x64.zip` |
| Linux x64 | `RisuVault-vX.Y.Z-linux-x64.tar.gz` |
| Linux ARM64 | `RisuVault-vX.Y.Z-linux-arm64.tar.gz` |
| macOS ARM64 | `RisuVault-vX.Y.Z-macos-arm64.tar.gz` |

Set `RISU_RELEASE_ARTIFACT_PREFIX` only when the server, updater, and release workflow are configured to use the same value. The release workflow produces a draft release and requires a tag exactly matching `v` plus `package.json`'s version.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RISU_UPDATE_CHECK=false` | Disables update checks even when a channel is configured. |
| `RISU_UPDATE_REPOSITORY` | Overrides the default `TripleHwang/RisuVault` release repository. |
| `RISU_UPDATE_URL` | Overrides the release-check API with a GitHub Release-compatible endpoint. |
| `RISU_RELEASE_ARTIFACT_PREFIX` | Overrides the portable artifact prefix; defaults to `RisuVault`. |

## Release-owner responsibilities

The product identity is `RisuVault`, the release repository is `TripleHwang/RisuVault`, and the macOS identifier is `io.github.triplehwang.risuvault`. Code-signing and notarization remain release-owner policies.

The release workflow runs `pnpm check:standalone-release` and `pnpm test:compat` before building artifacts. Review and publish the resulting draft release manually.
