import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveLegacyTemporaryLink,
  resolveSlotLevel,
  updateSlotLevelMaps
} from "../src/slot-levels.ts";

test("recovers a missing legacy temporary tier from one trusted blueprint", () => {
  assert.deepEqual(resolveLegacyTemporaryLink({
    name: "Temporary Goggles of Night",
    blueprintUuid: null,
    slotLevel: null
  }, [
    {
      uuid: "Actor.owner.Item.canonicalGoggles",
      name: "Goggles of Night",
      slotLevel: 1
    },
    {
      uuid: "Actor.owner.Item.unapprovedDuplicate",
      name: "Goggles of Night",
      slotLevel: null
    }
  ]), {
    blueprintUuid: "Actor.owner.Item.canonicalGoggles",
    slotLevel: 1
  });
});

test("does not replace a malformed legacy temporary tier with an inferred one", () => {
  assert.equal(resolveLegacyTemporaryLink({
    name: "Temporary Goggles of Night",
    blueprintUuid: null,
    slotLevel: "not-a-tier"
  }, [{
    uuid: "Actor.owner.Item.canonicalGoggles",
    name: "Goggles of Night",
    slotLevel: 1
  }]), null);
});

test("requires the legacy Temporary prefix before inferring by name", () => {
  assert.equal(resolveLegacyTemporaryLink({
    name: "Goggles of Night",
    blueprintUuid: null,
    slotLevel: null
  }, [{
    uuid: "Actor.owner.Item.canonicalGoggles",
    name: "Goggles of Night",
    slotLevel: 1
  }]), null);
});

test("does not infer a same-name blueprint with conflicting item identity", () => {
  assert.equal(resolveLegacyTemporaryLink({
    name: "Temporary Goggles of Night",
    type: "weapon",
    identifier: "other-item",
    blueprintUuid: null,
    slotLevel: null
  }, [{
    uuid: "Actor.owner.Item.canonicalGoggles",
    name: "Goggles of Night",
    type: "equipment",
    identifier: "goggles-of-night",
    slotLevel: 1
  }]), null);
});

test("reads a legacy Foundry flag whose dotted UUID was expanded into nested keys", () => {
  const slotLevelsByUuid = {
    Actor: {
      o0a28BH5wBO54Jud: {
        Item: {
          rVpajqt5BXsvn6Sv: 2
        }
      }
    }
  };

  assert.equal(resolveSlotLevel({
    blueprintId: "rVpajqt5BXsvn6Sv",
    blueprintUuid: "Actor.o0a28BH5wBO54Jud.Item.rVpajqt5BXsvn6Sv",
    blueprintName: "Renamed Blueprint",
    slotLevelsByUuid,
    slotLevelsByName: {}
  }), 2);
});

test("uses the stable item ID before mutable legacy names", () => {
  assert.equal(resolveSlotLevel({
    blueprintId: "sameNameA",
    blueprintUuid: "Actor.actorId.Item.sameNameA",
    blueprintName: "Goggles of Night",
    slotLevelsByItemId: { sameNameA: 4 },
    slotLevelsByName: { "Goggles of Night": 1 }
  }), 4);
});

test("uses an item flag before legacy codex maps", () => {
  assert.equal(resolveSlotLevel({
    blueprintId: "blueprint",
    blueprintName: "Old Name",
    itemLevel: 3,
    slotLevelsByName: { "Old Name": 1 }
  }), 3);
});

test("can disable mutable-name fallback during trusted legacy import", () => {
  assert.equal(resolveSlotLevel({
    blueprintId: "duplicate-name",
    blueprintName: "Goggles of Night",
    slotLevelsByName: { "Goggles of Night": 1 },
    allowNameFallback: false
  }), null);
});

test("treats an explicit null item flag as an uncategorized blueprint", () => {
  assert.equal(resolveSlotLevel({
    blueprintId: "new-blueprint",
    blueprintUuid: "Actor.actorId.Item.new-blueprint",
    blueprintName: "Old Approved Name",
    itemLevel: null,
    slotLevelsByUuid: {
      Actor: { actorId: { Item: { "new-blueprint": 2 } } }
    },
    slotLevelsByName: { "Old Approved Name": 4 }
  }), null);
});

test("writes dot-free item IDs and supports uncategorizing", () => {
  const assigned = updateSlotLevelMaps({
    blueprintId: "itemA",
    blueprintName: "Blueprint",
    slotLevelsByItemId: { itemB: 2 },
    slotLevelsByName: {}
  }, 4);

  assert.deepEqual(assigned, {
    slotLevelsByItemId: { itemB: 2, itemA: 4 },
    slotLevelsByName: { Blueprint: 4 }
  });

  assert.deepEqual(updateSlotLevelMaps({
    blueprintId: "itemA",
    blueprintName: "Blueprint",
    ...assigned
  }, null), {
    slotLevelsByItemId: { itemB: 2 },
    slotLevelsByName: {}
  });
});
