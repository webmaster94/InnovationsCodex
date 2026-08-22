export const MODULE_ID = "innovations-codex";

export const CREATE_INNOVATION_DESCRIPTION = `<p>You channel your ingenuity to produce arcane innovations. Use this feature to open your <strong>Innovations Codex</strong> — a personal workshop where you design, categorize, and fabricate magical items.</p>
<p>When you use this feature, your codex is automatically added to your inventory if you don't already have one. From the codex window you can:</p>
<ul>
<li><strong>Create</strong> new innovation patterns in your personal Codex.</li>
<li><strong>Choose</strong> each pattern's tier, up to the highest tier your Bard level supports.</li>
<li><strong>Fabricate</strong> innovations onto yourself or allies by expending a spell slot of the appropriate level.</li>
<li><strong>Recall</strong> fabricated innovations, removing them from their holder.</li>
</ul>
<p>New patterns start as <em>Uncategorized</em>. Choose a tier before fabricating them. Later edits automatically apply to future fabrications without changing active copies.</p>`;

const LEGACY_CREATE_DESCRIPTION_MARKERS = [
  "new innovation blueprints for your DM to review",
  "new patterns for GM approval and tier assignment",
  "a GM approves their pattern tier"
] as const;

export function shouldReplaceLegacyCreateDescription(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return LEGACY_CREATE_DESCRIPTION_MARKERS.some((marker) => value.includes(marker));
}

export interface InnovationSpellSource {
  readonly name: string;
  readonly spellLevel: 1 | 2 | 3 | 4 | 5;
  readonly uuid: string;
}

export interface InnovationSpellGrant {
  readonly advancementId: string;
  readonly bardLevel: 3 | 5 | 7 | 9;
  readonly title: string;
  readonly spells: readonly InnovationSpellSource[];
}

export const INNOVATION_SPELL_GRANTS = [
  {
    advancementId: "pL3InnovSpells01",
    bardLevel: 3,
    title: "Innovation Spells: 1st and 2nd Level",
    spells: [
      {
        name: "Chromatic Orb",
        spellLevel: 1,
        uuid: "Compendium.dnd5e.spells24.Item.phbsplChromaticO"
      },
      {
        name: "Sanctuary",
        spellLevel: 1,
        uuid: "Compendium.dnd5e.spells24.Item.phbSanctuary0000"
      },
      {
        name: "Identify",
        spellLevel: 1,
        uuid: "Compendium.dnd5e.spells24.Item.phbsplIdentify00"
      },
      {
        name: "Enhance Ability",
        spellLevel: 2,
        uuid: "Compendium.dnd5e.spells24.Item.phbsplEnhanceAbi"
      },
      {
        name: "See Invisibility",
        spellLevel: 2,
        uuid: "Compendium.dnd5e.spells24.Item.phbsplSeeInvisib"
      }
    ]
  },
  {
    advancementId: "pL5InnovSpells03",
    bardLevel: 5,
    title: "Innovation Spells: 3rd Level",
    spells: [
      {
        name: "Glyph of Warding",
        spellLevel: 3,
        uuid: "Compendium.dnd5e.spells24.Item.phbsplGlyphofWar"
      },
      {
        name: "Haste",
        spellLevel: 3,
        uuid: "Compendium.dnd5e.spells24.Item.phbsplHaste00000"
      }
    ]
  },
  {
    advancementId: "pL7InnovSpells04",
    bardLevel: 7,
    title: "Innovation Spells: 4th Level",
    spells: [
      {
        name: "Fabricate",
        spellLevel: 4,
        uuid: "Compendium.dnd5e.spells24.Item.phbsplFabricate0"
      },
      {
        name: "Summon Construct",
        spellLevel: 4,
        uuid: "Compendium.dnd-players-handbook.spells.Item.phbsplSummonCons"
      }
    ]
  },
  {
    advancementId: "pL9InnovSpells05",
    bardLevel: 9,
    title: "Innovation Spells: 5th Level",
    spells: [
      {
        name: "Animate Objects",
        spellLevel: 5,
        uuid: "Compendium.dnd5e.spells24.Item.phbsplAnimateObj"
      },
      {
        name: "Creation",
        spellLevel: 5,
        uuid: "Compendium.dnd5e.spells24.Item.phbsplCreation00"
      }
    ]
  }
] as const satisfies readonly InnovationSpellGrant[];

export interface IdentifiedInnovationSpellGrant {
  readonly grant: InnovationSpellGrant;
  readonly spell: InnovationSpellSource;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
    current = record[key];
  }
  return current;
}

function compendiumSourceUuid(source: unknown): string | null {
  if (typeof source === "string") return source.startsWith("Compendium.") ? source : null;

  const candidates = [
    valueAtPath(source, ["_stats", "compendiumSource"]),
    valueAtPath(source, ["flags", "core", "sourceId"]),
    valueAtPath(source, ["flags", "dnd5e", "sourceId"]),
    valueAtPath(source, ["sourceUuid"]),
    valueAtPath(source, ["sourceId"]),
    valueAtPath(source, ["uuid"])
  ];
  const match = candidates.find((candidate) =>
    typeof candidate === "string" && candidate.startsWith("Compendium.")
  );
  return typeof match === "string" ? match : null;
}

export function applicableInnovationSpellGrants(bardLevel: unknown): readonly InnovationSpellGrant[] {
  const level = Number(bardLevel);
  if (!Number.isInteger(level) || level < 0) return [];
  return INNOVATION_SPELL_GRANTS.filter((grant) => grant.bardLevel <= level);
}

export function identifyInnovationSpellGrant(source: unknown): IdentifiedInnovationSpellGrant | null {
  const uuid = compendiumSourceUuid(source);
  if (!uuid) return null;

  for (const grant of INNOVATION_SPELL_GRANTS) {
    const spell = grant.spells.find((candidate) => candidate.uuid === uuid);
    if (spell) return { grant, spell };
  }
  return null;
}

export type FeatureChoiceKind = "analytical-muse-tool" | "magical-discoveries";

export interface FeatureChoiceMigrationAssessment {
  readonly status: "recorded" | "requires-user-choice";
  readonly preservedValue: unknown;
  readonly recordedChoices: readonly string[];
}

const ANALYTICAL_MUSE_TOOL_CHOICES = new Set([
  "tool:art:calligrapher",
  "tool:art:jeweler"
]);

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (value instanceof Set) {
    return [...value].filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function magicalDiscoverySources(value: unknown): string[] {
  const added = asRecord(valueAtPath(value, ["added"]));
  if (!added) return [];

  const sources: string[] = [];
  for (const additions of Object.values(added)) {
    const additionsByItemId = asRecord(additions);
    if (!additionsByItemId) continue;
    for (const source of Object.values(additionsByItemId)) {
      if (typeof source === "string" && !sources.includes(source)) sources.push(source);
    }
  }
  return sources;
}

export function assessFeatureChoiceMigration(
  kind: FeatureChoiceKind,
  existingValue: unknown
): FeatureChoiceMigrationAssessment {
  if (kind === "analytical-muse-tool") {
    const preservedValue = existingValue ?? { chosen: [] };
    const recordedChoices = stringValues(valueAtPath(existingValue, ["chosen"]))
      .filter((choice) => ANALYTICAL_MUSE_TOOL_CHOICES.has(choice));
    return {
      status: recordedChoices.length === 1 ? "recorded" : "requires-user-choice",
      preservedValue,
      recordedChoices
    };
  }

  const preservedValue = existingValue ?? { added: {}, replaced: {} };
  const recordedChoices = magicalDiscoverySources(existingValue);
  return {
    status: recordedChoices.length >= 2 ? "recorded" : "requires-user-choice",
    preservedValue,
    recordedChoices
  };
}

export type AutomatableFeature = "create-innovation" | "prototype-imbuements" | "analytical-muse";
export type FeatureActivityAction = "open-codex" | "analytical-muse";

export interface FeatureActivitySource {
  readonly _id: string;
  readonly type: "utility";
  readonly name: string;
  readonly sort: number;
  readonly activation: {
    readonly type: "action";
    readonly value: number;
    readonly override: true;
  };
  readonly consumption: {
    readonly scaling: { readonly allowed: false };
    readonly targets: readonly unknown[];
  };
  readonly description: { readonly chatFlavor: string };
  readonly duration: {
    readonly units: "inst";
    readonly concentration: false;
    readonly override: false;
  };
  readonly effects: readonly unknown[];
  readonly range: {
    readonly units: "self";
    readonly override: false;
  };
  readonly target: {
    readonly override: false;
    readonly prompt: false;
  };
  readonly uses: {
    readonly spent: 0;
    readonly max: "";
    readonly recovery: readonly unknown[];
  };
  readonly roll: {
    readonly prompt: false;
    readonly visible: false;
  };
  readonly flags: {
    readonly "innovations-codex": {
      readonly action: FeatureActivityAction;
    };
  };
}

const ACTIVITY_CONTRACT = {
  "create-innovation": {
    action: "open-codex",
    name: "Open Codex"
  },
  "prototype-imbuements": {
    action: "open-codex",
    name: "Open Codex"
  },
  "analytical-muse": {
    action: "analytical-muse",
    name: "Analytical Muse"
  }
} as const satisfies Record<AutomatableFeature, {
  readonly action: FeatureActivityAction;
  readonly name: string;
}>;

function requireDocumentId(id: string): void {
  if (!/^[A-Za-z0-9]{16}$/.test(id)) {
    throw new RangeError("Foundry document IDs must contain exactly 16 letters or numbers.");
  }
}

export function buildFeatureActivity(
  feature: AutomatableFeature,
  activityId: string
): FeatureActivitySource {
  requireDocumentId(activityId);
  const contract = ACTIVITY_CONTRACT[feature];
  return {
    _id: activityId,
    type: "utility",
    name: contract.name,
    sort: 0,
    activation: { type: "action", value: 1, override: true },
    consumption: { scaling: { allowed: false }, targets: [] },
    description: { chatFlavor: "" },
    duration: { units: "inst", concentration: false, override: false },
    effects: [],
    range: { units: "self", override: false },
    target: { override: false, prompt: false },
    uses: { spent: 0, max: "", recovery: [] },
    roll: { prompt: false, visible: false },
    flags: {
      [MODULE_ID]: { action: contract.action }
    }
  };
}

export interface FeatureActivityRepairDecision {
  readonly operation: "replace" | "create";
  readonly activityId: string;
  readonly updateData: Readonly<Record<string, unknown>>;
}

interface ActivityEntry {
  readonly id: string;
  readonly source: Record<string, unknown>;
}

function activityEntries(activities: unknown): ActivityEntry[] {
  if (Array.isArray(activities)) {
    return activities.flatMap((activity) => {
      const source = asRecord(activity);
      const id = source?._id ?? source?.id;
      return source && typeof id === "string" ? [{ id, source }] : [];
    });
  }

  const record = asRecord(activities);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, activity]) => {
    const source = asRecord(activity);
    if (!source) return [];
    const id = typeof source._id === "string"
      ? source._id
      : typeof source.id === "string" ? source.id : key;
    return [{ id, source }];
  });
}

export function planFeatureActivityRepair(
  feature: AutomatableFeature,
  activities: unknown,
  newActivityId: string
): FeatureActivityRepairDecision {
  const contract = ACTIVITY_CONTRACT[feature];
  const entries = activityEntries(activities);
  const knownLegacyIds = feature === "create-innovation"
    ? new Set(["dNcmKVMGHyOIjY8W"])
    : feature === "prototype-imbuements"
      ? new Set(["Ym0RaFNOztdvVgvT"])
      : new Set(["sA575LPGjuhhtbty"]);
  const tagged = entries.find(({ source }) =>
    valueAtPath(source, ["flags", MODULE_ID, "action"]) === contract.action
  );
  const legacy = tagged ?? entries.find(({ id, source }) => {
    const claimedAction = valueAtPath(source, ["flags", MODULE_ID, "action"]);
    return (knownLegacyIds.has(id) || (source.type === "utility" && source.name === contract.name))
      && (claimedAction === undefined || claimedAction === null || claimedAction === "");
  });
  if (legacy) {
    const activity = buildFeatureActivity(feature, legacy.id);
    return {
      operation: "replace",
      activityId: legacy.id,
      updateData: {
        [`system.activities.${legacy.id}`]: activity
      }
    };
  }

  const activity = buildFeatureActivity(feature, newActivityId);
  return {
    operation: "create",
    activityId: newActivityId,
    updateData: {
      [`system.activities.${newActivityId}`]: activity
    }
  };
}

export type AdvancementFeature = "analytical-muse" | "magical-discoveries" | "innovation-spells";

export interface PortableAdvancementSource {
  _id: string;
  type: string;
  level: number;
  title: string;
  configuration: Record<string, unknown>;
  value: unknown;
  hint?: string;
  flags?: Record<string, unknown>;
}

export interface FeatureAdvancementInvariant {
  readonly identifier: AdvancementFeature;
  readonly featureFlag: AdvancementFeature;
  readonly itemType: "feat";
  readonly advancements: readonly PortableAdvancementSource[];
  readonly ambiguousChoices: readonly FeatureChoiceKind[];
  readonly requiresBardSourceClassRepair: boolean;
}

const ANALYTICAL_MUSE_ADVANCEMENTS = [
  {
    _id: "eM7Cb1McYUGCu065",
    type: "Trait",
    level: 3,
    title: "Arcana Training",
    configuration: {
      mode: "upgrade",
      allowReplacements: false,
      grants: ["skills:arc"],
      choices: []
    },
    value: { chosen: [] },
    hint: "Gain Arcana proficiency, or expertise if already proficient.",
    flags: {}
  },
  {
    _id: "Y3RVHX9BvcbkaBHB",
    type: "Trait",
    level: 3,
    title: "Artisan's Training",
    configuration: {
      mode: "default",
      allowReplacements: false,
      grants: [],
      choices: [
        {
          count: 1,
          pool: ["tool:art:calligrapher", "tool:art:jeweler"]
        }
      ]
    },
    value: { chosen: [] },
    hint: "Choose calligrapher's supplies or jeweler's tools.",
    flags: {}
  }
] satisfies readonly PortableAdvancementSource[];

const MAGICAL_DISCOVERIES_CHOICES: Record<string, { count: number | null; replacement: boolean }> = {
  "6": { count: 2, replacement: false }
};
for (let level = 7; level <= 20; level += 1) {
  MAGICAL_DISCOVERIES_CHOICES[String(level)] = { count: null, replacement: true };
}

const MAGICAL_DISCOVERIES_ADVANCEMENTS = [
  {
    _id: "LhBXyTrb0bGFqg0L",
    type: "ItemChoice",
    level: 6,
    title: "Magical Discoveries",
    configuration: {
      allowDrops: true,
      choices: MAGICAL_DISCOVERIES_CHOICES,
      pool: [],
      type: "spell",
      spell: {
        ability: ["cha"],
        uses: { max: "", per: "", requireSlot: false },
        method: "spell",
        prepared: 2
      },
      restriction: {
        level: "available",
        list: ["class:cleric", "class:druid", "class:wizard"],
        subtype: "",
        type: "spell"
      }
    },
    value: { added: {}, replaced: {} },
    hint: "Choose two Cleric, Druid, or Wizard spells you can cast. At each later Bard level, you may replace one.",
    flags: {}
  }
] satisfies readonly PortableAdvancementSource[];

function buildInnovationSpellAdvancement(grant: InnovationSpellGrant): PortableAdvancementSource {
  return {
    _id: grant.advancementId,
    type: "ItemGrant",
    level: grant.bardLevel,
    title: grant.title,
    configuration: {
      items: grant.spells.map(({ uuid }) => ({ uuid, optional: false })),
      optional: false,
      spell: {
        ability: ["cha"],
        uses: { max: "", per: "", requireSlot: false },
        method: "spell",
        prepared: 2
      }
    },
    value: {},
    hint: "",
    flags: {}
  };
}

const INNOVATION_SPELL_ADVANCEMENTS = INNOVATION_SPELL_GRANTS.map(buildInnovationSpellAdvancement);

export const FEATURE_ADVANCEMENT_INVARIANTS = {
  "analytical-muse": {
    identifier: "analytical-muse",
    featureFlag: "analytical-muse",
    itemType: "feat",
    advancements: ANALYTICAL_MUSE_ADVANCEMENTS,
    ambiguousChoices: ["analytical-muse-tool"],
    requiresBardSourceClassRepair: false
  },
  "magical-discoveries": {
    identifier: "magical-discoveries",
    featureFlag: "magical-discoveries",
    itemType: "feat",
    advancements: MAGICAL_DISCOVERIES_ADVANCEMENTS,
    ambiguousChoices: ["magical-discoveries"],
    requiresBardSourceClassRepair: true
  },
  "innovation-spells": {
    identifier: "innovation-spells",
    featureFlag: "innovation-spells",
    itemType: "feat",
    advancements: INNOVATION_SPELL_ADVANCEMENTS,
    ambiguousChoices: [],
    requiresBardSourceClassRepair: true
  }
} as const satisfies Record<AdvancementFeature, FeatureAdvancementInvariant>;

function portableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portableClone);
  if (value instanceof Set) return [...value].map(portableClone);
  const record = asRecord(value);
  if (!record) return value;

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, portableClone(entry)])
  );
}

function advancementSources(storage: unknown): PortableAdvancementSource[] {
  const entries: Array<[string | null, unknown]> = Array.isArray(storage)
    ? storage.map((entry) => [null, entry])
    : Object.entries(asRecord(storage) ?? {});

  return entries.flatMap(([storageId, entry]) => {
    const source = asRecord(portableClone(entry));
    if (!source) return [];
    const id = typeof source._id === "string"
      ? source._id
      : typeof storageId === "string" ? storageId : "";
    return [{ ...source, _id: id } as unknown as PortableAdvancementSource];
  });
}

function cloneAdvancement(source: PortableAdvancementSource): PortableAdvancementSource {
  return portableClone(source) as PortableAdvancementSource;
}

export interface FeatureAdvancementMigration {
  readonly advancements: PortableAdvancementSource[];
  readonly unresolvedChoices: FeatureChoiceKind[];
  readonly preservedUnexpectedAdvancementIds: string[];
}

export function buildFeatureAdvancementMigration(
  feature: AdvancementFeature,
  existingStorage: unknown
): FeatureAdvancementMigration {
  const invariant = FEATURE_ADVANCEMENT_INVARIANTS[feature];
  const unmatched = advancementSources(existingStorage);
  const advancements = invariant.advancements.map((template) => {
    const existingIndex = unmatched.findIndex(({ _id }) => _id === template._id);
    const existing = existingIndex >= 0 ? unmatched.splice(existingIndex, 1)[0] : undefined;
    const repaired = cloneAdvancement(template);
    if (existing && Object.prototype.hasOwnProperty.call(existing, "value")) {
      repaired.value = portableClone(existing.value);
    }
    return repaired;
  });

  const unresolvedChoices: FeatureChoiceKind[] = [];
  if (feature === "analytical-muse") {
    const tools = advancements.find(({ _id }) => _id === "Y3RVHX9BvcbkaBHB");
    if (assessFeatureChoiceMigration("analytical-muse-tool", tools?.value).status === "requires-user-choice") {
      unresolvedChoices.push("analytical-muse-tool");
    }
  } else if (feature === "magical-discoveries") {
    const discoveries = advancements.find(({ _id }) => _id === "LhBXyTrb0bGFqg0L");
    if (assessFeatureChoiceMigration("magical-discoveries", discoveries?.value).status === "requires-user-choice") {
      unresolvedChoices.push("magical-discoveries");
    }
  }

  const preservedUnexpectedAdvancementIds = unmatched.map(({ _id }) => _id);
  advancements.push(...unmatched.map(cloneAdvancement));
  return { advancements, unresolvedChoices, preservedUnexpectedAdvancementIds };
}

export type FeatureAdvancementIssueCode =
  | "wrong-item-type"
  | "wrong-feature-identifier"
  | "wrong-feature-flag"
  | "non-portable-storage"
  | "invalid-advancement-id"
  | "duplicate-advancement-id"
  | "missing-advancement"
  | "unexpected-advancement"
  | "wrong-advancement-type"
  | "wrong-advancement-level"
  | "wrong-advancement-configuration";

export interface FeatureAdvancementIssue {
  readonly code: FeatureAdvancementIssueCode;
  readonly advancementId?: string;
  readonly message: string;
}

export interface FeatureAdvancementValidationOptions {
  readonly requirePortableArray?: boolean;
}

function normalizedForComparison(value: unknown): unknown {
  if (value instanceof Set) return [...value].map(normalizedForComparison);
  if (Array.isArray(value)) return value.map(normalizedForComparison);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, normalizedForComparison(record[key])])
  );
}

function configurationsMatch(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(normalizedForComparison(actual)) === JSON.stringify(normalizedForComparison(expected));
}

export function validateFeatureOwnedAdvancements(
  feature: AdvancementFeature,
  featureSource: unknown,
  options: FeatureAdvancementValidationOptions = {}
): FeatureAdvancementIssue[] {
  const invariant = FEATURE_ADVANCEMENT_INVARIANTS[feature];
  const source = asRecord(featureSource);
  const issues: FeatureAdvancementIssue[] = [];

  if (source?.type !== invariant.itemType) {
    issues.push({
      code: "wrong-item-type",
      message: `${feature} advancements must be owned by a feat item.`
    });
  }
  if (valueAtPath(source, ["system", "identifier"]) !== invariant.identifier) {
    issues.push({
      code: "wrong-feature-identifier",
      message: `Expected system.identifier to be ${invariant.identifier}.`
    });
  }
  if (valueAtPath(source, ["flags", MODULE_ID, "feature"]) !== invariant.featureFlag) {
    issues.push({
      code: "wrong-feature-flag",
      message: `Expected the ${MODULE_ID} feature flag to be ${invariant.featureFlag}.`
    });
  }

  const storage = valueAtPath(source, ["system", "advancement"]);
  if (options.requirePortableArray && !Array.isArray(storage)) {
    issues.push({
      code: "non-portable-storage",
      message: "Portable pack sources must store system.advancement as an array."
    });
  }

  const actual = advancementSources(storage);
  const seenIds = new Set<string>();
  for (const advancement of actual) {
    if (!/^[A-Za-z0-9]{16}$/.test(advancement._id)) {
      issues.push({
        code: "invalid-advancement-id",
        advancementId: advancement._id,
        message: `Advancement ID ${advancement._id || "<missing>"} is not a 16-character Foundry ID.`
      });
    }
    if (seenIds.has(advancement._id)) {
      issues.push({
        code: "duplicate-advancement-id",
        advancementId: advancement._id,
        message: `Advancement ID ${advancement._id} occurs more than once.`
      });
    }
    seenIds.add(advancement._id);
  }

  const expectedIds = new Set(invariant.advancements.map(({ _id }) => _id));
  for (const expected of invariant.advancements) {
    const advancement = actual.find(({ _id }) => _id === expected._id);
    if (!advancement) {
      issues.push({
        code: "missing-advancement",
        advancementId: expected._id,
        message: `Missing ${expected.title} advancement ${expected._id}.`
      });
      continue;
    }
    if (advancement.type !== expected.type) {
      issues.push({
        code: "wrong-advancement-type",
        advancementId: expected._id,
        message: `${expected._id} must use advancement type ${expected.type}.`
      });
    }
    if (advancement.level !== expected.level) {
      issues.push({
        code: "wrong-advancement-level",
        advancementId: expected._id,
        message: `${expected._id} must apply at Bard level ${expected.level}.`
      });
    }
    if (!configurationsMatch(advancement.configuration, expected.configuration)) {
      issues.push({
        code: "wrong-advancement-configuration",
        advancementId: expected._id,
        message: `${expected._id} does not match the College of Innovation advancement contract.`
      });
    }
  }

  for (const advancement of actual) {
    if (!expectedIds.has(advancement._id)) {
      issues.push({
        code: "unexpected-advancement",
        advancementId: advancement._id,
        message: `Unexpected advancement ${advancement._id || "<missing>"} is present on ${feature}.`
      });
    }
  }
  return issues;
}
