import type { SlotLevel } from "./slot-levels.ts";

export interface CanonicalCodexRegistration {
  readonly ownerActorUuid: string;
  readonly codexUuid: string;
}

export type SnapshotValue =
  | string
  | number
  | boolean
  | null
  | readonly SnapshotValue[]
  | { readonly [key: string]: SnapshotValue };

export interface BlueprintSnapshotMetadata {
  readonly fingerprint: string;
  readonly [key: string]: SnapshotValue;
}

export interface BlueprintApproval {
  readonly blueprintUuid: string;
  readonly ownerActorUuid: string;
  readonly codexUuid: string;
  readonly slotLevel: SlotLevel;
  readonly approvedByUserId: string;
  readonly approvedAt: number;
  readonly snapshot: BlueprintSnapshotMetadata;
}

export type ReservationPayment = "slot" | "free" | "legacy";

/** Active set membership is the complete lifecycle; there is no recalling state. */
export interface ActiveReservation {
  readonly id: string;
  readonly ownerActorUuid: string;
  readonly codexUuid: string;
  readonly blueprintUuid: string;
  readonly temporaryItemUuid: string;
  readonly targetActorUuid: string;
  readonly hostItemUuid: string | null;
  readonly slotLevel: SlotLevel;
  readonly payment: ReservationPayment;
  readonly approvalFingerprint: string;
  readonly createdAt: number;
}

export type PaidReservedSlotCounts = Readonly<Record<SlotLevel, number>>;

export interface TemporaryItemRelation {
  readonly reservationId: string;
  readonly temporaryItemUuid: string;
  readonly ownerActorUuid: string;
  readonly codexUuid: string;
  readonly blueprintUuid: string;
  readonly targetActorUuid: string;
  readonly hostItemUuid: string | null;
  readonly slotLevel: SlotLevel;
  readonly payment: ReservationPayment;
  readonly approvalFingerprint: string;
}

export type ReservationRelationIssue =
  | "UNKNOWN_RESERVATION"
  | "DUPLICATE_OBSERVATION"
  | "NONCANONICAL_CODEX"
  | "TEMPORARY_ITEM_MISMATCH"
  | "OWNER_ACTOR_MISMATCH"
  | "CODEX_MISMATCH"
  | "BLUEPRINT_MISMATCH"
  | "TARGET_ACTOR_MISMATCH"
  | "HOST_ITEM_MISMATCH"
  | "SLOT_LEVEL_MISMATCH"
  | "PAYMENT_MISMATCH"
  | "APPROVAL_FINGERPRINT_MISMATCH";

export interface ReservationRelationValidation {
  readonly valid: boolean;
  readonly reservation: ActiveReservation | null;
  readonly issues: readonly ReservationRelationIssue[];
}

export interface ReservationRemoval {
  readonly state: WorldState;
  readonly removed: ActiveReservation | null;
}

export interface ReconciledReservationRemoval {
  readonly reservation: ActiveReservation;
  readonly reason: "MISSING_TEMPORARY_ITEM";
}

export interface ReservationReconciliationConflict {
  readonly reservation: ActiveReservation;
  readonly observations: readonly TemporaryItemRelation[];
  readonly issues: readonly ReservationRelationIssue[];
}

export interface ReservationReconciliation {
  readonly state: WorldState;
  readonly removed: readonly ReconciledReservationRemoval[];
  readonly conflicts: readonly ReservationReconciliationConflict[];
  readonly orphans: readonly TemporaryItemRelation[];
}

export interface WorldState {
  readonly canonicalCodexByOwnerActorUuid: Readonly<Record<string, string>>;
  readonly approvalsByBlueprintUuid: Readonly<Record<string, BlueprintApproval>>;
  readonly reservationsById: Readonly<Record<string, ActiveReservation>>;
}

export type WorldStateErrorCode =
  | "INVALID_IDENTIFIER"
  | "INVALID_SLOT_LEVEL"
  | "INVALID_TIMESTAMP"
  | "INVALID_SNAPSHOT"
  | "CANONICAL_CODEX_CONFLICT"
  | "CODEX_ALREADY_ASSIGNED"
  | "NONCANONICAL_CODEX"
  | "INVALID_PAYMENT"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_MISMATCH"
  | "RESERVATION_ID_CONFLICT"
  | "TEMPORARY_ITEM_CONFLICT";

export class WorldStateError extends Error {
  readonly code: WorldStateErrorCode;

  constructor(
    code: WorldStateErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorldStateError";
    this.code = code;
  }
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorldStateError(
      "INVALID_IDENTIFIER",
      `${field} must be a non-empty string.`
    );
  }
}

function assertSlotLevel(value: number): asserts value is SlotLevel {
  if (!Number.isInteger(value) || value < 1 || value > 9) {
    throw new WorldStateError(
      "INVALID_SLOT_LEVEL",
      "slotLevel must be an integer from 1 through 9."
    );
  }
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new WorldStateError(
      "INVALID_TIMESTAMP",
      `${field} must be a non-negative finite number.`
    );
  }
}

function assertPayment(value: ReservationPayment): void {
  if (value !== "slot" && value !== "free" && value !== "legacy") {
    throw new WorldStateError(
      "INVALID_PAYMENT",
      "payment must be slot, free, or legacy."
    );
  }
}

function assertCanonicalCodex(
  state: WorldState,
  ownerActorUuid: string,
  codexUuid: string
): void {
  if (state.canonicalCodexByOwnerActorUuid[ownerActorUuid] !== codexUuid) {
    throw new WorldStateError(
      "NONCANONICAL_CODEX",
      `${codexUuid} is not the canonical codex for ${ownerActorUuid}.`
    );
  }
}

function cloneSnapshotValue(value: SnapshotValue): SnapshotValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneSnapshotValue(entry)));
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, SnapshotValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = cloneSnapshotValue(entry);
    }
    return Object.freeze(copy);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new WorldStateError(
      "INVALID_SNAPSHOT",
      "Snapshot metadata numbers must be finite."
    );
  }
  return value;
}

function cloneSnapshot(
  snapshot: BlueprintSnapshotMetadata
): BlueprintSnapshotMetadata {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new WorldStateError(
      "INVALID_SNAPSHOT",
      "snapshot must be an object."
    );
  }
  assertIdentifier(snapshot.fingerprint, "snapshot.fingerprint");
  return cloneSnapshotValue(snapshot) as BlueprintSnapshotMetadata;
}

export function createWorldState(): WorldState {
  return Object.freeze({
    canonicalCodexByOwnerActorUuid: Object.freeze({}),
    approvalsByBlueprintUuid: Object.freeze({}),
    reservationsById: Object.freeze({})
  });
}

export function registerCanonicalCodex(
  state: WorldState,
  registration: CanonicalCodexRegistration
): WorldState {
  assertIdentifier(registration.ownerActorUuid, "ownerActorUuid");
  assertIdentifier(registration.codexUuid, "codexUuid");

  const currentCodexUuid =
    state.canonicalCodexByOwnerActorUuid[registration.ownerActorUuid];
  if (currentCodexUuid === registration.codexUuid) return state;
  if (currentCodexUuid) {
    throw new WorldStateError(
      "CANONICAL_CODEX_CONFLICT",
      `${registration.ownerActorUuid} already has a canonical codex.`
    );
  }

  const assignedOwner = Object.entries(
    state.canonicalCodexByOwnerActorUuid
  ).find(([, codexUuid]) => codexUuid === registration.codexUuid)?.[0];
  if (assignedOwner) {
    throw new WorldStateError(
      "CODEX_ALREADY_ASSIGNED",
      `${registration.codexUuid} is already assigned to ${assignedOwner}.`
    );
  }

  return Object.freeze({
    ...state,
    canonicalCodexByOwnerActorUuid: Object.freeze({
      ...state.canonicalCodexByOwnerActorUuid,
      [registration.ownerActorUuid]: registration.codexUuid
    })
  });
}

export function approveBlueprint(
  state: WorldState,
  approval: BlueprintApproval
): WorldState {
  assertIdentifier(approval.blueprintUuid, "blueprintUuid");
  assertIdentifier(approval.ownerActorUuid, "ownerActorUuid");
  assertIdentifier(approval.codexUuid, "codexUuid");
  assertIdentifier(approval.approvedByUserId, "approvedByUserId");
  assertSlotLevel(approval.slotLevel);
  assertTimestamp(approval.approvedAt, "approvedAt");
  assertCanonicalCodex(state, approval.ownerActorUuid, approval.codexUuid);

  const storedApproval = Object.freeze({
    ...approval,
    snapshot: cloneSnapshot(approval.snapshot)
  });

  return Object.freeze({
    ...state,
    approvalsByBlueprintUuid: Object.freeze({
      ...state.approvalsByBlueprintUuid,
      [approval.blueprintUuid]: storedApproval
    })
  });
}

export function addReservation(
  state: WorldState,
  reservation: ActiveReservation
): WorldState {
  assertIdentifier(reservation.id, "id");
  assertIdentifier(reservation.ownerActorUuid, "ownerActorUuid");
  assertIdentifier(reservation.codexUuid, "codexUuid");
  assertIdentifier(reservation.blueprintUuid, "blueprintUuid");
  assertIdentifier(reservation.temporaryItemUuid, "temporaryItemUuid");
  assertIdentifier(reservation.targetActorUuid, "targetActorUuid");
  if (reservation.hostItemUuid !== null) {
    assertIdentifier(reservation.hostItemUuid, "hostItemUuid");
  }
  assertSlotLevel(reservation.slotLevel);
  assertPayment(reservation.payment);
  assertIdentifier(reservation.approvalFingerprint, "approvalFingerprint");
  assertTimestamp(reservation.createdAt, "createdAt");
  assertCanonicalCodex(
    state,
    reservation.ownerActorUuid,
    reservation.codexUuid
  );

  const approval = state.approvalsByBlueprintUuid[reservation.blueprintUuid];
  if (!approval) {
    throw new WorldStateError(
      "APPROVAL_NOT_FOUND",
      `${reservation.blueprintUuid} has no pattern tier assignment.`
    );
  }
  if (approval.ownerActorUuid !== reservation.ownerActorUuid
    || approval.codexUuid !== reservation.codexUuid
    || approval.slotLevel !== reservation.slotLevel
    || approval.snapshot.fingerprint !== reservation.approvalFingerprint) {
    throw new WorldStateError(
      "APPROVAL_MISMATCH",
      "The reservation does not match the blueprint's current tier assignment."
    );
  }

  if (state.reservationsById[reservation.id]) {
    throw new WorldStateError(
      "RESERVATION_ID_CONFLICT",
      `${reservation.id} is already active.`
    );
  }
  if (Object.values(state.reservationsById).some((candidate) =>
    candidate.temporaryItemUuid === reservation.temporaryItemUuid
  )) {
    throw new WorldStateError(
      "TEMPORARY_ITEM_CONFLICT",
      `${reservation.temporaryItemUuid} already has an active reservation.`
    );
  }

  const storedReservation = Object.freeze({ ...reservation });
  return Object.freeze({
    ...state,
    reservationsById: Object.freeze({
      ...state.reservationsById,
      [reservation.id]: storedReservation
    })
  });
}

export function activeReservationCount(
  state: WorldState,
  ownerActorUuid: string
): number {
  return Object.values(state.reservationsById).filter(
    (reservation) => reservation.ownerActorUuid === ownerActorUuid
  ).length;
}

export function paidReservedSlotCounts(
  state: WorldState,
  ownerActorUuid: string
): PaidReservedSlotCounts {
  const counts: Record<SlotLevel, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
    8: 0,
    9: 0
  };

  for (const reservation of Object.values(state.reservationsById)) {
    if (reservation.ownerActorUuid === ownerActorUuid
      && reservation.payment === "slot") {
      counts[reservation.slotLevel] += 1;
    }
  }
  return Object.freeze(counts);
}

export function validateReservationRelation(
  state: WorldState,
  relation: TemporaryItemRelation
): ReservationRelationValidation {
  const reservation = state.reservationsById[relation.reservationId];
  if (!reservation) {
    return Object.freeze({
      valid: false,
      reservation: null,
      issues: Object.freeze(["UNKNOWN_RESERVATION"] as const)
    });
  }

  const issues: ReservationRelationIssue[] = [];
  if (state.canonicalCodexByOwnerActorUuid[reservation.ownerActorUuid]
    !== reservation.codexUuid) {
    issues.push("NONCANONICAL_CODEX");
  }
  if (relation.temporaryItemUuid !== reservation.temporaryItemUuid) {
    issues.push("TEMPORARY_ITEM_MISMATCH");
  }
  if (relation.ownerActorUuid !== reservation.ownerActorUuid) {
    issues.push("OWNER_ACTOR_MISMATCH");
  }
  if (relation.codexUuid !== reservation.codexUuid) {
    issues.push("CODEX_MISMATCH");
  }
  if (relation.blueprintUuid !== reservation.blueprintUuid) {
    issues.push("BLUEPRINT_MISMATCH");
  }
  if (relation.targetActorUuid !== reservation.targetActorUuid) {
    issues.push("TARGET_ACTOR_MISMATCH");
  }
  if (relation.hostItemUuid !== reservation.hostItemUuid) {
    issues.push("HOST_ITEM_MISMATCH");
  }
  if (relation.slotLevel !== reservation.slotLevel) {
    issues.push("SLOT_LEVEL_MISMATCH");
  }
  if (relation.payment !== reservation.payment) {
    issues.push("PAYMENT_MISMATCH");
  }
  if (relation.approvalFingerprint !== reservation.approvalFingerprint) {
    issues.push("APPROVAL_FINGERPRINT_MISMATCH");
  }

  return Object.freeze({
    valid: issues.length === 0,
    reservation,
    issues: Object.freeze(issues)
  });
}

export function removeReservation(
  state: WorldState,
  reservationId: string
): ReservationRemoval {
  const removed = state.reservationsById[reservationId];
  if (!removed) {
    return Object.freeze({ state, removed: null });
  }

  const remaining = { ...state.reservationsById };
  delete remaining[reservationId];
  const nextState = Object.freeze({
    ...state,
    reservationsById: Object.freeze(remaining)
  });
  return Object.freeze({ state: nextState, removed });
}

function cloneRelation(
  relation: TemporaryItemRelation
): TemporaryItemRelation {
  return Object.freeze({ ...relation });
}

export function reconcileReservations(
  state: WorldState,
  observations: readonly TemporaryItemRelation[]
): ReservationReconciliation {
  const observationsByReservationId = new Map<
    string,
    TemporaryItemRelation[]
  >();
  const orphans: TemporaryItemRelation[] = [];

  for (const observation of observations) {
    const storedObservation = cloneRelation(observation);
    if (!state.reservationsById[observation.reservationId]) {
      orphans.push(storedObservation);
      continue;
    }
    const matches = observationsByReservationId.get(
      observation.reservationId
    ) ?? [];
    matches.push(storedObservation);
    observationsByReservationId.set(observation.reservationId, matches);
  }

  let reconciledState = state;
  const removed: ReconciledReservationRemoval[] = [];
  const conflicts: ReservationReconciliationConflict[] = [];

  for (const reservation of Object.values(state.reservationsById)) {
    const matchingObservations = observationsByReservationId.get(
      reservation.id
    ) ?? [];
    if (matchingObservations.length === 0) {
      const removal = removeReservation(reconciledState, reservation.id);
      reconciledState = removal.state;
      removed.push(Object.freeze({
        reservation,
        reason: "MISSING_TEMPORARY_ITEM"
      }));
      continue;
    }

    if (matchingObservations.length > 1) {
      conflicts.push(Object.freeze({
        reservation,
        observations: Object.freeze(matchingObservations),
        issues: Object.freeze(["DUPLICATE_OBSERVATION"] as const)
      }));
      continue;
    }

    const validation = validateReservationRelation(
      state,
      matchingObservations[0]
    );
    if (!validation.valid) {
      conflicts.push(Object.freeze({
        reservation,
        observations: Object.freeze(matchingObservations),
        issues: validation.issues
      }));
    }
  }

  return Object.freeze({
    state: reconciledState,
    removed: Object.freeze(removed),
    conflicts: Object.freeze(conflicts),
    orphans: Object.freeze(orphans)
  });
}
