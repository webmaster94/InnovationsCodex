import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applicableInnovationSpellGrants,
  assessFeatureChoiceMigration,
  buildFeatureAdvancementMigration,
  buildFeatureActivity,
  FEATURE_ADVANCEMENT_INVARIANTS,
  identifyInnovationSpellGrant,
  INNOVATION_SPELL_GRANTS,
  planFeatureActivityRepair,
  validateFeatureOwnedAdvancements
} from "../src/college-features.ts";

test("selects the fixed Innovation Spells grants applicable to a Bard 8", () => {
  const grants = applicableInnovationSpellGrants(8);

  assert.deepEqual(grants.map((grant) => grant.bardLevel), [3, 5, 7]);
  assert.deepEqual(grants.flatMap((grant) => grant.spells.map((spell) => spell.name)), [
    "Chromatic Orb",
    "Sanctuary",
    "Identify",
    "Enhance Ability",
    "See Invisibility",
    "Glyph of Warding",
    "Haste",
    "Fabricate",
    "Summon Construct"
  ]);
  assert.equal(grants.some((grant) => grant.bardLevel === 9), false);
});

test("identifies an Innovation Spell only from a stable compendium source", () => {
  const source = {
    name: "Renamed by the player",
    _stats: {
      compendiumSource: "Compendium.dnd5e.spells24.Item.phbsplIdentify00"
    }
  };

  assert.deepEqual(identifyInnovationSpellGrant(source), {
    grant: INNOVATION_SPELL_GRANTS[0],
    spell: INNOVATION_SPELL_GRANTS[0].spells[2]
  });
  assert.deepEqual(identifyInnovationSpellGrant({
    flags: { dnd5e: { sourceId: "Compendium.dnd5e.spells24.Item.phbsplIdentify00" } }
  }), {
    grant: INNOVATION_SPELL_GRANTS[0],
    spell: INNOVATION_SPELL_GRANTS[0].spells[2]
  });
  assert.equal(identifyInnovationSpellGrant({ name: "Identify" }), null);
});

test("does not infer Analytical Muse's tool choice when both tools are present", () => {
  const existingValue = {
    chosen: ["tool:art:calligrapher", "tool:art:jeweler"],
    migrationNote: "keep this field"
  };

  assert.deepEqual(assessFeatureChoiceMigration("analytical-muse-tool", existingValue), {
    status: "requires-user-choice",
    preservedValue: existingValue,
    recordedChoices: ["tool:art:calligrapher", "tool:art:jeweler"]
  });

  assert.equal(assessFeatureChoiceMigration("analytical-muse-tool", {
    chosen: ["tool:art:jeweler"]
  }).status, "recorded");
});

test("preserves Magical Discoveries advancement provenance and leaves absent choices unresolved", () => {
  const existingValue = {
    added: {
      "6": {
        spellA: "Compendium.example.spells.Item.spellA",
        spellB: "Compendium.example.spells.Item.spellB"
      }
    },
    replaced: {}
  };

  assert.deepEqual(assessFeatureChoiceMigration("magical-discoveries", existingValue), {
    status: "recorded",
    preservedValue: existingValue,
    recordedChoices: [
      "Compendium.example.spells.Item.spellA",
      "Compendium.example.spells.Item.spellB"
    ]
  });

  assert.deepEqual(assessFeatureChoiceMigration("magical-discoveries", undefined), {
    status: "requires-user-choice",
    preservedValue: { added: {}, replaced: {} },
    recordedChoices: []
  });
});

test("builds utility activities that leave resource consumption to module automation", () => {
  const create = buildFeatureActivity("create-innovation", "CreateActivity01");
  const prototype = buildFeatureActivity("prototype-imbuements", "PrototypeActv001");
  const analytical = buildFeatureActivity("analytical-muse", "AnalyticActivity");

  assert.equal(create.name, "Open Codex");
  assert.equal(create.flags["innovations-codex"].action, "open-codex");
  assert.deepEqual(create.consumption.targets, []);

  assert.equal(prototype.name, "Open Codex");
  assert.equal(prototype.flags["innovations-codex"].action, "open-codex");
  assert.deepEqual(prototype.consumption.targets, []);

  assert.equal(analytical.name, "Analytical Muse");
  assert.equal(analytical.flags["innovations-codex"].action, "analytical-muse");
  assert.deepEqual(analytical.consumption.targets, []);
});

test("plans a missing activity as one atomic Foundry update", () => {
  const decision = planFeatureActivityRepair("create-innovation", {}, "CreateActivity01");
  const activity = buildFeatureActivity("create-innovation", "CreateActivity01");

  assert.deepEqual(decision, {
    operation: "create",
    activityId: "CreateActivity01",
    updateData: {
      "system.activities.CreateActivity01": activity
    }
  });
});

test("canonicalizes tagged and unclaimed legacy activities without changing their IDs", () => {
  const tagged = {
    taggedActivity01: {
      _id: "taggedActivity01",
      type: "utility",
      name: "Anything",
      flags: {
        "innovations-codex": { action: "analytical-muse" }
      }
    }
  };
  assert.deepEqual(planFeatureActivityRepair(
    "analytical-muse",
    tagged,
    "unusedActivity01"
  ), {
    operation: "replace",
    activityId: "taggedActivity01",
    updateData: {
      "system.activities.taggedActivity01": buildFeatureActivity("analytical-muse", "taggedActivity01")
    }
  });

  const legacy = {
    oldCreateActv001: {
      _id: "oldCreateActv001",
      type: "utility",
      name: "Open Codex",
      flags: {}
    }
  };
  assert.deepEqual(planFeatureActivityRepair(
    "create-innovation",
    legacy,
    "unusedActivity01"
  ), {
    operation: "replace",
    activityId: "oldCreateActv001",
    updateData: {
      "system.activities.oldCreateActv001": buildFeatureActivity("create-innovation", "oldCreateActv001")
    }
  });
});

test("repairs known legacy activity IDs even when their names are blank", () => {
  const decision = planFeatureActivityRepair("analytical-muse", {
    sA575LPGjuhhtbty: {
      _id: "sA575LPGjuhhtbty",
      type: "utility",
      name: "",
      consumption: { targets: [{ type: "itemUses", value: "1" }] }
    }
  }, "unusedActivity01");

  assert.equal(decision.operation, "replace");
  assert.deepEqual(
    decision.updateData["system.activities.sA575LPGjuhhtbty"],
    buildFeatureActivity("analytical-muse", "sA575LPGjuhhtbty")
  );
});

test("does not steal a legacy-named activity claimed by another action", () => {
  const decision = planFeatureActivityRepair("create-innovation", {
    conflictingAct01: {
      _id: "conflictingAct01",
      type: "utility",
      name: "Open Codex",
      flags: {
        "innovations-codex": { action: "some-other-workflow" }
      }
    }
  }, "CreateActivity01");

  assert.equal(decision.operation, "create");
  assert.equal(decision.activityId, "CreateActivity01");
});

test("records the feature-owned advancement IDs and Bard levels as stable invariants", () => {
  assert.deepEqual(
    FEATURE_ADVANCEMENT_INVARIANTS["analytical-muse"].advancements.map(({ _id, type, level }) =>
      ({ _id, type, level })
    ),
    [
      { _id: "eM7Cb1McYUGCu065", type: "Trait", level: 3 },
      { _id: "Y3RVHX9BvcbkaBHB", type: "Trait", level: 3 }
    ]
  );
  assert.deepEqual(
    FEATURE_ADVANCEMENT_INVARIANTS["magical-discoveries"].advancements.map(({ _id, type, level }) =>
      ({ _id, type, level })
    ),
    [{ _id: "LhBXyTrb0bGFqg0L", type: "ItemChoice", level: 6 }]
  );
  assert.deepEqual(
    FEATURE_ADVANCEMENT_INVARIANTS["innovation-spells"].advancements.map(({ _id, type, level }) =>
      ({ _id, type, level })
    ),
    [
      { _id: "pL3InnovSpells01", type: "ItemGrant", level: 3 },
      { _id: "pL5InnovSpells03", type: "ItemGrant", level: 5 },
      { _id: "pL7InnovSpells04", type: "ItemGrant", level: 7 },
      { _id: "pL9InnovSpells05", type: "ItemGrant", level: 9 }
    ]
  );
});

test("repairs canonical advancement configuration without overwriting actor-specific values", () => {
  const recordedToolValue = {
    chosen: ["tool:art:calligrapher", "tool:art:jeweler"],
    legacyMarker: true
  };
  const existing = {
    eM7Cb1McYUGCu065: {
      _id: "eM7Cb1McYUGCu065",
      type: "Trait",
      level: 3,
      configuration: { mode: "default" },
      value: { chosen: ["skills:arc"] }
    },
    Y3RVHX9BvcbkaBHB: {
      _id: "Y3RVHX9BvcbkaBHB",
      type: "Trait",
      level: 3,
      configuration: {},
      value: recordedToolValue
    },
    CustomAdvancement: {
      _id: "CustomAdvancemnt",
      type: "Trait",
      level: 4,
      configuration: {},
      value: { chosen: ["skills:his"] }
    }
  };

  const migration = buildFeatureAdvancementMigration("analytical-muse", existing);
  const arcana = migration.advancements.find(({ _id }) => _id === "eM7Cb1McYUGCu065");
  const tools = migration.advancements.find(({ _id }) => _id === "Y3RVHX9BvcbkaBHB");

  assert.equal(arcana?.configuration.mode, "upgrade");
  assert.deepEqual(arcana?.value, { chosen: ["skills:arc"] });
  assert.deepEqual(tools?.value, recordedToolValue);
  assert.deepEqual(migration.unresolvedChoices, ["analytical-muse-tool"]);
  assert.deepEqual(migration.preservedUnexpectedAdvancementIds, ["CustomAdvancemnt"]);
  assert.equal(migration.advancements.some(({ _id }) => _id === "CustomAdvancemnt"), true);
});

test("leaves an absent Magical Discoveries selection empty for the player to choose", () => {
  const migration = buildFeatureAdvancementMigration("magical-discoveries", []);

  assert.deepEqual(migration.unresolvedChoices, ["magical-discoveries"]);
  assert.deepEqual(migration.advancements[0]?.value, { added: {}, replaced: {} });
});

test("validates live keyed advancement storage but requires arrays for portable pack source", () => {
  const advancements = buildFeatureAdvancementMigration("innovation-spells", []).advancements;
  const keyed = Object.fromEntries(advancements.map((advancement) => [advancement._id, advancement]));
  const feature = {
    type: "feat",
    system: {
      identifier: "innovation-spells",
      advancement: keyed
    },
    flags: {
      "innovations-codex": { feature: "innovation-spells" }
    }
  };

  assert.deepEqual(validateFeatureOwnedAdvancements("innovation-spells", feature), []);
  assert.deepEqual(
    validateFeatureOwnedAdvancements("innovation-spells", feature, { requirePortableArray: true })
      .map(({ code }) => code),
    ["non-portable-storage"]
  );
});

test("reports ownership and configuration violations without consulting actor inventory", () => {
  const advancements = buildFeatureAdvancementMigration("analytical-muse", []).advancements;
  const broken = structuredClone(advancements);
  const toolConfiguration = broken[1]?.configuration;
  if (toolConfiguration) toolConfiguration.mode = "upgrade";
  const feature = {
    type: "subclass",
    system: {
      identifier: "bard_innovation",
      advancement: broken
    },
    flags: {
      "innovations-codex": { feature: "analytical-muse" }
    }
  };

  assert.deepEqual(
    validateFeatureOwnedAdvancements("analytical-muse", feature).map(({ code }) => code),
    ["wrong-item-type", "wrong-feature-identifier", "wrong-advancement-configuration"]
  );
});

test("the shipped feature items satisfy the portable advancement contract", async () => {
  const sources = [
    ["analytical-muse", "Analytical_Muse_VC2DVEhoZ9DPjUCZ.json"],
    ["magical-discoveries", "Magical_Discoveries_01rTwGz6JAaMeyXN.json"],
    ["innovation-spells", "Innovation_Spells_uVLuEPXjnIXzAi7T.json"]
  ] as const;

  for (const [feature, filename] of sources) {
    const path = new URL(`../pack-src/college-of-innovation/${filename}`, import.meta.url);
    const source = JSON.parse(await readFile(path, "utf8")) as unknown;
    assert.deepEqual(
      validateFeatureOwnedAdvancements(feature, source, { requirePortableArray: true }),
      [],
      filename
    );
  }
});
