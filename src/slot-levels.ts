export type SlotLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface SlotLevelSource {
  blueprintId?: string | null;
  blueprintUuid?: string | null;
  blueprintName?: string | null;
  itemLevel?: unknown;
  slotLevelsByItemId?: Record<string, unknown> | null;
  slotLevelsByUuid?: Record<string, unknown> | null;
  slotLevelsByName?: Record<string, unknown> | null;
  allowNameFallback?: boolean;
}

export interface SlotLevelMaps {
  slotLevelsByItemId: Record<string, SlotLevel>;
  slotLevelsByName: Record<string, SlotLevel>;
}

export interface LegacyTemporarySource {
  name: string;
  type?: string | null;
  identifier?: string | null;
  blueprintUuid?: string | null;
  slotLevel?: unknown;
}

export interface LegacyApprovedBlueprint {
  uuid: string;
  name: string;
  type?: string | null;
  identifier?: string | null;
  slotLevel: unknown;
}

export interface LegacyTemporaryLink {
  blueprintUuid: string;
  slotLevel: SlotLevel;
}

export function parseSlotLevel(value: unknown): SlotLevel | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 9
    ? (parsed as SlotLevel)
    : null;
}

export function resolveLegacyTemporaryLink(
  temporary: LegacyTemporarySource,
  blueprints: readonly LegacyApprovedBlueprint[]
): LegacyTemporaryLink | null {
  const hasExplicitLevel = temporary.slotLevel !== null
    && temporary.slotLevel !== undefined
    && !(typeof temporary.slotLevel === "string" && temporary.slotLevel.trim() === "");
  const explicitLevel = parseSlotLevel(temporary.slotLevel);
  if (hasExplicitLevel && explicitLevel === null) return null;
  const approved = blueprints.flatMap((blueprint) => {
    const slotLevel = parseSlotLevel(blueprint.slotLevel);
    return slotLevel === null ? [] : [{ ...blueprint, slotLevel }];
  }).filter((blueprint) => {
    const typeMatches = !temporary.type || !blueprint.type || temporary.type === blueprint.type;
    const identifierMatches = !temporary.identifier || !blueprint.identifier
      || temporary.identifier === blueprint.identifier;
    return typeMatches && identifierMatches;
  });

  if (temporary.blueprintUuid) {
    const blueprint = approved.find((candidate) => candidate.uuid === temporary.blueprintUuid);
    if (!blueprint || (explicitLevel !== null && explicitLevel !== blueprint.slotLevel)) return null;
    return { blueprintUuid: blueprint.uuid, slotLevel: blueprint.slotLevel };
  }

  const temporaryNameMatch = /^Temporary\s+(.+)$/i.exec(temporary.name.trim());
  if (!temporaryNameMatch) return null;
  const blueprintName = temporaryNameMatch[1].trim();
  const matches = approved.filter((candidate) => candidate.name === blueprintName
    && (explicitLevel === null || candidate.slotLevel === explicitLevel));
  if (matches.length !== 1) return null;
  return { blueprintUuid: matches[0].uuid, slotLevel: matches[0].slotLevel };
}

function readOwnPath(value: unknown, path: string): unknown {
  let cursor: unknown = value;
  for (const segment of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function resolveSlotLevel(source: SlotLevelSource): SlotLevel | null {
  if (source.itemLevel === null) return null;

  const fromItem = parseSlotLevel(source.itemLevel);
  if (fromItem !== null) return fromItem;

  const fromItemId = source.blueprintId
    ? parseSlotLevel(source.slotLevelsByItemId?.[source.blueprintId])
    : null;
  if (fromItemId !== null) return fromItemId;

  const uuidKey = source.blueprintUuid ?? source.blueprintId;
  const directLegacy = uuidKey
    ? parseSlotLevel(source.slotLevelsByUuid?.[uuidKey])
    : null;
  if (directLegacy !== null) return directLegacy;

  const nestedLegacy = source.blueprintUuid
    ? parseSlotLevel(readOwnPath(source.slotLevelsByUuid, source.blueprintUuid))
    : null;
  if (nestedLegacy !== null) return nestedLegacy;

  const fromName = source.allowNameFallback !== false && source.blueprintName
    ? parseSlotLevel(source.slotLevelsByName?.[source.blueprintName])
    : null;
  if (fromName !== null) return fromName;

  return null;
}

export function updateSlotLevelMaps(
  source: Pick<SlotLevelSource, "blueprintId" | "blueprintName" | "slotLevelsByItemId" | "slotLevelsByName">,
  level: SlotLevel | null
): SlotLevelMaps {
  const byItemId = { ...(source.slotLevelsByItemId ?? {}) } as Record<string, SlotLevel>;
  const byName = { ...(source.slotLevelsByName ?? {}) } as Record<string, SlotLevel>;

  if (source.blueprintId) {
    if (level === null) delete byItemId[source.blueprintId];
    else byItemId[source.blueprintId] = level;
  }

  if (source.blueprintName) {
    if (level === null) delete byName[source.blueprintName];
    else byName[source.blueprintName] = level;
  }

  return { slotLevelsByItemId: byItemId, slotLevelsByName: byName };
}
