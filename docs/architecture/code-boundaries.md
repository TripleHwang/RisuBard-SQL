# Code boundaries

RisuBard keeps inherited GPLv3 application code and future independently authored core code structurally distinct.

## Existing application

The repository root contains the PocketRisu-derived GPLv3 application. Its license, original copyright notices, and Git history must remain intact. Official PocketRisu changes may be reviewed and selectively integrated from the `upstream` remote.

## Independent core

`packages/risubard-core/` is reserved for a future UI-independent engine authored specifically for RisuBard.

PocketRisu code must not be copied or mechanically translated into this package. Shared behavior must be designed from independent contracts and implemented without transplanting inherited application code.

No core functionality is introduced during repository bootstrap.

## Adapter layer

`src/ts/risubard/` is reserved for adapters between the inherited application and the independent core. Application-specific state, UI types, and integration behavior belong here rather than in the core package.
