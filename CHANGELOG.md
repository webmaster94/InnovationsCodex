# Changelog

## 1.1.2 - 2026-08-22

### Changed

- Let the actor owner create patterns and choose, change, or clear their tiers without GM approval.
- Kept a pattern's tier when its content changes and synchronized the latest version to its existing world mirror.
- Made future fabrications use the latest pattern while leaving active fabricated copies unchanged.
- Preserved tiers from 1.1.0 and 1.1.1 using stable embedded Item IDs rather than names.
- Removed stale tier records and mirrors when a pattern leaves its canonical Codex or loses its Innovation identity.

## 1.1.1 - 2026-08-22

### Fixed

- Imported pre-1.1 temporary innovations that lack tier and blueprint flags when exactly one trusted legacy blueprint matches. Ambiguous items remain untouched for manual repair.

## 1.1.0 - 2026-08-22

### Added

- A TypeScript source build with automated tests and release-archive validation.
- A fixed-ID College of Innovation compendium compiled from JSON source.
- Canonical codex ownership, blueprint approvals, active-reservation records, and GM-authorized socket operations.
- Analytical Muse and Prototype Imbuements workflows for dnd5e 5.2.5 and 5.3.3.
- Recovery-safe, GM-owned accounting for parked spell slots and active imbuements.

### Changed

- Moved proficiency, spell-grant, and spell-choice advancements onto their owning feature Items.
- Limited the declared compatibility range to Foundry 13.347 through 14.
- Preserved paid Prototype Imbuement spell-slot reservations across long rests until the imbuement is recalled.
- Migrated legacy actor data without using item names as the primary identity.
- Left unknown Analytical Muse and Magical Discoveries choices open instead of inferring them from Valyra's sheet.
- Made the Prototype Imbuements activity open the Codex without consuming its free use.

## 1.0.0

- Initial module implementation.
