import { parseSlotLevel, type SlotLevel } from "./slot-levels.ts";

export type ImbuementPayment = "slot" | "free" | "legacy";

export interface FabricationState {
  activeCount: number;
  proficiencyBonus: unknown;
  payment: unknown;
  slotLevel: unknown;
  availableSlots: unknown;
  freeUsesSpent: unknown;
}

export interface FabricationDecision {
  ok: boolean;
  payment: ImbuementPayment | null;
  slotLevel: SlotLevel | null;
  reason: string | null;
}

function integerAtLeast(value: unknown, minimum: number): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : null;
}

export function requiresAttunement(value: unknown): boolean {
  if (typeof value === "string") return value === "required" || value === "attuned";
  const legacyValue = Number(value);
  return Number.isFinite(legacyValue) && legacyValue > 0;
}

export function validateFabrication(state: FabricationState): FabricationDecision {
  const proficiencyBonus = integerAtLeast(state.proficiencyBonus, 1);
  if (proficiencyBonus === null) {
    return { ok: false, payment: null, slotLevel: null, reason: "The owner's proficiency bonus is unavailable." };
  }
  if (state.activeCount >= proficiencyBonus) {
    return {
      ok: false,
      payment: null,
      slotLevel: null,
      reason: `The owner already has ${proficiencyBonus} active imbuements.`
    };
  }

  const slotLevel = parseSlotLevel(state.slotLevel);
  if (slotLevel === null) {
    return { ok: false, payment: null, slotLevel: null, reason: "The blueprint has no valid spell level." };
  }

  if (state.payment === "free") {
    const spent = integerAtLeast(state.freeUsesSpent, 0);
    if (spent === null || spent >= 1) {
      return { ok: false, payment: null, slotLevel: null, reason: "The free imbuement is already spent." };
    }
    return { ok: true, payment: "free", slotLevel, reason: null };
  }

  if (state.payment !== "slot") {
    return { ok: false, payment: null, slotLevel: null, reason: "Choose a valid imbuement payment." };
  }

  const availableSlots = integerAtLeast(state.availableSlots, 0);
  if (availableSlots === null || availableSlots < 1) {
    return { ok: false, payment: null, slotLevel: null, reason: `No level ${slotLevel} spell slot is available.` };
  }
  return { ok: true, payment: "slot", slotLevel, reason: null };
}

export function restoredSlotValue(current: unknown, maximum: unknown, remainingReservations = 0): number | null {
  const currentValue = integerAtLeast(current, 0);
  const maximumValue = integerAtLeast(maximum, 0);
  const reservedValue = integerAtLeast(remainingReservations, 0);
  if (currentValue === null || maximumValue === null || reservedValue === null) return null;

  const availableMaximum = Math.max(0, maximumValue - reservedValue);
  if (currentValue >= availableMaximum) return currentValue;
  return Math.min(currentValue + 1, availableMaximum);
}
