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

Every self-updatable release must also contain `update-manifest.json`. The release workflow generates it after packaging and records the exact product ID (`risuvault`), channel, version, platform, architecture, byte size, GitHub Release URL, and SHA-256 for each portable archive. A release without this manifest remains visible in the app, but can only be installed manually.

The server and bundled updater fail closed. They reject another product or repository, a downgrade, a mismatched tag/channel/platform/architecture, non-HTTPS artifact URLs, oversized or truncated downloads, and a SHA-256 mismatch. HaejeokRisuAI release packages are source references only and are never installed over RisuVault.

Users can run a manual check from **Settings → System → Updates**. Portable builds can then back up and apply the verified package from the existing update dialog; Git, Docker, and unknown deployments receive the release link instead.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RISU_UPDATE_CHECK=false` | Disables update checks even when a channel is configured. |
| `RISU_UPDATE_REPOSITORY` | Overrides the default `TripleHwang/RisuVault` release repository. |
| `RISU_UPDATE_URL` | Overrides the release-check API with a GitHub Release-compatible endpoint. |
| `RISU_RELEASE_ARTIFACT_PREFIX` | Overrides the portable artifact prefix; defaults to `RisuVault`. |
| `RISU_UPDATE_PRODUCT_ID` | Overrides the manifest product ID expected by a downstream distribution. |
| `RISU_UPDATE_CHANNEL` | Selects `stable` or `beta`; defaults from the installed version (`beta` for prereleases). |
| `RISU_UPDATE_MANIFEST_ASSET` | Overrides the manifest asset name; defaults to `update-manifest.json`. |

## Release-owner responsibilities

The product identity is `RisuVault`, the release repository is `TripleHwang/RisuVault`, and the macOS identifier is `io.github.triplehwang.risuvault`. Code-signing and notarization remain release-owner policies.

The release workflow runs `pnpm check:standalone-release` and `pnpm test:compat` before building artifacts. Review and publish the resulting draft release manually.
