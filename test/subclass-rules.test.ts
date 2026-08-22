import assert from "node:assert/strict";
import test from "node:test";

import { maximumPatternTier, patternCapacity } from "../src/subclass-rules.ts";

test("computes College of Innovation pattern capacity from Bard level", () => {
  assert.equal(patternCapacity(2), 0);
  assert.equal(patternCapacity(3), 4);
  assert.equal(patternCapacity(8), 14);
  assert.equal(patternCapacity(20), 38);
});

test("uses the highest available spell-slot tier as the pattern tier", () => {
  assert.equal(maximumPatternTier({ spell1: { max: 4 }, spell2: { max: 3 }, spell4: { max: 0 } }), 2);
  assert.equal(maximumPatternTier({ spell1: { max: 4 }, spell4: { max: 2 }, pact: { max: 2 } }), 4);
  assert.equal(maximumPatternTier({}), 0);
});
