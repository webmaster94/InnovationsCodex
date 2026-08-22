import { parseSlotLevel, type SlotLevel } from "./slot-levels.ts";

export function canManageActorPatterns(user: {
  isGM: boolean;
  isOwner: boolean;
}): boolean {
  return user.isGM || user.isOwner;
}

export interface BlueprintRevision<TSnapshot> {
  blueprintUuid: string;
  codexUuid: string;
  ownerActorUuid: string;
  snapshot: TSnapshot;
}

export type BlueprintRevisionPlan<TAssignment, TSnapshot> =
  | {
    kind: "assigned";
    tier: SlotLevel;
    assignment: TAssignment;
    source: TSnapshot;
  }
  | {
    kind: "unassigned";
    tier: null;
    source: TSnapshot;
  }
  | {
    kind: "conflict";
    reason: "INVALID_TIER" | "IDENTITY_MISMATCH";
  };

export function refreshTierAssignmentAfterEdit<
  TAssignment extends { readonly snapshot: unknown },
  TSnapshot
>(
  assignment: TAssignment,
  currentSnapshot: TSnapshot
): Omit<TAssignment, "snapshot"> & { snapshot: TSnapshot } {
  return {
    ...assignment,
    snapshot: structuredClone(currentSnapshot)
  };
}

export function planBlueprintRevision<
  TAssignment extends {
    readonly blueprintUuid: string;
    readonly codexUuid: string;
    readonly ownerActorUuid: string;
    readonly slotLevel: unknown;
    readonly snapshot: unknown;
  },
  TSnapshot
>(
  assignment: TAssignment | null | undefined,
  revision: BlueprintRevision<TSnapshot>
): BlueprintRevisionPlan<
  Omit<TAssignment, "snapshot"> & { snapshot: TSnapshot },
  TSnapshot
> {
  const source = structuredClone(revision.snapshot);
  if (!assignment) return { kind: "unassigned", tier: null, source };

  const tier = parseSlotLevel(assignment.slotLevel);
  if (tier === null) return { kind: "conflict", reason: "INVALID_TIER" };
  if (assignment.blueprintUuid !== revision.blueprintUuid
    || assignment.codexUuid !== revision.codexUuid
    || assignment.ownerActorUuid !== revision.ownerActorUuid) {
    return { kind: "conflict", reason: "IDENTITY_MISMATCH" };
  }

  return {
    kind: "assigned",
    tier,
    assignment: refreshTierAssignmentAfterEdit(assignment, revision.snapshot),
    source
  };
}

export function recoverPreviouslyAssignedTier(source: {
  blueprintId: string;
  slotLevelsByItemId?: Record<string, unknown> | null;
  assignmentUpdatedAt: unknown;
  trustStableItemMap?: boolean;
}): SlotLevel | null {
  const assignedAt = Number(source.assignmentUpdatedAt);
  const hasAssignmentMarker = Number.isFinite(assignedAt) && assignedAt > 0;
  if (!source.blueprintId || (!source.trustStableItemMap && !hasAssignmentMarker)) return null;
  return parseSlotLevel(source.slotLevelsByItemId?.[source.blueprintId]);
}

export function staleTierAssignmentUuids<
  TAssignment extends { readonly ownerActorUuid: string; readonly codexUuid: string }
>(
  assignmentsByBlueprintUuid: Readonly<Record<string, TAssignment>>,
  scope: {
    ownerActorUuid: string;
    codexUuid: string;
    validBlueprintUuids: readonly string[];
  }
): string[] {
  const valid = new Set(scope.validBlueprintUuids);
  return Object.entries(assignmentsByBlueprintUuid).flatMap(([blueprintUuid, assignment]) =>
    assignment.ownerActorUuid === scope.ownerActorUuid
      && assignment.codexUuid === scope.codexUuid
      && !valid.has(blueprintUuid)
      ? [blueprintUuid]
      : []
  );
}
