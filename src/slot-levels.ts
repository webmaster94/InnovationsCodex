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

export function parseSlotLevel(value: unknown): SlotLevel | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 9
    ? (parsed as SlotLevel)
    : null;
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
