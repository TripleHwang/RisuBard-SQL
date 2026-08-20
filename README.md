# RisuBard

RisuBard is a self-hosted AI roleplay application built on inherited GPLv3 RisuAI code. This repository preserves that application history while establishing a clean boundary for a future UI-independent narrative core.

## Project boundaries

- The application at the repository root is the inherited GPLv3 application.
- `packages/risubard-core/` is reserved for independently authored, UI-independent core code.
- `src/ts/risubard/` is reserved for adapters between the existing application and the new core.

See [the code-boundary architecture](docs/architecture/code-boundaries.md) and [NOTICE.md](NOTICE.md) for details.

## License

[GPL-3.0](LICENSE)
