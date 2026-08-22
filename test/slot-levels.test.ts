import assert from "node:assert/strict";
import test from "node:test";

import { resolveSlotLevel, updateSlotLevelMaps } from "../src/slot-levels.ts";

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
