import assert from "node:assert/strict";
import test from "node:test";

import {
  canManageActorPatterns,
  planBlueprintRevision,
  recoverPreviouslyAssignedTier,
  staleTierAssignmentUuids,
} from "../src/blueprint-tiers.ts";

test("an actor owner can manage pattern tiers without being a GM", () => {
  assert.equal(canManageActorPatterns({ isGM: false, isOwner: true }), true);
  assert.equal(canManageActorPatterns({ isGM: false, isOwner: false }), false);
  assert.equal(canManageActorPatterns({ isGM: true, isOwner: false }), true);
});

test("editing a tiered blueprint keeps its tier and refreshes the fabrication snapshot", () => {
  const assignment = {
    blueprintUuid: "Actor.owner.Item.blueprint",
    codexUuid: "Actor.owner.Item.codex",
    ownerActorUuid: "Actor.owner",
    slotLevel: 3 as const,
    assignedBy: "User.gm",
    assignedAt: 1_725_000_000_000,
    snapshot: { name: "Old name", system: { identifier: "old-name" } }
  };
  const currentSnapshot = {
    name: "Renamed pattern",
    system: { identifier: "renamed-pattern" }
  };

  const plan = planBlueprintRevision(assignment, {
    blueprintUuid: assignment.blueprintUuid,
    codexUuid: assignment.codexUuid,
    ownerActorUuid: assignment.ownerActorUuid,
    snapshot: currentSnapshot
  });

  assert.equal(plan.kind, "assigned");
  if (plan.kind !== "assigned") return;
  assert.equal(plan.tier, 3);
  assert.deepEqual(plan.assignment, { ...assignment, snapshot: currentSnapshot });
  assert.deepEqual(plan.source, currentSnapshot);
  assert.notStrictEqual(plan.assignment, assignment);
  assert.notStrictEqual(plan.assignment.snapshot, currentSnapshot);
  assert.notStrictEqual(plan.source, currentSnapshot);
  assert.notStrictEqual(plan.source, plan.assignment.snapshot);
});

test("an uncategorized pattern stays unassigned and returns an isolated live source", () => {
  const currentSnapshot = { name: "New pattern", effects: [{ name: "Glow" }] };
  const plan = planBlueprintRevision(null, {
    blueprintUuid: "Actor.owner.Item.blueprint",
    codexUuid: "Actor.owner.Item.codex",
    ownerActorUuid: "Actor.owner",
    snapshot: currentSnapshot
  });

  assert.equal(plan.kind, "unassigned");
  if (plan.kind !== "unassigned") return;
  assert.equal(plan.tier, null);
  assert.deepEqual(plan.source, currentSnapshot);
  assert.notStrictEqual(plan.source, currentSnapshot);
});

test("tier assignments never transfer across a blueprint, codex, or owner", () => {
  const assignment = {
    blueprintUuid: "Actor.owner.Item.blueprint",
    codexUuid: "Actor.owner.Item.codex",
    ownerActorUuid: "Actor.owner",
    slotLevel: 2,
    snapshot: { name: "Pattern" }
  };

  for (const identity of [
    { blueprintUuid: "Actor.owner.Item.other", codexUuid: assignment.codexUuid, ownerActorUuid: assignment.ownerActorUuid },
    { blueprintUuid: assignment.blueprintUuid, codexUuid: "Actor.owner.Item.otherCodex", ownerActorUuid: assignment.ownerActorUuid },
    { blueprintUuid: assignment.blueprintUuid, codexUuid: assignment.codexUuid, ownerActorUuid: "Actor.other" }
  ]) {
    assert.deepEqual(planBlueprintRevision(assignment, {
      ...identity,
      snapshot: { name: "Changed" }
    }), { kind: "conflict", reason: "IDENTITY_MISMATCH" });
  }
});

test("a malformed stored tier is a conflict instead of an inferred assignment", () => {
  const plan = planBlueprintRevision({
    blueprintUuid: "Actor.owner.Item.blueprint",
    codexUuid: "Actor.owner.Item.codex",
    ownerActorUuid: "Actor.owner",
    slotLevel: "bogus",
    snapshot: { name: "Pattern" }
  }, {
    blueprintUuid: "Actor.owner.Item.blueprint",
    codexUuid: "Actor.owner.Item.codex",
    ownerActorUuid: "Actor.owner",
    snapshot: { name: "Pattern" }
  });

  assert.deepEqual(plan, { kind: "conflict", reason: "INVALID_TIER" });
});

test("migration recovers a previously assigned tier only from its stable item ID", () => {
  assert.equal(recoverPreviouslyAssignedTier({
    blueprintId: "blueprint",
    slotLevelsByItemId: { blueprint: 4 },
    assignmentUpdatedAt: 1_725_000_000_000
  }), 4);

  assert.equal(recoverPreviouslyAssignedTier({
    blueprintId: "renamed-blueprint",
    slotLevelsByItemId: { blueprint: 4 },
    assignmentUpdatedAt: 1_725_000_000_000
  }), null);
  assert.equal(recoverPreviouslyAssignedTier({
    blueprintId: "blueprint",
    slotLevelsByItemId: { blueprint: 4 },
    assignmentUpdatedAt: null
  }), null);
  assert.equal(recoverPreviouslyAssignedTier({
    blueprintId: "blueprint",
    slotLevelsByItemId: { blueprint: 4 },
    assignmentUpdatedAt: 0
  }), null);
});

test("schema 3 and 4 recovery can trust a stable item-ID tier without a timestamp", () => {
  assert.equal(recoverPreviouslyAssignedTier({
    blueprintId: "blueprint",
    slotLevelsByItemId: { blueprint: 4 },
    assignmentUpdatedAt: null,
    trustStableItemMap: true
  }), 4);
  assert.equal(recoverPreviouslyAssignedTier({
    blueprintId: "blueprint",
    slotLevelsByItemId: {},
    assignmentUpdatedAt: null,
    trustStableItemMap: true
  }), null);
});

test("startup sweep finds tier assignments whose patterns left the canonical Codex", () => {
  const stale = staleTierAssignmentUuids({
    "Actor.owner.Item.kept": {
      ownerActorUuid: "Actor.owner",
      codexUuid: "Actor.owner.Item.codex"
    },
    "Actor.owner.Item.moved": {
      ownerActorUuid: "Actor.owner",
      codexUuid: "Actor.owner.Item.codex"
    },
    "Actor.other.Item.pattern": {
      ownerActorUuid: "Actor.other",
      codexUuid: "Actor.other.Item.codex"
    }
  }, {
    ownerActorUuid: "Actor.owner",
    codexUuid: "Actor.owner.Item.codex",
    validBlueprintUuids: ["Actor.owner.Item.kept"]
  });

  assert.deepEqual(stale, ["Actor.owner.Item.moved"]);
});
