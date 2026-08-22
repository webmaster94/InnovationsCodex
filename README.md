# Innovations Codex

Innovations Codex implements the College of Innovation homebrew subclass for the Foundry Virtual Tabletop dnd5e system. It provides a compendium with the subclass and its features, plus automation for the character's codex, innovation blueprints, prototype fabrication, spell-slot reservations, and Analytical Muse checks.

## Compatibility

| Component | Declared compatibility |
| --- | --- |
| Foundry Virtual Tabletop | 13.347 through 14 |
| dnd5e system | Minimum 5.2.5, verified 5.3.3 |
| socketlib | Required |
| D&D Player's Handbook module | Recommended for the Summon Construct grant |

The manifest does not declare support for Foundry 12, dnd5e versions before 5.2.5, or future dnd5e major releases. Summon Construct is stored in the premium `dnd-players-handbook` pack rather than the core dnd5e spell pack. Without that module, the rest of Innovations Codex remains available and the missing spell grant is reported to the GM.

## Installation

In Foundry's **Install Module** dialog, paste this manifest URL:

```text
https://github.com/webmaster94/InnovationsCodex/releases/latest/download/module.json
```

Enable Innovations Codex and socketlib in the world. Import or drag **College of Innovation** from the module's **College of Innovation** compendium onto a Bard.

## Compendium design

The pack uses stable document IDs so its advancement UUIDs remain valid across rebuilds. Advancement data is kept with the feature that owns it:

- **College of Innovation** grants the subclass feature Items at levels 3, 6, 10, and 14.
- **Analytical Muse** owns its Arcana and tool proficiency advancements.
- **Innovation Spells** owns its spell grants at Bard levels 3, 5, 7, and 9.
- **Magical Discoveries** owns its two-spell choice and later replacement entries.

Pack source stores `system.advancement` as an array for dnd5e 5.2.5 compatibility. dnd5e 5.3.3 accepts that format and may normalize it to an object keyed by advancement ID at runtime.

Advancement-added spells from feature Items do not receive `system.sourceClass` automatically because the advancement owner is a feat. The module repairs those spell records to use Bard while preserving dnd5e's `flags.dnd5e.advancementRoot` link used by later Magical Discoveries replacements. Features copied manually from an older installation are repaired during the GM migration.

Legacy migrations do not guess an Analytical Muse tool or Magical Discoveries spells. Unrecorded choices stay open. New characters make and track those selections through the feature Items' advancements.

## Development

Node.js 22.6 or newer is required.

```text
npm ci
npm run typecheck
npm test
npm run build
npm run package
```

`npm run build` bundles `src/main.ts` and compiles `pack-src/college-of-innovation` into a LevelDB compendium. `npm run package` rebuilds those outputs, creates `release/innovations-codex.zip` and `release/module.json`, and validates the release archive. `npm run validate` runs type checking, tests, packaging, and archive validation as the complete release check.

Edit compendium documents in `pack-src`, not in the generated `packs` directory. The `dist`, `packs`, and `release` directories are build outputs.

## Releases

Push a tag matching the manifest version, such as `v1.1.1`. The release workflow rejects a tag that does not match `module.json`, runs the full validation command, and attaches these installable assets to the GitHub release:

- `innovations-codex.zip`
- `module.json`
