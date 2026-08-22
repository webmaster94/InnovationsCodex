import assert from "node:assert/strict";
import test from "node:test";

import { requiresAttunement, restoredSlotValue, validateFabrication } from "../src/imbuements.ts";

test("normalizes current and legacy dnd5e attunement states", () => {
  assert.equal(requiresAttunement("required"), true);
  assert.equal(requiresAttunement("attuned"), true);
  assert.equal(requiresAttunement(""), false);
  assert.equal(requiresAttunement(1), true);
  assert.equal(requiresAttunement(2), true);
  assert.equal(requiresAttunement(0), false);
  assert.equal(requiresAttunement(null), false);
});

test("enforces the proficiency-bonus active imbuement cap", () => {
  assert.deepEqual(validateFabrication({
    activeCount: 3,
    proficiencyBonus: 3,
    payment: "slot",
    slotLevel: 2,
    availableSlots: 1,
    freeUsesSpent: 0
  }), {
    ok: false,
    payment: null,
    slotLevel: null,
    reason: "The owner already has 3 active imbuements."
  });
});

test("requires an assigned pattern tier for a free imbuement", () => {
  assert.equal(validateFabrication({
    activeCount: 0,
    proficiencyBonus: 3,
    payment: "free",
    slotLevel: null,
    availableSlots: 0,
    freeUsesSpent: 0
  }).ok, false);

  const decision = validateFabrication({
    activeCount: 0,
    proficiencyBonus: 3,
    payment: "free",
    slotLevel: 2,
    availableSlots: 0,
    freeUsesSpent: 0
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.slotLevel, 2);
});

test("rejects a second free imbuement before a long rest", () => {
  assert.equal(validateFabrication({
    activeCount: 0,
    proficiencyBonus: 3,
    payment: "free",
    slotLevel: 1,
    availableSlots: 0,
    freeUsesSpent: 1
  }).ok, false);
});

test("restores a parked slot without exceeding its maximum", () => {
  assert.equal(restoredSlotValue(1, 3), 2);
  assert.equal(restoredSlotValue(3, 3), 3);
  assert.equal(restoredSlotValue(4, 3), 4);
  assert.equal(restoredSlotValue(0, 3, 2), 1);
  assert.equal(restoredSlotValue(2, 3, 2), 2);
});
