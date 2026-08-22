# Repository guidance

This repository builds the `innovations-codex` Foundry VTT module. Treat this file as the source of truth for repository-specific work.

## Source and generated files

- Runtime source is in `src`. Foundry loads the generated `dist/main.js` bundle declared by `module.json`.
- Compendium source is in `pack-src/college-of-innovation`. `scripts/build-packs.mjs` compiles it into `packs/college-of-innovation`.
- Do not edit `dist`, `packs`, or `release` by hand. They are generated and ignored by Git.
- Keep document `_id` and `_key` values stable. Advancement UUIDs depend on them.
- Do not restore the legacy root `main.js`, `agents.json`, or lowercase instruction notes to a release.

## Advancement ownership

- The subclass Item grants its feature Items at their subclass levels.
- Analytical Muse owns its Trait advancements.
- Innovation Spells owns its level-based ItemGrant advancements.
- Magical Discoveries owns its ItemChoice and replacement entries.
- Author `system.advancement` as an array. dnd5e 5.3.3 may normalize it to an object at runtime, but 5.2.5 requires the portable array source form.
- Feature-owned spell advancements need runtime post-processing to set Bard as `system.sourceClass`.
- Preserve `flags.dnd5e.advancementRoot`; later Magical Discoveries replacements depend on it.
- Never infer Valyra's Analytical Muse tool choice from existing proficiencies or delete an existing proficiency during migration.

## Compatibility boundaries

- Foundry support is 13.347 through 14.
- dnd5e support begins at 5.2.5 and is verified through 5.3.3. Do not widen either range without testing the new target.
- socketlib is required. Register module sockets during the socketlib-ready lifecycle and authorize mutations on the GM side.
- Summon Construct comes from `dnd-players-handbook`; keep that dependency required unless the feature is changed to work without the spell.

## Required checks

Use Node.js 22.6 or newer. Before handing off a change, run:

```text
npm run validate
```

The command must type-check, run the tests, rebuild the bundle and pack, create the release files, and validate the ZIP allowlist. If the full command cannot run, report the exact failed stage and run the remaining independent checks.

## Release rules

- Keep `package.json`, `package-lock.json`, and `module.json` versions aligned.
- Keep the manifest URL at `https://github.com/webmaster94/InnovationsCodex/releases/latest/download/module.json`.
- The `module.json` download URL must point to the ZIP attached to the matching `v<version>` release.
- Release archives may contain only `module.json`, `README.md`, `CHANGELOG.md`, `dist`, `packs`, `styles`, and `templates`.
- Do not add a license unless the maintainers choose one.
