import assert from "node:assert/strict";
import test from "node:test";

import {
  activeReservationCount,
  addReservation,
  approveBlueprint,
  createWorldState,
  paidReservedSlotCounts,
  reconcileReservations,
  removeReservation,
  registerCanonicalCodex,
  type ActiveReservation,
  type TemporaryItemRelation,
  validateReservationRelation,
  WorldStateError
} from "../src/world-state.ts";

function singleReservationState() {
  let state = registerCanonicalCodex(createWorldState(), {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  });
  state = approveBlueprint(state, {
    blueprintUuid: "Actor.owner.Item.blueprint",
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    slotLevel: 2,
    approvedByUserId: "User.gm",
    approvedAt: 1_725_000_000_000,
    snapshot: { fingerprint: "sha256:approved" }
  });
  return addReservation(state, {
    id: "reservation-1",
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    blueprintUuid: "Actor.owner.Item.blueprint",
    temporaryItemUuid: "Actor.target.Item.temporary",
    targetActorUuid: "Actor.target",
    hostItemUuid: null,
    slotLevel: 2,
    payment: "slot",
    approvalFingerprint: "sha256:approved",
    createdAt: 1_725_000_001_000
  });
}

function relationFor(
  reservation: ActiveReservation
): TemporaryItemRelation {
  return {
    reservationId: reservation.id,
    temporaryItemUuid: reservation.temporaryItemUuid,
    ownerActorUuid: reservation.ownerActorUuid,
    codexUuid: reservation.codexUuid,
    blueprintUuid: reservation.blueprintUuid,
    targetActorUuid: reservation.targetActorUuid,
    hostItemUuid: reservation.hostItemUuid,
    slotLevel: reservation.slotLevel,
    payment: reservation.payment,
    approvalFingerprint: reservation.approvalFingerprint
  };
}

test("one canonical codex is registered for an owner without mutating prior state", () => {
  const empty = createWorldState();
  const registered = registerCanonicalCodex(empty, {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  });

  assert.deepEqual(empty.canonicalCodexByOwnerActorUuid, {});
  assert.deepEqual(registered.canonicalCodexByOwnerActorUuid, {
    "Actor.owner": "Actor.owner.Item.codex"
  });
  assert.notStrictEqual(registered, empty);
});

test("canonical codex registration rejects ambiguous ownership", () => {
  const registered = registerCanonicalCodex(createWorldState(), {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  });

  assert.throws(
    () => registerCanonicalCodex(registered, {
      ownerActorUuid: "Actor.owner",
      codexUuid: "Actor.owner.Item.other"
    }),
    (error) => error instanceof WorldStateError
      && error.code === "CANONICAL_CODEX_CONFLICT"
  );
  assert.throws(
    () => registerCanonicalCodex(registered, {
      ownerActorUuid: "Actor.other",
      codexUuid: "Actor.owner.Item.codex"
    }),
    (error) => error instanceof WorldStateError
      && error.code === "CODEX_ALREADY_ASSIGNED"
  );
});

test("canonical codex registration is idempotent and rejects blank identifiers", () => {
  const registered = registerCanonicalCodex(createWorldState(), {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  });

  assert.strictEqual(registerCanonicalCodex(registered, {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  }), registered);
  assert.throws(
    () => registerCanonicalCodex(createWorldState(), {
      ownerActorUuid: " ",
      codexUuid: "Actor.owner.Item.codex"
    }),
    (error) => error instanceof WorldStateError
      && error.code === "INVALID_IDENTIFIER"
  );
});

test("a tier assignment is indexed by blueprint UUID and snapshots its metadata", () => {
  const canonical = registerCanonicalCodex(createWorldState(), {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  });
  const snapshot = {
    fingerprint: "sha256:approved",
    source: { name: "Arc Projector", revision: 3 }
  };

  const approved = approveBlueprint(canonical, {
    blueprintUuid: "Actor.owner.Item.blueprint",
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    slotLevel: 2 as const,
    approvedByUserId: "User.gm",
    approvedAt: 1_725_000_000_000,
    snapshot
  });

  snapshot.source.name = "Changed after approval";
  assert.deepEqual(canonical.approvalsByBlueprintUuid, {});
  assert.deepEqual(
    approved.approvalsByBlueprintUuid["Actor.owner.Item.blueprint"],
    {
      blueprintUuid: "Actor.owner.Item.blueprint",
      ownerActorUuid: "Actor.owner",
      codexUuid: "Actor.owner.Item.codex",
      slotLevel: 2,
      approvedByUserId: "User.gm",
      approvedAt: 1_725_000_000_000,
      snapshot: {
        fingerprint: "sha256:approved",
        source: { name: "Arc Projector", revision: 3 }
      }
    }
  );
  assert.equal(Object.isFrozen(
    approved.approvalsByBlueprintUuid["Actor.owner.Item.blueprint"].snapshot.source
  ), true);
});

test("tier assignment requires the owner's canonical codex", () => {
  const canonical = registerCanonicalCodex(createWorldState(), {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  });

  assert.throws(
    () => approveBlueprint(canonical, {
      blueprintUuid: "Actor.owner.Item.blueprint",
      ownerActorUuid: "Actor.owner",
      codexUuid: "Actor.owner.Item.impostor",
      slotLevel: 2,
      approvedByUserId: "User.gm",
      approvedAt: 1_725_000_000_000,
      snapshot: { fingerprint: "sha256:approved" }
    }),
    (error) => error instanceof WorldStateError
      && error.code === "NONCANONICAL_CODEX"
  );
});

test("an active reservation is keyed by ID and bound to its tier assignment", () => {
  const canonical = registerCanonicalCodex(createWorldState(), {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  });
  const approved = approveBlueprint(canonical, {
    blueprintUuid: "Actor.owner.Item.blueprint",
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    slotLevel: 2,
    approvedByUserId: "User.gm",
    approvedAt: 1_725_000_000_000,
    snapshot: { fingerprint: "sha256:approved" }
  });

  const reserved = addReservation(approved, {
    id: "reservation-1",
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    blueprintUuid: "Actor.owner.Item.blueprint",
    temporaryItemUuid: "Actor.target.Item.temporary",
    targetActorUuid: "Actor.target",
    hostItemUuid: null,
    slotLevel: 2,
    payment: "slot",
    approvalFingerprint: "sha256:approved",
    createdAt: 1_725_000_001_000
  });

  assert.deepEqual(approved.reservationsById, {});
  assert.deepEqual(reserved.reservationsById["reservation-1"], {
    id: "reservation-1",
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    blueprintUuid: "Actor.owner.Item.blueprint",
    temporaryItemUuid: "Actor.target.Item.temporary",
    targetActorUuid: "Actor.target",
    hostItemUuid: null,
    slotLevel: 2,
    payment: "slot",
    approvalFingerprint: "sha256:approved",
    createdAt: 1_725_000_001_000
  });
  assert.equal(Object.hasOwn(
    reserved.reservationsById["reservation-1"],
    "state"
  ), false);
  assert.equal(Object.isFrozen(
    reserved.reservationsById["reservation-1"]
  ), true);
});

test("reservation creation rejects stale tier data and duplicate temporary items", () => {
  let state = registerCanonicalCodex(createWorldState(), {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  });
  state = approveBlueprint(state, {
    blueprintUuid: "Actor.owner.Item.blueprint",
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    slotLevel: 2,
    approvedByUserId: "User.gm",
    approvedAt: 1_725_000_000_000,
    snapshot: { fingerprint: "sha256:approved" }
  });
  const baseReservation = {
    id: "reservation-1",
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    blueprintUuid: "Actor.owner.Item.blueprint",
    temporaryItemUuid: "Actor.target.Item.temporary",
    targetActorUuid: "Actor.target",
    hostItemUuid: null,
    slotLevel: 2 as const,
    payment: "slot" as const,
    approvalFingerprint: "sha256:approved",
    createdAt: 1_725_000_001_000
  };

  assert.throws(
    () => addReservation(state, {
      ...baseReservation,
      approvalFingerprint: "sha256:stale"
    }),
    (error) => error instanceof WorldStateError
      && error.code === "APPROVAL_MISMATCH"
  );

  state = addReservation(state, baseReservation);
  assert.throws(
    () => addReservation(state, {
      ...baseReservation,
      id: "reservation-2"
    }),
    (error) => error instanceof WorldStateError
      && error.code === "TEMPORARY_ITEM_CONFLICT"
  );
});

test("active and paid reservation counts are owner-wide", () => {
  let state = createWorldState();
  state = registerCanonicalCodex(state, {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex"
  });
  state = registerCanonicalCodex(state, {
    ownerActorUuid: "Actor.other",
    codexUuid: "Actor.other.Item.codex"
  });

  const approvals = [
    ["Actor.owner.Item.blueprint-a", "Actor.owner", "Actor.owner.Item.codex", 2],
    ["Actor.owner.Item.blueprint-b", "Actor.owner", "Actor.owner.Item.codex", 2],
    ["Actor.owner.Item.blueprint-c", "Actor.owner", "Actor.owner.Item.codex", 3],
    ["Actor.other.Item.blueprint", "Actor.other", "Actor.other.Item.codex", 2]
  ] as const;
  for (const [blueprintUuid, ownerActorUuid, codexUuid, slotLevel] of approvals) {
    state = approveBlueprint(state, {
      blueprintUuid,
      ownerActorUuid,
      codexUuid,
      slotLevel,
      approvedByUserId: "User.gm",
      approvedAt: 1_725_000_000_000,
      snapshot: { fingerprint: `sha256:${blueprintUuid}` }
    });
  }

  const reservations = [
    ["r1", "Actor.owner", "Actor.owner.Item.codex", "Actor.owner.Item.blueprint-a", "Actor.target.Item.one", "Actor.target", 2, "slot"],
    ["r2", "Actor.owner", "Actor.owner.Item.codex", "Actor.owner.Item.blueprint-b", "Actor.target.Item.two", "Actor.target", 2, "slot"],
    ["r3", "Actor.owner", "Actor.owner.Item.codex", "Actor.owner.Item.blueprint-c", "Actor.target.Item.three", "Actor.target", 3, "free"],
    ["r4", "Actor.other", "Actor.other.Item.codex", "Actor.other.Item.blueprint", "Actor.target.Item.four", "Actor.target", 2, "slot"]
  ] as const;
  for (const [id, ownerActorUuid, codexUuid, blueprintUuid, temporaryItemUuid, targetActorUuid, slotLevel, payment] of reservations) {
    state = addReservation(state, {
      id,
      ownerActorUuid,
      codexUuid,
      blueprintUuid,
      temporaryItemUuid,
      targetActorUuid,
      hostItemUuid: null,
      slotLevel,
      payment,
      approvalFingerprint: `sha256:${blueprintUuid}`,
      createdAt: 1_725_000_001_000
    });
  }

  assert.equal(activeReservationCount(state, "Actor.owner"), 3);
  assert.equal(activeReservationCount(state, "Actor.other"), 1);
  assert.deepEqual(paidReservedSlotCounts(state, "Actor.owner"), {
    1: 0,
    2: 2,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
    8: 0,
    9: 0
  });
  assert.equal(Object.isFrozen(
    paidReservedSlotCounts(state, "Actor.owner")
  ), true);
});

test("temporary-item relations must match every trusted reservation field", () => {
  const state = singleReservationState();
  const relation = {
    reservationId: "reservation-1",
    temporaryItemUuid: "Actor.target.Item.temporary",
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    blueprintUuid: "Actor.owner.Item.blueprint",
    targetActorUuid: "Actor.target",
    hostItemUuid: null,
    slotLevel: 2 as const,
    payment: "slot" as const,
    approvalFingerprint: "sha256:approved"
  };

  assert.deepEqual(validateReservationRelation(state, relation), {
    valid: true,
    reservation: state.reservationsById["reservation-1"],
    issues: []
  });
  assert.deepEqual(validateReservationRelation(state, {
    ...relation,
    ownerActorUuid: "Actor.attacker",
    blueprintUuid: "Actor.owner.Item.substituted",
    slotLevel: 3,
    approvalFingerprint: "sha256:forged"
  }), {
    valid: false,
    reservation: state.reservationsById["reservation-1"],
    issues: [
      "OWNER_ACTOR_MISMATCH",
      "BLUEPRINT_MISMATCH",
      "SLOT_LEVEL_MISMATCH",
      "APPROVAL_FINGERPRINT_MISMATCH"
    ]
  });
  assert.deepEqual(validateReservationRelation(state, {
    ...relation,
    reservationId: "missing"
  }), {
    valid: false,
    reservation: null,
    issues: ["UNKNOWN_RESERVATION"]
  });
});

test("reservation removal returns the removed record and preserves prior state", () => {
  const active = singleReservationState();
  const removed = removeReservation(active, "reservation-1");

  assert.strictEqual(
    removed.removed,
    active.reservationsById["reservation-1"]
  );
  assert.deepEqual(removed.state.reservationsById, {});
  assert.equal(activeReservationCount(active, "Actor.owner"), 1);
  assert.notStrictEqual(removed.state, active);

  const alreadyAbsent = removeReservation(removed.state, "reservation-1");
  assert.strictEqual(alreadyAbsent.state, removed.state);
  assert.equal(alreadyAbsent.removed, null);
});

test("reconciliation removes missing items but retains ambiguous live relations", () => {
  let state = singleReservationState();
  for (const [id, temporaryItemUuid] of [
    ["reservation-2", "Actor.target.Item.missing"],
    ["reservation-3", "Actor.target.Item.mismatched"],
    ["reservation-4", "Actor.target.Item.duplicated"]
  ] as const) {
    state = addReservation(state, {
      ...state.reservationsById["reservation-1"],
      id,
      temporaryItemUuid,
      createdAt: state.reservationsById["reservation-1"].createdAt + 1
    });
  }

  const valid = relationFor(state.reservationsById["reservation-1"]);
  const mismatched = {
    ...relationFor(state.reservationsById["reservation-3"]),
    targetActorUuid: "Actor.wrong-target"
  };
  const duplicate = relationFor(state.reservationsById["reservation-4"]);
  const orphan = {
    ...valid,
    reservationId: "orphan-reservation",
    temporaryItemUuid: "Actor.target.Item.orphan"
  };

  const result = reconcileReservations(state, [
    valid,
    mismatched,
    duplicate,
    { ...duplicate },
    orphan
  ]);

  assert.deepEqual(Object.keys(result.state.reservationsById), [
    "reservation-1",
    "reservation-3",
    "reservation-4"
  ]);
  assert.deepEqual(result.removed, [{
    reservation: state.reservationsById["reservation-2"],
    reason: "MISSING_TEMPORARY_ITEM"
  }]);
  assert.deepEqual(result.conflicts, [
    {
      reservation: state.reservationsById["reservation-3"],
      observations: [mismatched],
      issues: ["TARGET_ACTOR_MISMATCH"]
    },
    {
      reservation: state.reservationsById["reservation-4"],
      observations: [duplicate, { ...duplicate }],
      issues: ["DUPLICATE_OBSERVATION"]
    }
  ]);
  assert.deepEqual(result.orphans, [orphan]);
  assert.equal(state.reservationsById["reservation-2"].id, "reservation-2");
});
