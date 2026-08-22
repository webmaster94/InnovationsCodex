import {
  requiresAttunement,
  restoredSlotValue,
  validateFabrication,
  type ImbuementPayment
} from "./imbuements.ts";
import { maximumPatternTier, patternCapacity } from "./subclass-rules.ts";
import {
  applicableInnovationSpellGrants,
  buildFeatureAdvancementMigration,
  identifyInnovationSpellGrant,
  planFeatureActivityRepair,
  type AdvancementFeature
} from "./college-features.ts";
import {
  parseSlotLevel,
  resolveSlotLevel,
  updateSlotLevelMaps,
  type SlotLevel
} from "./slot-levels.ts";

const MODULE_ID = "innovations-codex";
const CODEX_NAME = "Innovations Codex";
const FEAT_NAME = "Create Innovation";
const PROTOTYPE_NAME = "Prototype Imbuements";
const SCHEMA_VERSION = 3;
const RECENT_OPEN = new Map();
const ACTION_LOCKS = new Map<string, Promise<void>>();
const WORLD_STATE_LOCK = `${MODULE_ID}:world-state`;
const ALLOWED_BLUEPRINT_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container"]);

const SPELL_LEVEL_FOLDERS = [
  "Uncategorized",
  "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"
];

type AnyDocument = any;
type SocketContext = { socketdata?: { userId?: string } };
type Reservation = {
  id: string;
  codexUuid: string;
  ownerActorUuid: string;
  temporaryItemUuid: string;
  blueprintUuid: string;
  targetActorUuid: string;
  hostItemUuid: string | null;
  slotLevel: SlotLevel | null;
  payment: ImbuementPayment;
  createdAt: number;
};

type BlueprintApproval = {
  blueprintUuid: string;
  codexUuid: string;
  ownerActorUuid: string;
  slotLevel: SlotLevel;
  approvedBy: string;
  approvedAt: number;
  snapshot: Record<string, unknown>;
};

type InspirationGrant = {
  id: string;
  reservationId: string;
  ownerActorUuid: string;
  targetActorUuid: string;
  grantItemUuid: string;
  die: string;
  intelligenceModifier: number;
  createdAt: number;
};

type ReleaseReceipt = {
  reservationId: string;
  ownerActorUuid: string;
  slotLevel: SlotLevel;
  beforeValue: number;
  restoredValue: number;
  createdAt: number;
};

type WorldState = {
  schemaVersion: number;
  codexByActorUuid: Record<string, string>;
  approvalsByBlueprintUuid: Record<string, BlueprintApproval>;
  reservationsById: Record<string, Reservation>;
  inspirationGrantsById: Record<string, InspirationGrant>;
  releaseReceiptsByReservationId: Record<string, ReleaseReceipt>;
};

let icSocket: any;
let initializationReady = false;

function emptyWorldState(): WorldState {
  return {
    schemaVersion: SCHEMA_VERSION,
    codexByActorUuid: {},
    approvalsByBlueprintUuid: {},
    reservationsById: {},
    inspirationGrantsById: {},
    releaseReceiptsByReservationId: {}
  };
}

function getWorldState(): WorldState {
  const stored = foundry.utils.deepClone(game.settings.get(MODULE_ID, "worldState") ?? {});
  const empty = emptyWorldState();
  return {
    schemaVersion: Number(stored.schemaVersion ?? 0),
    codexByActorUuid: stored.codexByActorUuid && typeof stored.codexByActorUuid === "object"
      ? stored.codexByActorUuid : empty.codexByActorUuid,
    approvalsByBlueprintUuid: stored.approvalsByBlueprintUuid && typeof stored.approvalsByBlueprintUuid === "object"
      ? stored.approvalsByBlueprintUuid : empty.approvalsByBlueprintUuid,
    reservationsById: stored.reservationsById && typeof stored.reservationsById === "object"
      ? stored.reservationsById : empty.reservationsById,
    inspirationGrantsById: stored.inspirationGrantsById && typeof stored.inspirationGrantsById === "object"
      ? stored.inspirationGrantsById : empty.inspirationGrantsById,
    releaseReceiptsByReservationId: stored.releaseReceiptsByReservationId
      && typeof stored.releaseReceiptsByReservationId === "object"
      ? stored.releaseReceiptsByReservationId : empty.releaseReceiptsByReservationId
  };
}

async function setWorldState(state: WorldState): Promise<void> {
  if (!isActiveGM()) throw new Error("Only the active GM may update Innovations Codex world state.");
  state.schemaVersion = SCHEMA_VERSION;
  await game.settings.set(MODULE_ID, "worldState", state);
}

function assertReady(): void {
  const migratedPlayerClient = !isActiveGM()
    && Number(game.settings.get(MODULE_ID, "schemaVersion") ?? 0) >= SCHEMA_VERSION;
  if (!initializationReady && !migratedPlayerClient) {
    throw new Error("Innovations Codex is still initializing. Try again in a moment.");
  }
}

function reportError(error: unknown, message = "Innovations Codex operation failed.") {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`${MODULE_ID} | ${message}`, error);
  ui.notifications?.error(`${message} ${detail}`);
}

function escapeHtml(value: unknown): string {
  const element = document.createElement("div");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = ACTION_LOCKS.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  ACTION_LOCKS.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ACTION_LOCKS.get(key) === tail) ACTION_LOCKS.delete(key);
  }
}

function currentSocketUser(context: SocketContext): AnyDocument {
  const userId = context.socketdata?.userId;
  const user = userId ? game.users.get(userId) : null;
  if (!user) throw new Error("Unable to identify the requesting Foundry user.");
  return user;
}

function requireActorOwner(context: SocketContext, actor: AnyDocument): AnyDocument {
  const user = currentSocketUser(context);
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  if (!user.isGM && !actor?.testUserPermission?.(user, ownerLevel)) {
    throw new Error(`You do not own ${actor?.name ?? "that actor"}.`);
  }
  return user;
}

function requireActorDocument(document: AnyDocument): AnyDocument {
  if (!(document instanceof Actor)) throw new Error("Actor not found.");
  return document;
}

function requireWorldActor(document: AnyDocument): AnyDocument {
  const actor = requireActorDocument(document);
  if (!actor.id || game.actors.get(actor.id) !== actor || actor.uuid !== `Actor.${actor.id}`) {
    throw new Error("Only world actors may use Innovations Codex operations.");
  }
  return actor;
}

function requireCollegeActor(actor: AnyDocument): AnyDocument {
  if (!isCollegeOfInnovationActor(actor)) {
    throw new Error(`${actor?.name ?? "That actor"} does not have the College of Innovation subclass.`);
  }
  return actor;
}

function requireItemDocument(document: AnyDocument): AnyDocument {
  if (!(document instanceof Item)) throw new Error("Item not found.");
  return document;
}

function getOwnerReservations(ownerActorUuid: string, state = getWorldState()): Reservation[] {
  return Object.values(state.reservationsById)
    .filter((reservation) => reservation.ownerActorUuid === ownerActorUuid);
}

function getActiveOwnerReservations(ownerActor: AnyDocument, state = getWorldState()): Reservation[] {
  return getOwnerReservations(ownerActor.uuid, state)
    .filter((reservation) => !state.releaseReceiptsByReservationId[reservation.id]);
}

function getCodexReservations(codexUuid: string, state = getWorldState()): Reservation[] {
  return Object.values(state.reservationsById)
    .filter((reservation) => reservation.codexUuid === codexUuid);
}

function requireCanonicalCodex(codex: AnyDocument, ownerActor: AnyDocument, state = getWorldState()): AnyDocument {
  if (!isCodexItem(codex) || codex.parent !== ownerActor) {
    throw new Error("Codex does not belong to the source actor.");
  }
  if (state.codexByActorUuid[ownerActor.uuid] !== codex.uuid) {
    throw new Error("That is not this actor's canonical Innovations Codex.");
  }
  return codex;
}

function blueprintSnapshot(blueprint: AnyDocument): Record<string, unknown> {
  const data: any = foundry.utils.deepClone(blueprint.toObject());
  delete data._id;
  delete data.folder;
  delete data.ownership;
  delete data._stats;
  foundry.utils.setProperty(data, "system.container", null);
  if (data.system) delete data.system.containerId;
  delete data.flags?.[MODULE_ID]?.spellLevel;
  delete data.flags?.[MODULE_ID]?.approved;
  delete data.flags?.[MODULE_ID]?.approvalUpdatedAt;
  return data;
}

function snapshotsMatch(approval: BlueprintApproval, blueprint: AnyDocument): boolean {
  const current = blueprintSnapshot(blueprint);
  return foundry.utils.isObjectEqual?.(approval.snapshot, current)
    ?? JSON.stringify(approval.snapshot) === JSON.stringify(current);
}

function getPrototypeFeature(actor: AnyDocument): AnyDocument | null {
  return actor?.items?.find((item: AnyDocument) =>
    item.getFlag?.(MODULE_ID, "feature") === "prototype-imbuements" || item.name === PROTOTYPE_NAME
  ) ?? null;
}

function getSpellSlot(actor: AnyDocument, level: SlotLevel): { value: unknown; max: unknown; path: string } {
  const base = `system.spells.spell${level}`;
  return {
    value: foundry.utils.getProperty(actor, `${base}.value`),
    max: foundry.utils.getProperty(actor, `${base}.max`),
    path: `${base}.value`
  };
}

function getBardLevel(actor: AnyDocument): number {
  const classItem = actor?.items?.find((item: AnyDocument) => item.type === "class"
    && (item.system?.identifier === "bard" || item.name === "Bard"));
  const level = Number(classItem?.system?.levels ?? actor?.classes?.bard?.system?.levels ?? 0);
  return Number.isInteger(level) && level > 0 ? level : 0;
}

function _registerSocketlib() {
  if (icSocket) return;
  const sock = socketlib.registerModule(MODULE_ID);
  if (!sock) {
    console.error(`${MODULE_ID} | socketlib.registerModule returned undefined. Make sure "socket":true is in module.json and you have restarted the world from the Foundry setup screen (not just refreshed the browser).`);
    return;
  }
  sock.register("addCodexToActor", _gmAddCodexToActor);
  sock.register("createInnovation", _gmCreateInnovation);
  sock.register("fabricate", _gmFabricate);
  sock.register("recall", _gmRecall);
  sock.register("assignSlotLevel", _gmAssignSlotLevel);
  sock.register("syncMirror", _gmSyncMirror);
  sock.register("grantInspiration", _gmGrantInspiration);
  sock.register("consumeInspiration", _gmConsumeInspiration);
  icSocket = sock;
  console.log(`${MODULE_ID} | socketlib registered successfully`);
}

/* ================================================== */
/*  SECTION 1: GM-only handler functions              */
/*  These run on the GM client via socketlib          */
/* ================================================== */

/**
 * GM handler: Add a codex container to an actor.
 * @param {string} actorUuid - The actor to receive the codex
 * @returns {string|null} The UUID of the created codex item, or null
 */
async function _gmAddCodexToActor(this: SocketContext, actorUuid: string): Promise<string | null> {
  assertReady();
  const actor = requireCollegeActor(requireWorldActor(await fromUuid(actorUuid)));
  requireActorOwner(this, actor);

  return withLock(WORLD_STATE_LOCK, async () => {
    const state = getWorldState();
    const canonicalUuid = state.codexByActorUuid[actor.uuid];
    const canonical = canonicalUuid ? await fromUuid(canonicalUuid) : null;
    if (canonical instanceof Item && canonical.parent === actor && isCodexItem(canonical)) return canonical.uuid;

    const existing = actor.items.find((item: AnyDocument) => isCodexItem(item));
    if (existing) {
      state.codexByActorUuid[actor.uuid] = existing.uuid;
      await setWorldState(state);
      return existing.uuid;
    }

    const worldCodex = game.items.find((item: AnyDocument) => item.getFlag?.(MODULE_ID, "isCodex"));
    if (!worldCodex) throw new Error("The world Innovations Codex template is missing.");
    const codexData: any = worldCodex.toObject();
    delete codexData._id;
    delete codexData.folder;
    delete codexData.ownership;
    foundry.utils.setProperty(codexData, "system.container", null);
    if (codexData.system) delete codexData.system.containerId;

    const [created] = await actor.createEmbeddedDocuments("Item", [codexData]);
    if (!created) throw new Error("Foundry did not create the Innovations Codex.");
    state.codexByActorUuid[actor.uuid] = created.uuid;
    await setWorldState(state);
    return created.uuid;
  });
}

/**
 * GM handler: Create a new innovation item inside an actor's codex.
 * @param {string} actorUuid
 * @param {string} codexId - The ID of the codex item on the actor
 * @param {string} itemName
 * @param {string} itemType
 * @returns {string|null} UUID of the created item
 */
async function _gmCreateInnovation(
  this: SocketContext,
  actorUuid: string,
  codexId: string,
  itemName: string,
  itemType: string
): Promise<string | null> {
  assertReady();
  const actor = requireCollegeActor(requireWorldActor(await fromUuid(actorUuid)));
  const user = requireActorOwner(this, actor);
  const codex = actor.items.get(codexId);
  const state = getWorldState();
  requireCanonicalCodex(codex, actor, state);
  const normalizedName = String(itemName ?? "").trim().slice(0, 100);
  if (!normalizedName) throw new Error("Innovation name is required.");
  if (!ALLOWED_BLUEPRINT_TYPES.has(itemType)) throw new Error("Unsupported innovation item type.");

  return withLock(actor.uuid, async () => {
    const existingPatterns = actor.items.filter((item: AnyDocument) => isItemInCodex(item, codex)
      && item.getFlag?.(MODULE_ID, "isInnovation"));
    const capacity = patternCapacity(getBardLevel(actor));
    if (existingPatterns.length >= capacity) {
      throw new Error(`${actor.name} already knows the maximum ${capacity} innovation patterns for their Bard level.`);
    }

    const [created] = await actor.createEmbeddedDocuments("Item", [{
      name: normalizedName,
      type: itemType,
      flags: {
        [MODULE_ID]: {
          isInnovation: true,
          spellLevel: null,
          approved: false,
          createdBy: actorUuid
        }
      },
      system: { container: codexId }
    }]);
    if (!created) return null;

    await syncMirrorFromBlueprint(created, null);
    void notifyGMs(
      `<strong>${escapeHtml(user.name)}</strong>'s character <strong>${escapeHtml(actor.name)}</strong> created `
      + `a new innovation draft: <strong>${escapeHtml(created.name)}</strong>.`
    ).catch((error) => console.warn(`${MODULE_ID} | Could not send GM notification`, error));
    return created.uuid;
  });
}

/**
 * GM handler: Fabricate an item onto a target actor.
 * Deducts a spell slot from the owner and creates a temporary copy on the target.
 * @param {string} ownerActorUuid
 * @param {string} targetActorUuid
 * @param {string} blueprintUuid
 * @param {string} codexUuid
 * @param {number} slotLevel
 * @returns {boolean} success
 */
async function _gmFabricate(
  this: SocketContext,
  ownerActorUuid: string,
  targetActorUuid: string,
  blueprintUuid: string,
  codexUuid: string,
  payment: ImbuementPayment,
  hostItemUuid: string | null = null
): Promise<{ success: boolean; itemUuid?: string; message?: string }> {
  assertReady();
  const ownerActor = requireCollegeActor(requireWorldActor(await fromUuid(ownerActorUuid)));
  const targetActor = requireWorldActor(await fromUuid(targetActorUuid));
  const blueprint = requireItemDocument(await fromUuid(blueprintUuid));
  const codex = requireItemDocument(await fromUuid(codexUuid));
  const user = requireActorOwner(this, ownerActor);
  const initialState = getWorldState();
  requireCanonicalCodex(codex, ownerActor, initialState);
  if (blueprint.parent !== ownerActor || !isItemInCodex(blueprint, codex)) {
    throw new Error("Blueprint does not belong to that codex.");
  }
  if (!blueprint.getFlag?.(MODULE_ID, "isInnovation")) throw new Error("That item is not an innovation blueprint.");
  if (!isAllowedTarget(user, targetActor)) throw new Error("That actor is not an allowed fabrication target.");

  const hostItem = hostItemUuid ? requireItemDocument(await fromUuid(hostItemUuid)) : null;
  if (hostItem && (hostItem.parent !== targetActor || hostItem.getFlag?.(MODULE_ID, "isTemporary"))) {
    throw new Error("The selected host item does not belong to the target actor.");
  }

  return withLock(WORLD_STATE_LOCK, async () => {
    const state = getWorldState();
    requireCanonicalCodex(codex, ownerActor, state);
    const approval = state.approvalsByBlueprintUuid[blueprint.uuid];
    if (!approval || approval.codexUuid !== codex.uuid || approval.ownerActorUuid !== ownerActor.uuid) {
      return { success: false, message: "This blueprint is awaiting GM approval." };
    }
    if (!snapshotsMatch(approval, blueprint)) {
      return { success: false, message: "This blueprint changed after approval and must be reviewed again." };
    }
    const allowedTier = maximumPatternTier(ownerActor.system?.spells ?? {});
    if (approval.slotLevel > allowedTier) {
      return { success: false, message: `This blueprint's level exceeds ${ownerActor.name}'s current pattern tier.` };
    }
    if (hostItemUuid && Object.values(state.reservationsById)
      .some((reservation) => reservation.hostItemUuid === hostItemUuid)) {
      return { success: false, message: "That item already bears an active innovation." };
    }

    const slotLevel = approval.slotLevel;
    const prototype = getPrototypeFeature(ownerActor);
    const slot = getSpellSlot(ownerActor, slotLevel);
    const activeCount = getActiveOwnerReservations(ownerActor, state).length;
    const decision = validateFabrication({
      activeCount,
      proficiencyBonus: foundry.utils.getProperty(ownerActor, "system.attributes.prof"),
      payment,
      slotLevel,
      availableSlots: slot.value,
      freeUsesSpent: prototype ? foundry.utils.getProperty(prototype, "system.uses.spent") : null
    });
    if (!decision.ok) return { success: false, message: decision.reason ?? "Fabrication was rejected." };
    if (decision.payment === "free" && !prototype) {
      return { success: false, message: "Prototype Imbuements was not found on the source actor." };
    }

    const reservationId = foundry.utils.randomID();
    let paymentApplied = false;
    let created: AnyDocument | null = null;
    try {
      if (decision.payment === "slot" && decision.slotLevel) {
        const current = getSpellSlot(ownerActor, decision.slotLevel);
        const currentValue = Number(current.value);
        if (!Number.isFinite(currentValue) || currentValue <= 0) {
          return { success: false, message: `No level ${decision.slotLevel} spell slot is available.` };
        }
        await ownerActor.update({ [current.path]: currentValue - 1 });
      } else if (decision.payment === "free") {
        const spent = Number(foundry.utils.getProperty(prototype, "system.uses.spent") ?? 0);
        if (!Number.isInteger(spent) || spent >= 1) {
          return { success: false, message: "The free imbuement is already spent." };
        }
        await prototype.update({ "system.uses.spent": spent + 1 });
      }
      paymentApplied = true;

      const itemData: any = foundry.utils.deepClone(approval.snapshot);
      foundry.utils.setProperty(itemData, "system.container", null);
      if (itemData.system) delete itemData.system.containerId;
      const temporaryName = blueprint.name.startsWith("Temporary ") ? blueprint.name : `Temporary ${blueprint.name}`;
      itemData.name = hostItem ? `${temporaryName} — ${hostItem.name}` : temporaryName;
      if (hostItem && requiresAttunement(hostItem.system?.attunement)) {
        foundry.utils.setProperty(itemData, "system.attunement", "");
      }
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.originUuid`, codex.uuid);
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.isTemporary`, true);
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.reservationId`, reservationId);
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.ownerActorUuid`, ownerActor.uuid);
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.blueprintUuid`, blueprint.uuid);
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.payment`, decision.payment);
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.spellLevel`, decision.slotLevel);
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.hostItemUuid`, hostItemUuid);

      [created] = await targetActor.createEmbeddedDocuments("Item", [itemData]);
      if (!created) throw new Error("Foundry did not create the fabricated item.");

      state.reservationsById[reservationId] = {
        id: reservationId,
        codexUuid: codex.uuid,
        ownerActorUuid: ownerActor.uuid,
        temporaryItemUuid: created.uuid,
        blueprintUuid: blueprint.uuid,
        targetActorUuid: targetActor.uuid,
        hostItemUuid,
        slotLevel: decision.slotLevel,
        payment: decision.payment as ImbuementPayment,
        createdAt: Date.now()
      };
      await setWorldState(state);

      void notifyGMs(
        `<strong>${escapeHtml(user.name)}</strong>'s character <strong>${escapeHtml(ownerActor.name)}</strong> `
        + `fabricated <strong>${escapeHtml(blueprint.name)}</strong> for <strong>${escapeHtml(targetActor.name)}</strong>.`
      ).catch((error) => console.warn(`${MODULE_ID} | Could not send GM notification`, error));
      return { success: true, itemUuid: created.uuid };
    } catch (error) {
      if (created?.parent instanceof Actor) {
        await created.parent.deleteEmbeddedDocuments("Item", [created.id], { innovationsCodexRollback: true });
      }
      if (paymentApplied && decision.payment === "slot" && decision.slotLevel) {
        const current = getSpellSlot(ownerActor, decision.slotLevel);
        const remaining = getActiveOwnerReservations(ownerActor, getWorldState())
          .filter((reservation) => reservation.payment === "slot" && reservation.slotLevel === decision.slotLevel).length;
        const restored = restoredSlotValue(current.value, current.max, remaining);
        if (restored !== null) await ownerActor.update({ [current.path]: restored });
      } else if (paymentApplied && decision.payment === "free" && prototype) {
        const spent = Number(foundry.utils.getProperty(prototype, "system.uses.spent") ?? 1);
        await prototype.update({ "system.uses.spent": Math.max(0, spent - 1) });
      }
      throw error;
    }
  });
}

/**
 * GM handler: Recall (delete) a fabricated item.
 * @param {string} itemUuid
 * @param {string} codexUuid
 * @returns {boolean}
 */
async function releaseReservation(
  ownerActor: AnyDocument,
  state: WorldState,
  reservation: Reservation
): Promise<void> {
  for (const [grantId, grant] of Object.entries(state.inspirationGrantsById)) {
    if (grant.reservationId !== reservation.id) continue;
    const grantItem = await fromUuid(grant.grantItemUuid);
    if (grantItem instanceof Item && grantItem.parent instanceof Actor) {
      await grantItem.parent.deleteEmbeddedDocuments("Item", [grantItem.id], { innovationsCodexInspiration: true });
    }
    delete state.inspirationGrantsById[grantId];
  }
  if (reservation.payment === "slot" && reservation.slotLevel) {
    const slot = getSpellSlot(ownerActor, reservation.slotLevel);
    const current = Number(slot.value);
    if (!Number.isFinite(current)) throw new Error("The parked spell slot has an invalid current value.");
    let receipt = state.releaseReceiptsByReservationId[reservation.id];
    if (!receipt) {
      const remaining = getActiveOwnerReservations(ownerActor, state)
        .filter((candidate) => candidate.id !== reservation.id
          && candidate.payment === "slot"
          && candidate.slotLevel === reservation.slotLevel).length;
      const restored = restoredSlotValue(slot.value, slot.max, remaining);
      if (restored === null) throw new Error("The parked spell slot could not be restored.");
      receipt = {
        reservationId: reservation.id,
        ownerActorUuid: ownerActor.uuid,
        slotLevel: reservation.slotLevel,
        beforeValue: current,
        restoredValue: restored,
        createdAt: Date.now()
      };
      state.releaseReceiptsByReservationId[reservation.id] = receipt;
      await setWorldState(state);
    }
    if (current === receipt.beforeValue) {
      await ownerActor.update({ [slot.path]: receipt.restoredValue }, { innovationsCodexReconcile: true });
    } else if (current !== receipt.restoredValue) {
      throw new Error("The interrupted slot release requires GM review before it can continue.");
    }
  }
  delete state.reservationsById[reservation.id];
  delete state.releaseReceiptsByReservationId[reservation.id];
  await setWorldState(state);
}

async function _gmRecall(this: SocketContext, itemUuid: string, codexUuid: string): Promise<boolean> {
  assertReady();
  const item = requireItemDocument(await fromUuid(itemUuid));
  const codex = requireItemDocument(await fromUuid(codexUuid));
  const ownerActor = requireCollegeActor(requireWorldActor(codex.parent));
  const user = requireActorOwner(this, ownerActor);
  const initialState = getWorldState();
  requireCanonicalCodex(codex, ownerActor, initialState);
  if (item.getFlag(MODULE_ID, "originUuid") !== codex.uuid) {
    throw new Error("That item is not an active imbuement from this codex.");
  }
  const targetActor = requireWorldActor(item.parent);

  return withLock(WORLD_STATE_LOCK, async () => {
    const reservationId = item.getFlag(MODULE_ID, "reservationId");
    const state = getWorldState();
    requireCanonicalCodex(codex, ownerActor, state);
    const reservation = reservationId ? state.reservationsById[reservationId] : null;
    if (!reservation) {
      throw new Error("No trusted reservation exists for this imbuement. A GM must repair it before recall.");
    }
    if (reservation.codexUuid !== codex.uuid
      || reservation.ownerActorUuid !== ownerActor.uuid
      || reservation.temporaryItemUuid !== item.uuid
      || reservation.targetActorUuid !== targetActor.uuid
      || reservation.blueprintUuid !== item.getFlag(MODULE_ID, "blueprintUuid")) {
      throw new Error("The imbuement does not match its trusted reservation record.");
    }

    await targetActor.deleteEmbeddedDocuments("Item", [item.id], { innovationsCodexRecall: true });
    await releaseReservation(ownerActor, state, reservation);
    void notifyGMs(
      `<strong>${escapeHtml(user.name)}</strong>'s character <strong>${escapeHtml(ownerActor.name)}</strong> `
      + `recalled <strong>${escapeHtml(item.name)}</strong>.`
    ).catch((error) => console.warn(`${MODULE_ID} | Could not send GM notification`, error));
    return true;
  });
}

function bardicInspirationDie(actor: AnyDocument): string {
  const level = getBardLevel(actor);
  if (level >= 15) return "1d12";
  if (level >= 10) return "1d10";
  if (level >= 5) return "1d8";
  return "1d6";
}

async function _gmGrantInspiration(
  this: SocketContext,
  reservationId: string
): Promise<{ success: boolean; message?: string }> {
  assertReady();
  const initialState = getWorldState();
  const initialReservation = initialState.reservationsById[String(reservationId ?? "")];
  if (!initialReservation) throw new Error("The active imbuement was not found.");
  const ownerActor = requireCollegeActor(requireWorldActor(await fromUuid(initialReservation.ownerActorUuid)));
  requireActorOwner(this, ownerActor);

  return withLock(WORLD_STATE_LOCK, async () => {
    const state = getWorldState();
    const reservation = state.reservationsById[reservationId];
    if (!reservation || reservation.ownerActorUuid !== ownerActor.uuid) {
      return { success: false, message: "The active imbuement is no longer available." };
    }
    if (Object.values(state.inspirationGrantsById)
      .some((grant) => grant.reservationId === reservation.id)) {
      return { success: false, message: "This imbuement already carries Bardic Inspiration." };
    }
    const temporary = await fromUuid(reservation.temporaryItemUuid);
    const targetActor = requireWorldActor(await fromUuid(reservation.targetActorUuid));
    if (!(temporary instanceof Item) || temporary.parent !== targetActor
      || temporary.getFlag?.(MODULE_ID, "reservationId") !== reservation.id) {
      throw new Error("The imbuement does not match its trusted reservation.");
    }
    const inspiration = findBardicInspirationFeature(ownerActor);
    if (!inspiration) return { success: false, message: "Bardic Inspiration was not found on the source actor." };
    const spent = Number(foundry.utils.getProperty(inspiration, "system.uses.spent") ?? 0);
    const maximum = Number(foundry.utils.getProperty(inspiration, "system.uses.max") ?? 0);
    if (!Number.isFinite(spent) || !Number.isFinite(maximum) || spent >= maximum) {
      return { success: false, message: "No Bardic Inspiration uses remain." };
    }

    const grantId = foundry.utils.randomID();
    const activityId = foundry.utils.randomID();
    let grantItem: AnyDocument | null = null;
    await inspiration.update({ "system.uses.spent": spent + 1 });
    try {
      [grantItem] = await targetActor.createEmbeddedDocuments("Item", [{
        name: `Innovation Bardic Inspiration — ${ownerActor.name}`,
        type: "feat",
        img: inspiration.img,
        system: {
          description: {
            value: `<p>Spend this die after an attack roll, ability check, or saving throw. `
              + `Attack rolls and ability checks also add ${Number(ownerActor.system?.abilities?.int?.mod ?? 0)}.</p>`
          },
          activities: { [activityId]: buildInspirationActivity(activityId) }
        },
        flags: {
          [MODULE_ID]: {
            inspirationGrantId: grantId,
            ownerActorUuid: ownerActor.uuid,
            reservationId: reservation.id
          }
        }
      }]);
      if (!grantItem) throw new Error("Foundry did not create the Inspiration grant.");
      state.inspirationGrantsById[grantId] = {
        id: grantId,
        reservationId: reservation.id,
        ownerActorUuid: ownerActor.uuid,
        targetActorUuid: targetActor.uuid,
        grantItemUuid: grantItem.uuid,
        die: bardicInspirationDie(ownerActor),
        intelligenceModifier: Number(ownerActor.system?.abilities?.int?.mod ?? 0),
        createdAt: Date.now()
      };
      await setWorldState(state);
      return { success: true };
    } catch (error) {
      if (grantItem) {
        await targetActor.deleteEmbeddedDocuments("Item", [grantItem.id], { innovationsCodexInspiration: true });
      }
      await inspiration.update({ "system.uses.spent": spent });
      throw error;
    }
  });
}

async function _gmConsumeInspiration(
  this: SocketContext,
  grantItemUuid: string,
  rollType: string
): Promise<{ formula: string; ownerName: string }> {
  assertReady();
  const grantItem = requireItemDocument(await fromUuid(grantItemUuid));
  const targetActor = requireWorldActor(grantItem.parent);
  requireActorOwner(this, targetActor);
  const grantId = String(grantItem.getFlag?.(MODULE_ID, "inspirationGrantId") ?? "");
  const state = getWorldState();
  const grant = state.inspirationGrantsById[grantId];
  if (!grant || grant.grantItemUuid !== grantItem.uuid || grant.targetActorUuid !== targetActor.uuid) {
    throw new Error("That Inspiration grant is not trusted or has already been used.");
  }
  if (!["attack", "check", "save"].includes(rollType)) throw new Error("Choose a valid roll type.");
  const ownerActor = requireWorldActor(await fromUuid(grant.ownerActorUuid));

  await withLock(WORLD_STATE_LOCK, async () => {
    const currentState = getWorldState();
    const current = currentState.inspirationGrantsById[grantId];
    if (!current) throw new Error("That Inspiration grant has already been used.");
    await targetActor.deleteEmbeddedDocuments("Item", [grantItem.id], { innovationsCodexInspiration: true });
    delete currentState.inspirationGrantsById[grantId];
    await setWorldState(currentState);
  });
  const modifier = rollType === "save" ? 0 : grant.intelligenceModifier;
  return {
    formula: `${grant.die}${modifier === 0 ? "" : modifier > 0 ? `+${modifier}` : String(modifier)}`,
    ownerName: ownerActor.name
  };
}

async function syncMirrorFromBlueprint(blueprint: AnyDocument, level: SlotLevel | null): Promise<void> {
  const folder = getSpellLevelFolder(level);
  if (!folder) {
    throw new Error(`Spell-level folder not found for level ${level ?? "Uncategorized"}.`);
  }
  const mirrorItem = game.items.find((item: AnyDocument) => item.getFlag(MODULE_ID, "mirrorOf") === blueprint.uuid);
  const mirrorData = foundry.utils.deepClone(blueprint.toObject());
  delete mirrorData._id;
  delete mirrorData.folder;
  delete mirrorData.ownership;
  delete mirrorData._stats;
  mirrorData.folder = folder.id;
  foundry.utils.setProperty(mirrorData, "system.container", null);
  if (mirrorData.system) delete mirrorData.system.containerId;
  foundry.utils.setProperty(mirrorData, `flags.${MODULE_ID}.mirrorOf`, blueprint.uuid);
  foundry.utils.setProperty(mirrorData, `flags.${MODULE_ID}.spellLevel`, level);
  if (mirrorItem) {
    await mirrorItem.update(mirrorData, { innovationsCodexMirror: true, diff: false });
  } else {
    await Item.create(mirrorData);
  }
}

async function _gmAssignSlotLevel(
  this: SocketContext,
  codexUuid: string,
  blueprintUuid: string,
  requestedLevel: unknown
): Promise<boolean> {
  assertReady();
  const codex = requireItemDocument(await fromUuid(codexUuid));
  const blueprint = requireItemDocument(await fromUuid(blueprintUuid));
  const ownerActor = requireCollegeActor(requireWorldActor(codex.parent));
  const user = currentSocketUser(this);
  if (!user.isGM) throw new Error("Only a GM may approve an innovation or assign its spell level.");
  const initialState = getWorldState();
  requireCanonicalCodex(codex, ownerActor, initialState);
  if (blueprint.parent !== ownerActor || !isItemInCodex(blueprint, codex)
    || !blueprint.getFlag?.(MODULE_ID, "isInnovation")) {
    throw new Error("Blueprint does not belong to that codex.");
  }
  const level = requestedLevel === null || requestedLevel === "" || requestedLevel === 0 || requestedLevel === "0"
    ? null
    : parseSlotLevel(requestedLevel);
  if (requestedLevel !== null && requestedLevel !== "" && requestedLevel !== 0 && requestedLevel !== "0" && level === null) {
    throw new Error("Spell level must be between 1 and 9.");
  }

  if (level !== null && level > maximumPatternTier(ownerActor.system?.spells ?? {})) {
    throw new Error(`${ownerActor.name} cannot learn innovation patterns of that tier yet.`);
  }

  return withLock(WORLD_STATE_LOCK, async () => {
    const state = getWorldState();
    requireCanonicalCodex(codex, ownerActor, state);
    const maps = updateSlotLevelMaps({
      blueprintId: blueprint.id,
      blueprintName: blueprint.name,
      slotLevelsByItemId: codex.getFlag(MODULE_ID, "slotLevelsByItemId"),
      slotLevelsByName: codex.getFlag(MODULE_ID, "slotLevelsByName")
    }, level);
    await codex.update({
      [`flags.${MODULE_ID}.slotLevelsByItemId`]: maps.slotLevelsByItemId,
      [`flags.${MODULE_ID}.slotLevelsByName`]: maps.slotLevelsByName
    });
    if (level === null) {
      delete state.approvalsByBlueprintUuid[blueprint.uuid];
    } else {
      state.approvalsByBlueprintUuid[blueprint.uuid] = {
        blueprintUuid: blueprint.uuid,
        codexUuid: codex.uuid,
        ownerActorUuid: ownerActor.uuid,
        slotLevel: level,
        approvedBy: user.id,
        approvedAt: Date.now(),
        snapshot: blueprintSnapshot(blueprint)
      };
    }
    await setWorldState(state);
    await blueprint.update({
      [`flags.${MODULE_ID}.spellLevel`]: level,
      [`flags.${MODULE_ID}.approved`]: level !== null,
      [`flags.${MODULE_ID}.approvalUpdatedAt`]: Date.now()
    }, { innovationsCodexApproval: true });
    await syncMirrorFromBlueprint(blueprint, level);
    const label = level ? `Level ${level}` : "Uncategorized";
    void notifyGMs(
      `<strong>${escapeHtml(user.name)}</strong>'s character <strong>${escapeHtml(ownerActor.name)}</strong> assigned `
      + `<strong>${escapeHtml(blueprint.name)}</strong> to <strong>${label}</strong>.`
    ).catch((error) => console.warn(`${MODULE_ID} | Could not send GM notification`, error));
    return true;
  });
}

async function _gmSyncMirror(this: SocketContext, blueprintUuid: string): Promise<boolean> {
  assertReady();
  const blueprint = requireItemDocument(await fromUuid(blueprintUuid));
  const ownerActor = requireCollegeActor(requireWorldActor(blueprint.parent));
  const user = currentSocketUser(this);
  if (!user.isGM) throw new Error("Only a GM may synchronize innovation mirrors.");
  const codex = ownerActor.items.find((item: AnyDocument) => isCodexItem(item) && isItemInCodex(blueprint, item));
  if (!codex) throw new Error("Blueprint is not inside an Innovations Codex.");
  const state = getWorldState();
  requireCanonicalCodex(codex, ownerActor, state);
  await syncMirrorFromBlueprint(blueprint, state.approvalsByBlueprintUuid[blueprint.uuid]?.slotLevel ?? null);
  return true;
}

async function notifyGMs(message: string): Promise<void> {
  await ChatMessage.create({
    content: `<strong>${MODULE_ID}</strong> | ${message}`,
    whisper: ChatMessage.getWhisperRecipients("GM"),
    speaker: { alias: "Innovations Codex" }
  });
}

/* ================================================== */
/*  SECTION 2: Socketlib wrappers (call from anyone)  */
/* ================================================== */

function _ensureSocket() {
  assertReady();
  if (icSocket) return;
  throw new Error("socketlib is not ready. An active GM and socketlib are required.");
}

async function addCodexToActor(actorUuid: string): Promise<string | null> {
  _ensureSocket();
  return icSocket.executeAsGM("addCodexToActor", actorUuid);
}

async function createInnovationOnActor(actorUuid: string, codexId: string, itemName: string, itemType: string): Promise<string | null> {
  _ensureSocket();
  return icSocket.executeAsGM("createInnovation", actorUuid, codexId, itemName, itemType);
}

async function fabricate(
  ownerActorUuid: string,
  targetActorUuid: string,
  blueprintUuid: string,
  codexUuid: string,
  payment: ImbuementPayment,
  hostItemUuid: string | null = null
): Promise<{ success: boolean; itemUuid?: string; message?: string }> {
  _ensureSocket();
  return icSocket.executeAsGM("fabricate", ownerActorUuid, targetActorUuid, blueprintUuid, codexUuid, payment, hostItemUuid);
}

async function requestRecall(itemUuid: string, codexUuid: string): Promise<boolean> {
  _ensureSocket();
  return icSocket.executeAsGM("recall", itemUuid, codexUuid);
}

async function assignSlotLevel(codexUuid: string, blueprintUuid: string, level: SlotLevel | null): Promise<boolean> {
  _ensureSocket();
  return icSocket.executeAsGM("assignSlotLevel", codexUuid, blueprintUuid, level);
}

async function requestMirrorSync(blueprintUuid: string): Promise<boolean> {
  _ensureSocket();
  return icSocket.executeAsGM("syncMirror", blueprintUuid);
}

async function grantInnovationInspiration(reservationId: string): Promise<{ success: boolean; message?: string }> {
  _ensureSocket();
  return icSocket.executeAsGM("grantInspiration", reservationId);
}

async function consumeInnovationInspiration(
  grantItemUuid: string,
  rollType: string
): Promise<{ formula: string; ownerName: string }> {
  _ensureSocket();
  return icSocket.executeAsGM("consumeInspiration", grantItemUuid, rollType);
}

/* ================================================== */
/*  SECTION 3: Folder & Item Setup (GM only)          */
/* ================================================== */

async function ensureFolderHierarchy(): Promise<AnyDocument> {
  const parentId = (folder: AnyDocument) => folder.folder?.id ?? folder.folder ?? null;
  let rootFolder = game.folders.find(
    (folder: AnyDocument) => folder.type === "Item" && folder.getFlag?.(MODULE_ID, "folderRole") === "root"
  );
  rootFolder ??= game.folders.find(
    (folder: AnyDocument) => folder.name === CODEX_NAME && folder.type === "Item" && !parentId(folder)
  );
  if (!rootFolder) {
    rootFolder = await Folder.create({
      name: CODEX_NAME,
      type: "Item",
      folder: null,
      flags: { [MODULE_ID]: { folderRole: "root" } }
    });
  } else if (rootFolder.getFlag?.(MODULE_ID, "folderRole") !== "root") {
    await rootFolder.setFlag(MODULE_ID, "folderRole", "root");
  }

  for (let level = 0; level < SPELL_LEVEL_FOLDERS.length; level += 1) {
    const name = SPELL_LEVEL_FOLDERS[level];
    const role = `level:${level}`;
    let folder = game.folders.find(
      (candidate: AnyDocument) => candidate.type === "Item"
        && candidate.getFlag?.(MODULE_ID, "folderRole") === role
        && parentId(candidate) === rootFolder.id
    );
    folder ??= game.folders.find(
      (candidate: AnyDocument) => candidate.name === name
        && candidate.type === "Item"
        && parentId(candidate) === rootFolder.id
    );
    if (!folder) {
      folder = await Folder.create({
        name,
        type: "Item",
        folder: rootFolder.id,
        flags: { [MODULE_ID]: { folderRole: role } }
      });
    } else if (folder.getFlag?.(MODULE_ID, "folderRole") !== role) {
      await folder.setFlag(MODULE_ID, "folderRole", role);
    }
  }

  return rootFolder;
}

function buildCreateActivity(activityId: string): Record<string, unknown> {
  return {
    _id: activityId,
    type: "utility",
    name: "Open Codex",
    activation: { type: "action", value: 1, override: true },
    consumption: { scaling: { allowed: false }, targets: [] },
    duration: { override: false, units: "" },
    range: { override: false },
    target: { override: false, prompt: false },
    uses: { spent: 0, max: "", recovery: [] },
    flags: { [MODULE_ID]: { action: "open-codex" } }
  };
}

function buildAnalyticalActivity(activityId: string): Record<string, unknown> {
  return {
    _id: activityId,
    type: "utility",
    name: "Use Analytical Muse",
    activation: { type: "special", value: null, override: true },
    consumption: { scaling: { allowed: false }, targets: [] },
    duration: { override: false, units: "" },
    range: { override: false },
    target: { override: false, prompt: false },
    uses: { spent: 0, max: "", recovery: [] },
    flags: { [MODULE_ID]: { action: "analytical-muse" } }
  };
}

function buildInspirationActivity(activityId: string): Record<string, unknown> {
  return {
    _id: activityId,
    type: "utility",
    name: "Spend Inspiration",
    activation: { type: "special", value: null, override: true },
    consumption: { scaling: { allowed: false }, targets: [] },
    duration: { override: false, units: "" },
    range: { override: false },
    target: { override: false, prompt: false },
    uses: { spent: 0, max: "", recovery: [] },
    flags: { [MODULE_ID]: { action: "spend-inspiration" } }
  };
}

function findFeatureActivity(item: AnyDocument, action: string, name: string): AnyDocument | null {
  const activities = item?.system?.activities;
  if (activities?.find) {
    return activities.find((activity: AnyDocument) => activity.getFlag?.(MODULE_ID, "action") === action
      || activity.name === name) ?? null;
  }
  return Object.values(activities ?? {}).find((activity: any) => activity?.flags?.[MODULE_ID]?.action === action
    || activity?.name === name) ?? null;
}

async function repairFeatureActivity(
  item: AnyDocument,
  feature: "create-innovation" | "prototype-imbuements" | "analytical-muse",
  options: Record<string, unknown> = {}
): Promise<void> {
  const plan = planFeatureActivityRepair(feature, item.toObject()?.system?.activities, foundry.utils.randomID());
  await item.update(plan.updateData, options);
}

async function ensureWorldItems(rootFolder: AnyDocument): Promise<void> {
  const existingFeat = game.items.find((i: AnyDocument) => i.getFlag(MODULE_ID, "isCreateFeature"));
  const existingCodex = game.items.find((i: AnyDocument) => i.getFlag?.(MODULE_ID, "isCodex"));

  let create = true;
  if (!existingFeat || !existingCodex) create = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Innovations Codex Setup" },
    content: `<p>The Innovations Codex module needs to create its world items. Create them now?</p>`
  });
  if (!create) return;

  if (!existingFeat) {
    const activityId = foundry.utils.randomID();
    await Item.create({
      name: FEAT_NAME,
      type: "feat",
      img: "icons/skills/trades/smithing-anvil-silver-red.webp",
      folder: rootFolder.id,
      system: {
        description: {
          value: `<p>You channel your ingenuity to produce arcane innovations. Use this feature to open your <strong>Innovations Codex</strong> — a personal workshop where you design, categorize, and fabricate magical items.</p>
<p>When you use this feature, your codex is automatically added to your inventory if you don't already have one. From the codex window you can:</p>
<ul>
<li><strong>Create</strong> new innovation blueprints for your DM to review.</li>
<li><strong>Submit</strong> new patterns for GM approval and tier assignment.</li>
<li><strong>Fabricate</strong> innovations onto yourself or allies by expending a spell slot of the appropriate level.</li>
<li><strong>Recall</strong> fabricated innovations, removing them from their holder.</li>
</ul>
<p>Newly created innovations start as <em>Uncategorized</em> and cannot be fabricated until a spell level is assigned.</p>`
        },
        activities: { [activityId]: buildCreateActivity(activityId) }
      },
      flags: { [MODULE_ID]: { isCreateFeature: true, schemaVersion: SCHEMA_VERSION } }
    });
  } else {
    const activity = existingFeat.system.activities?.find?.((candidate: AnyDocument) =>
      candidate.getFlag?.(MODULE_ID, "action") === "open-codex" || candidate.name === "Open Codex"
    );
    const updates: Record<string, unknown> = {
      [`flags.${MODULE_ID}.isCreateFeature`]: true,
      [`flags.${MODULE_ID}.schemaVersion`]: SCHEMA_VERSION
    };
    if (!activity) {
      const activityId = foundry.utils.randomID();
      updates[`system.activities.${activityId}`] = buildCreateActivity(activityId);
    } else if (activity.getFlag?.(MODULE_ID, "action") !== "open-codex") {
      updates[`system.activities.${activity.id}.flags.${MODULE_ID}.action`] = "open-codex";
    }
    await existingFeat.update(updates);
  }

  if (!existingCodex) {
    await Item.create({
      name: CODEX_NAME,
      type: "container",
      img: "icons/sundries/books/book-symbol-yellow-grey.webp",
      folder: rootFolder.id,
      flags: { [MODULE_ID]: { isCodex: true, schemaVersion: SCHEMA_VERSION } }
    });
  } else {
    await existingCodex.update({
      [`flags.${MODULE_ID}.isCodex`]: true,
      [`flags.${MODULE_ID}.schemaVersion`]: SCHEMA_VERSION
    });
  }
}

/* ================================================== */
/*  SECTION 4: Helpers                                */
/* ================================================== */

function getSpellLevelFolder(level: SlotLevel | null): AnyDocument | null {
  const rootFolder = game.folders.find(
    (folder: AnyDocument) => folder.type === "Item" && folder.getFlag?.(MODULE_ID, "folderRole") === "root"
  ) ?? game.folders.find(
    (folder: AnyDocument) => folder.name === CODEX_NAME && folder.type === "Item" && !(folder.folder?.id ?? folder.folder)
  );
  if (!rootFolder) return null;
  const normalized = level ?? 0;
  const folderName = SPELL_LEVEL_FOLDERS[normalized];
  return game.folders.find(
    (folder: AnyDocument) => folder.type === "Item"
      && folder.getFlag?.(MODULE_ID, "folderRole") === `level:${normalized}`
      && (folder.folder?.id ?? folder.folder) === rootFolder.id
  ) ?? game.folders.find(
    (folder: AnyDocument) => folder.name === folderName
      && folder.type === "Item"
      && (folder.folder?.id ?? folder.folder) === rootFolder.id
  ) ?? null;
}

function isCodexItem(item: AnyDocument): boolean {
  return Boolean(item?.getFlag?.(MODULE_ID, "isCodex"));
}

function isCreateFeature(item: AnyDocument): boolean {
  return Boolean(item.getFlag?.(MODULE_ID, "isCreateFeature"));
}

function getSlotLevel(
  codex: AnyDocument,
  blueprint: AnyDocument,
  allowNameFallback = true
): SlotLevel | null {
  if (!codex || !blueprint) return null;
  return resolveSlotLevel({
    blueprintId: blueprint.id,
    blueprintUuid: blueprint.uuid,
    blueprintName: blueprint.name,
    itemLevel: blueprint.getFlag?.(MODULE_ID, "spellLevel"),
    slotLevelsByItemId: codex.getFlag(MODULE_ID, "slotLevelsByItemId"),
    slotLevelsByUuid: codex.getFlag(MODULE_ID, "slotLevelsByUuid"),
    slotLevelsByName: codex.getFlag(MODULE_ID, "slotLevelsByName"),
    allowNameFallback
  });
}

/**
 * Set the spell level for a blueprint. Updates codex flags, item flag,
 * mirrors to world folder, and notifies GM. All GM operations are routed
 * through socketlib.
 */
async function setSlotLevelForBlueprint(
  codex: AnyDocument,
  blueprint: AnyDocument,
  level: SlotLevel | null
): Promise<void> {
  if (!codex || !blueprint) return;
  await assignSlotLevel(codex.uuid, blueprint.uuid, level);
}

function buildSlotOptions(selectedLevel: SlotLevel | null) {
  const options = [{
    value: "0",
    label: "Uncategorized",
    selected: selectedLevel === null || selectedLevel === undefined
  }];
  for (let i = 1; i <= 9; i++) {
    options.push({ value: String(i), label: `${i}`, selected: i === selectedLevel });
  }
  return options;
}

function isAllowedTarget(user: AnyDocument, actor: AnyDocument): boolean {
  if (!actor || actor.documentName !== "Actor" || !actor.id || game.actors.get(actor.id) !== actor
    || actor.uuid !== `Actor.${actor.id}`) return false;
  const ownedLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const mode = getTargetMode();
  if (mode === "pcs" && actor.type === "character") return true;
  if (mode === "owned" && (user.isGM || actor.testUserPermission(user, ownedLevel))) return true;
  return getAllowedActorNames().includes(actor.name.toLowerCase())
    && (user.isGM || actor.testUserPermission(user, ownedLevel));
}

function getTargetActors(user: AnyDocument) {
  return game.actors.contents
    .filter((actor: AnyDocument) => isAllowedTarget(user, actor))
    .sort((a: AnyDocument, b: AnyDocument) => a.name.localeCompare(b.name))
    .map((actor: AnyDocument) => ({ name: actor.name, img: actor.img, uuid: actor.uuid }));
}

function getAllowedActorNames(): string[] {
  const raw = String(game.settings.get(MODULE_ID, "allowedActorNames") ?? "");
  if (!raw) return [];
  return raw.split(",").map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0);
}

function getTargetMode(): string {
  return String(game.settings.get(MODULE_ID, "targetMode") || "pcs");
}

function getIconSize(): number {
  const raw = String(game.settings.get(MODULE_ID, "iconSize") ?? "64");
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 64;
}

function getPortraitSize(): number {
  const raw = String(game.settings.get(MODULE_ID, "portraitSize") ?? "48");
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 48;
}

function getBlueprintItems(actor: AnyDocument, codex: AnyDocument) {
  const state = getWorldState();
  return actor.items
    .filter((item: AnyDocument) => isItemInCodex(item, codex))
    .map((item: AnyDocument) => {
      const approval = state.approvalsByBlueprintUuid[item.uuid];
      const approved = Boolean(approval
        && approval.codexUuid === codex.uuid
        && approval.ownerActorUuid === actor.uuid
        && snapshotsMatch(approval, item));
      const level = approved ? approval.slotLevel : null;
      return {
        name: item.name,
        img: item.img,
        uuid: item.uuid,
        slotLevel: level,
        approved,
        approvalLabel: approved ? `Level ${level}` : "Awaiting GM approval",
        canFabricate: approved,
        slotOptions: buildSlotOptions(level)
      };
    });
}

function isItemInCodex(item: AnyDocument, codex: AnyDocument): boolean {
  const container = item?.system?.container;
  const containerId = container?.id ?? container;
  return containerId === codex.id;
}

function getActiveTemporaryDocuments(codexUuid: string, state = getWorldState()): AnyDocument[] {
  const results: AnyDocument[] = [];
  for (const reservation of getCodexReservations(codexUuid, state)) {
    const item = fromUuidSync(reservation.temporaryItemUuid);
    if (!(item instanceof Item) || !(item.parent instanceof Actor)) continue;
    if (item.uuid !== reservation.temporaryItemUuid
      || item.parent.uuid !== reservation.targetActorUuid
      || item.getFlag?.(MODULE_ID, "reservationId") !== reservation.id
      || item.getFlag?.(MODULE_ID, "originUuid") !== reservation.codexUuid) continue;
    results.push(item);
  }
  return results;
}

function getActiveInnovations(codex: AnyDocument) {
  if (!codex) return [];
  const state = getWorldState();
  return getActiveTemporaryDocuments(codex.uuid, state).map((item: AnyDocument) => {
    const reservationId = item.getFlag(MODULE_ID, "reservationId");
    const reservation = state.reservationsById[reservationId];
    return {
      itemName: item.name,
      itemImg: item.img,
      itemUuid: item.uuid,
      reservationId,
      actorName: item.parent?.name ?? "Unknown Actor",
      actorImg: item.parent?.img ?? "icons/svg/mystery-man.svg",
      payment: reservation?.payment ?? "legacy",
      slotLevel: reservation?.slotLevel ?? null,
      canInspire: Boolean(reservation) && !Object.values(state.inspirationGrantsById)
        .some((grant) => grant.reservationId === reservationId)
    };
  });
}

/* ================================================== */
/*  SECTION 5: Player-facing logic                    */
/* ================================================== */

function openCodex(codexItem: AnyDocument): void {
  if (!isCodexItem(codexItem) || !(codexItem.parent instanceof Actor)) return;
  const state = getWorldState();
  if (state.codexByActorUuid[codexItem.parent.uuid] !== codexItem.uuid) {
    ui.notifications?.warn("That is not this actor's active Innovations Codex.");
    return;
  }
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  if (!game.user.isGM && !codexItem.parent.testUserPermission(game.user, ownerLevel)) {
    ui.notifications?.warn("You do not own that Innovations Codex.");
    return;
  }
  const now = Date.now();
  const lastOpen = RECENT_OPEN.get(codexItem.uuid) ?? 0;
  if (now - lastOpen < 250) return;
  RECENT_OPEN.set(codexItem.uuid, now);
  void new InnovationsCodexApp(codexItem).render({ force: true });
}

async function openCodexByUuid(itemUuid: string): Promise<void> {
  const item = await fromUuid(itemUuid);
  openCodex(item);
}

/**
 * Entry point when "Create Innovation" feat is used.
 * Routes codex creation through socketlib so any player can use it.
 */
async function resolveUuidWithRetry(uuid: string, attempts = 5): Promise<AnyDocument | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const document = await fromUuid(uuid);
    if (document) return document;
    await new Promise((resolve) => window.setTimeout(resolve, 100 * (attempt + 1)));
  }
  return null;
}

async function useCreateFeature(feat: AnyDocument): Promise<void> {
  assertReady();
  if (!isCreateFeature(feat)) throw new Error("That item is not the Innovations Codex entry feature.");
  const actor = feat?.parent;
  if (!(actor instanceof Actor) || game.actors.get(actor.id) !== actor) {
    ui.notifications.warn("The Create Innovation feature must be on an actor's sheet.");
    return;
  }

  if (!isCollegeOfInnovationActor(actor)) throw new Error(`${actor.name} does not have the College of Innovation subclass.`);

  const state = getWorldState();
  const canonicalUuid = state.codexByActorUuid[actor.uuid];
  let codex = canonicalUuid ? await fromUuid(canonicalUuid) : null;

  if (!(codex instanceof Item) || codex.parent !== actor || !isCodexItem(codex)) {
    // Ask GM to add the codex via socketlib
    const codexUuid = await addCodexToActor(actor.uuid);
    if (!codexUuid) {
      ui.notifications.error("Failed to add Innovations Codex to your character.");
      return;
    }
    codex = await resolveUuidWithRetry(codexUuid);
    if (!codex) {
      ui.notifications.error("Failed to find the newly created codex.");
      return;
    }
    ui.notifications.info(`Added ${CODEX_NAME} to ${actor.name}'s inventory.`);
  }

  openCodex(codex);
}

/**
 * Show dialog and create a new innovation via socketlib.
 */
async function createNewInnovation(codex: AnyDocument, actor: AnyDocument): Promise<AnyDocument | null> {
  const itemTypes = {
    weapon: "Weapon",
    equipment: "Equipment",
    consumable: "Consumable",
    tool: "Tool",
    loot: "Loot",
    container: "Container"
  };

  const typeOptions = Object.entries(itemTypes)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");

  const content = `
    <div class="form-group">
      <label for="ic-item-name">Innovation Name</label>
      <input id="ic-item-name" type="text" name="itemName" maxlength="100" placeholder="Name your innovation..." autofocus>
    </div>
    <div class="form-group">
      <label for="ic-item-type">Item Type</label>
      <select id="ic-item-type" name="itemType">${typeOptions}</select>
    </div>`;

  const result = await foundry.applications.api.DialogV2.input({
    window: { title: "New Innovation" },
    content,
    ok: { label: "Create" },
    rejectClose: false
  });

  const itemName = String(result?.itemName ?? "").trim();
  const itemType = String(result?.itemType ?? "");
  if (!result) return null;
  if (!itemName) {
    ui.notifications?.warn("Innovation name is required.");
    return null;
  }

  const createdUuid = await createInnovationOnActor(actor.uuid, codex.id, itemName, itemType);
  if (!createdUuid) {
    ui.notifications.error("Failed to create innovation.");
    return null;
  }

  const created = await resolveUuidWithRetry(createdUuid);
  if (!created) {
    ui.notifications.error("Failed to find the newly created innovation.");
    return null;
  }

  void created.sheet?.render({ force: true });
  return created;
}

/* ================================================== */
/*  SECTION 6: ApplicationV2 Window                   */
/* ================================================== */

const HandlebarsApplication = foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
);

class InnovationsCodexApp extends HandlebarsApplication {
  static DEFAULT_OPTIONS = {
    tag: "section",
    classes: ["innovations-codex"],
    window: { title: "Innovations Codex", resizable: true },
    position: { width: 760 },
    actions: {
      "change-tab": this.#onChangeTab,
      fabricate: this.#onFabricate,
      recall: this.#onRecall,
      inspire: this.#onInspire,
      "add-innovation": this.#onAddInnovation,
      "craft-calculator": this.#onCraftCalculator
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/innovations-codex.hbs` }
  };

  codex: AnyDocument;
  activeTab: "blueprints" | "active";

  constructor(codex: AnyDocument, options: Record<string, unknown> = {}) {
    super(options);
    this.codex = codex;
    this.activeTab = options.tab === "active" ? "active" : "blueprints";
  }

  get title(): string {
    return this.codex?.name ?? CODEX_NAME;
  }

  async _prepareContext(): Promise<Record<string, unknown>> {
    const parentActor = this.codex?.parent instanceof Actor ? this.codex.parent : null;
    const blueprints = parentActor ? getBlueprintItems(parentActor, this.codex) : [];
    const targets = getTargetActors(game.user);
    const activeInnovations = getActiveInnovations(this.codex);
    const activeLimit = Number(foundry.utils.getProperty(parentActor, "system.attributes.prof") ?? 0);
    const prototype = getPrototypeFeature(parentActor);
    const freeUsesSpent = Number(foundry.utils.getProperty(prototype, "system.uses.spent") ?? 1);

    return {
      codexName: this.codex?.name ?? CODEX_NAME,
      codexUuid: this.codex?.uuid,
      hasParent: Boolean(parentActor),
      hasBlueprints: blueprints.length > 0,
      blueprints,
      hasTargets: targets.length > 0,
      targets,
      defaultTarget: targets[0] ?? null,
      hasActive: activeInnovations.length > 0,
      activeInnovations,
      activeCount: activeInnovations.length,
      activeLimit,
      freeAvailable: Boolean(prototype) && freeUsesSpent < 1,
      isGM: Boolean(game.user?.isGM),
      iconSize: getIconSize(),
      portraitSize: getPortraitSize(),
      isBlueprintsTab: this.activeTab === "blueprints",
      isActiveTab: this.activeTab === "active"
    };
  }

  _onRender(context: unknown, options: unknown): void {
    super._onRender(context, options);
    const root = this.element as HTMLElement;
    root.querySelectorAll<HTMLSelectElement>("[data-target-select]").forEach((select: HTMLSelectElement) => {
      select.addEventListener("change", () => {
        const row = select.closest("[data-blueprint-uuid]");
        const portrait = row?.querySelector<HTMLImageElement>(".ic-target-portrait");
        const option = select.selectedOptions[0];
        if (portrait && option?.dataset.portrait) portrait.src = option.dataset.portrait;
      });
    });
    root.querySelectorAll<HTMLSelectElement>("[data-slot-level]").forEach((select: HTMLSelectElement) => {
      select.addEventListener("change", () => {
        void this.#changeSlotLevel(select).catch((error) => reportError(error, "Could not assign that spell level."));
      });
    });
  }

  async #changeSlotLevel(select: HTMLSelectElement): Promise<void> {
    if (!game.user?.isGM) throw new Error("Only a GM may approve innovation levels.");
    select.disabled = true;
    try {
      const row = select.closest<HTMLElement>("[data-blueprint-uuid]");
      const blueprintUuid = row?.dataset.blueprintUuid;
      if (!blueprintUuid) return;
      const raw = select.value;
      const level = raw === "0" ? null : parseSlotLevel(raw);
      if (raw !== "0" && level === null) throw new Error("Spell level must be between 1 and 9.");
      const blueprint = await fromUuid(blueprintUuid);
      if (!blueprint) throw new Error("Blueprint not found.");
      await setSlotLevelForBlueprint(this.codex, blueprint, level);
      await this.render();
    } finally {
      select.disabled = false;
    }
  }

  static #onChangeTab(this: InnovationsCodexApp, event: PointerEvent, target: HTMLElement): void {
    event.preventDefault();
    const tab = target.dataset.tab;
    if ((tab === "blueprints" || tab === "active") && tab !== this.activeTab) {
      this.activeTab = tab;
      void this.render();
    }
  }

  static async #onFabricate(this: InnovationsCodexApp, _event: PointerEvent, target: HTMLButtonElement): Promise<void> {
    const row = target.closest<HTMLElement>("[data-blueprint-uuid]");
    const blueprintUuid = target.dataset.itemUuid ?? row?.dataset.blueprintUuid;
    const targetUuid = row?.querySelector<HTMLSelectElement>("[data-target-select]")?.value;
    if (!blueprintUuid || !targetUuid) {
      ui.notifications?.warn("Select a target actor first.");
      return;
    }
    target.disabled = true;
    try {
      await this.#fabricate(blueprintUuid, targetUuid);
    } catch (error) {
      reportError(error, "Fabrication failed.");
    } finally {
      target.disabled = false;
    }
  }

  static async #onRecall(this: InnovationsCodexApp, _event: PointerEvent, target: HTMLButtonElement): Promise<void> {
    const itemUuid = target.dataset.itemUuid;
    if (!itemUuid) return;
    target.disabled = true;
    try {
      await requestRecall(itemUuid, this.codex.uuid);
      await this.render();
    } catch (error) {
      reportError(error, "Recall failed.");
    } finally {
      target.disabled = false;
    }
  }

  static async #onInspire(this: InnovationsCodexApp, _event: PointerEvent, target: HTMLButtonElement): Promise<void> {
    const reservationId = target.dataset.reservationId;
    if (!reservationId) return;
    target.disabled = true;
    try {
      const result = await grantInnovationInspiration(reservationId);
      if (result.success) ui.notifications?.info("Bardic Inspiration is now bound to that imbuement.");
      else ui.notifications?.warn(result.message ?? "Bardic Inspiration could not be granted.");
      await this.render();
    } catch (error) {
      reportError(error, "Could not grant Bardic Inspiration.");
    } finally {
      target.disabled = false;
    }
  }

  static async #onAddInnovation(this: InnovationsCodexApp, _event: PointerEvent, target: HTMLButtonElement): Promise<void> {
    const actor = this.codex?.parent instanceof Actor ? this.codex.parent : null;
    if (!actor) {
      ui.notifications?.warn("The Codex must be owned by an actor.");
      return;
    }
    target.disabled = true;
    try {
      const created = await createNewInnovation(this.codex, actor);
      if (created) await this.render();
    } catch (error) {
      reportError(error, "Could not create the innovation.");
    } finally {
      target.disabled = false;
    }
  }

  static async #onCraftCalculator(this: InnovationsCodexApp): Promise<void> {
    const actor = this.codex?.parent instanceof Actor ? this.codex.parent : null;
    if (!actor) return;
    const result = await foundry.applications.api.DialogV2.input({
      window: { title: "Harmonic Fabrication" },
      content: `<p>Enter the base Craft activity values. This calculator reports the College reduction; it does not alter another crafting module.</p>`
        + `<label for="ic-craft-cost">Base cost (gp)</label><input id="ic-craft-cost" name="cost" type="number" min="0" step="0.01" required>`
        + `<label for="ic-craft-time">Base time (days)</label><input id="ic-craft-time" name="time" type="number" min="0" step="0.01" required>`
        + `<label for="ic-craft-benefit">Reduction</label><select id="ic-craft-benefit" name="benefit">`
        + `<option value="time">Half crafting time</option><option value="cost">Half crafting cost</option>`
        + `<option value="both">Half both (known pattern only)</option></select>`,
      ok: { label: "Calculate" },
      rejectClose: false
    });
    if (!result) return;
    const baseCost = Number(result.cost);
    const baseTime = Number(result.time);
    if (!Number.isFinite(baseCost) || baseCost < 0 || !Number.isFinite(baseTime) || baseTime < 0) {
      throw new Error("Enter non-negative numeric crafting values.");
    }
    const benefit = ["time", "cost", "both"].includes(String(result.benefit)) ? String(result.benefit) : "time";
    const finalCost = benefit === "cost" || benefit === "both" ? baseCost / 2 : baseCost;
    const finalTime = benefit === "time" || benefit === "both" ? baseTime / 2 : baseTime;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<h3>Harmonic Fabrication</h3><p><strong>${escapeHtml(actor.name)}</strong>: `
        + `${finalCost.toLocaleString()} gp and ${finalTime.toLocaleString()} days `
        + `(from ${baseCost.toLocaleString()} gp and ${baseTime.toLocaleString()} days).</p>`
    });
  }

  async #fabricate(blueprintUuid: string, targetUuid: string): Promise<void> {
    const blueprint = await fromUuid(blueprintUuid);
    const targetActor = await fromUuid(targetUuid);
    const ownerActor = this.codex.parent instanceof Actor ? this.codex.parent : null;
    if (!(blueprint instanceof Item)) throw new Error("Blueprint not found.");
    if (!(targetActor instanceof Actor)) throw new Error("Target actor not found.");
    if (!ownerActor) throw new Error("The Codex must be owned by an actor.");

    const approval = getWorldState().approvalsByBlueprintUuid[blueprint.uuid];
    const slotLevel = approval?.codexUuid === this.codex.uuid && snapshotsMatch(approval, blueprint)
      ? approval.slotLevel : null;
    if (!slotLevel) {
      ui.notifications?.warn("This blueprint is awaiting GM approval.");
      return;
    }
    const prototype = getPrototypeFeature(ownerActor);
    const freeAvailable = prototype
      && Number(foundry.utils.getProperty(prototype, "system.uses.spent") ?? 1) < 1;
    const state = getWorldState();
    const occupiedHosts = new Set(Object.values(state.reservationsById)
      .map((reservation) => reservation.hostItemUuid).filter(Boolean));
    const hostOptions = targetActor.items.contents
      .filter((item: AnyDocument) => !item.getFlag?.(MODULE_ID, "isTemporary")
        && !isCodexItem(item)
        && !occupiedHosts.has(item.uuid))
      .sort((left: AnyDocument, right: AnyDocument) => left.name.localeCompare(right.name))
      .map((item: AnyDocument) => `<option value="${escapeHtml(item.uuid)}">${escapeHtml(item.name)}</option>`)
      .join("");
    const choice = await foundry.applications.api.DialogV2.input({
      window: { title: "Create Imbuement" },
      content: `<p>Fabricate <strong>${escapeHtml(blueprint.name)}</strong> for `
        + `<strong>${escapeHtml(targetActor.name)}</strong>.</p>`
        + `<label for="ic-payment">Resource</label>`
        + `<select id="ic-payment" name="payment">`
        + `<option value="slot">Level ${slotLevel} spell slot</option>`
        + (freeAvailable ? `<option value="free">Free imbuement (1/long rest)</option>` : "")
        + `</select>`
        + `<label for="ic-host-item">Host item</label>`
        + `<select id="ic-host-item" name="hostItemUuid">`
        + `<option value="">Create as a standalone item</option>${hostOptions}</select>`,
      ok: { label: "Fabricate" },
      rejectClose: false
    });
    if (!choice) return;
    const payment: ImbuementPayment = choice.payment === "free" ? "free" : "slot";
    const hostItemUuid = String(choice.hostItemUuid ?? "") || null;

    const result = await fabricate(
      ownerActor.uuid,
      targetActor.uuid,
      blueprint.uuid,
      this.codex.uuid,
      payment,
      hostItemUuid
    );
    if (result.success) {
      ui.notifications?.info(`Fabricated Temporary ${blueprint.name} for ${targetActor.name}.`);
    } else {
      ui.notifications?.warn(result.message ?? "Fabrication was rejected.");
    }
    await this.render();
  }
}

function isActiveGM(): boolean {
  return Boolean(game.user?.isGM && game.users?.activeGM?.id === game.user.id);
}

function isCollegeOfInnovationActor(actor: AnyDocument): boolean {
  return actor?.items?.some((item: AnyDocument) => item.type === "subclass"
    && (item.getFlag?.(MODULE_ID, "subclass") === true
      || item.system?.identifier === "bard-innovation"
      || item.system?.identifier === "bard_innovation"
      || item.name === "College of Innovation"));
}

function findCodexForBlueprint(blueprint: AnyDocument): AnyDocument | null {
  const actor = blueprint?.parent;
  if (!(actor instanceof Actor)) return null;
  return actor.items.find((item: AnyDocument) => isCodexItem(item) && isItemInCodex(blueprint, item)) ?? null;
}

function liveAdvancementStorage(item: AnyDocument, advancements: readonly any[]): unknown {
  const current = item.toObject()?.system?.advancement;
  if (Array.isArray(current)) return advancements;
  return Object.fromEntries(advancements.map((advancement: any) => [advancement._id, advancement]));
}

function advancementSourceList(item: AnyDocument): any[] {
  if (item.system?.advancement?.map) {
    return item.system.advancement.map((advancement: AnyDocument) =>
      foundry.utils.deepClone(advancement.toObject?.() ?? advancement));
  }
  const storage = item.toObject()?.system?.advancement;
  return foundry.utils.deepClone(Array.isArray(storage) ? storage : Object.values(storage ?? {}));
}

async function repairLegacySubclassAdvancements(
  subclass: AnyDocument,
  createSourceUuid: string | null,
  embeddedCreateFeature: AnyDocument | null = null
): Promise<void> {
  const advancements = advancementSourceList(subclass)
    .filter((advancement) => !/^Innovation Spells\b/i.test(String(advancement.title ?? "")));
  const featureGrant = advancements.find((advancement) => advancement._id === "hLmdKKJ7PgWGLcqz"
    || advancement.configuration?.items?.some((entry: AnyDocument) =>
      ["VC2DVEhoZ9DPjUCZ", "uVLuEPXjnIXzAi7T", "2jUWfdVcdialQBay"]
        .some((id) => String(entry.uuid ?? "").endsWith(id))));
  if (featureGrant) {
    featureGrant.level = 3;
    featureGrant.configuration ??= {};
    featureGrant.configuration.items ??= [];
    if (createSourceUuid && !featureGrant.configuration.items
      .some((entry: AnyDocument) => entry.uuid === createSourceUuid)) {
      featureGrant.configuration.items.push({ uuid: createSourceUuid, optional: false });
    }
    if (embeddedCreateFeature && createSourceUuid) {
      featureGrant.value ??= {};
      featureGrant.value.added ??= {};
      featureGrant.value.added[embeddedCreateFeature.id] = createSourceUuid;
    }
  }
  await subclass.update({
    "system.advancement": liveAdvancementStorage(subclass, advancements),
    [`flags.${MODULE_ID}.subclass`]: true,
    [`flags.${MODULE_ID}.schemaVersion`]: SCHEMA_VERSION
  }, { innovationsCodexMigration: true });
}

async function repairFeatureAdvancements(item: AnyDocument, feature: AdvancementFeature): Promise<void> {
  const migration = buildFeatureAdvancementMigration(feature, item.toObject()?.system?.advancement);
  const updates: Record<string, unknown> = {
    "system.advancement": liveAdvancementStorage(item, migration.advancements),
    [`flags.${MODULE_ID}.feature`]: feature,
    [`flags.${MODULE_ID}.unresolvedChoices`]: migration.unresolvedChoices
  };
  const advancementRoot = item.getFlag?.("dnd5e", "advancementRoot")
    ?? item.getFlag?.("dnd5e", "advancementOrigin");
  if (advancementRoot) updates["flags.dnd5e.advancementRoot"] = advancementRoot;
  await item.update(updates, { innovationsCodexMigration: true });
  if (migration.unresolvedChoices.length) {
    console.info(`${MODULE_ID} | Preserved unresolved ${feature} choices on ${item.uuid}`, migration.unresolvedChoices);
  }
}

function collectAdvancementGrantedItemIds(feature: AnyDocument): Set<string> {
  const actor = feature?.parent;
  const ids = new Set<string>();
  if (!(actor instanceof Actor)) return ids;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (actor.items.has(value)) ids.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (actor.items.has(key)) ids.add(key);
      visit(entry);
    }
  };
  const storage = feature.toObject()?.system?.advancement;
  for (const advancement of Array.isArray(storage) ? storage : Object.values(storage ?? {})) {
    visit((advancement as any)?.value);
  }
  return ids;
}

async function repairFeatureGrantedSpellSources(actor: AnyDocument): Promise<void> {
  const features = actor.items.filter((item: AnyDocument) =>
    ["innovation-spells", "magical-discoveries"].includes(String(item.getFlag?.(MODULE_ID, "feature") ?? "")));
  const grantedIds = new Set<string>();
  for (const feature of features) {
    for (const itemId of collectAdvancementGrantedItemIds(feature)) grantedIds.add(itemId);
  }
  const updates = [...grantedIds].flatMap((itemId) => {
    const spell = actor.items.get(itemId);
    if (!spell || spell.type !== "spell") return [];
    return [{
      _id: spell.id,
      "system.method": "spell",
      "system.prepared": 2,
      "system.sourceClass": "bard",
      "system.sourceItem": "class:bard"
    }];
  });
  if (updates.length) {
    await actor.updateEmbeddedDocuments("Item", updates, { innovationsCodexMigration: true });
  }
}

async function ensureInnovationSpells(actor: AnyDocument, feature: AnyDocument): Promise<void> {
  const applicable = applicableInnovationSpellGrants(getBardLevel(actor)).flatMap((grant) => grant.spells);
  const updates: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  for (const spellGrant of applicable) {
    const existing = actor.items.find((item: AnyDocument) => item.type === "spell"
      && (item.getFlag?.(MODULE_ID, "innovationSpellSource") === spellGrant.uuid
        || identifyInnovationSpellGrant(item.toObject())?.spell.uuid === spellGrant.uuid))
      ?? actor.items.find((item: AnyDocument) => item.type === "spell"
        && item.name === spellGrant.name
        && (item.system?.sourceItem === "class:bard" || Number(item.system?.prepared ?? 0) === 2));
    const sourceFields = {
      "system.method": "spell",
      "system.prepared": 2,
      "system.sourceClass": "bard",
      "system.sourceItem": "class:bard",
      [`flags.${MODULE_ID}.innovationSpellSource`]: spellGrant.uuid,
      [`flags.${MODULE_ID}.originFeatureUuid`]: feature.uuid,
      "flags.dnd5e.advancementOrigin": `${feature.id}.${identifyInnovationSpellGrant({ uuid: spellGrant.uuid })?.grant.advancementId}`
    };
    if (existing) {
      updates.push({ _id: existing.id, ...sourceFields });
      continue;
    }
    const source = await fromUuid(spellGrant.uuid);
    if (!(source instanceof Item) || source.type !== "spell") {
      console.warn(`${MODULE_ID} | Innovation Spell source is unavailable: ${spellGrant.name} (${spellGrant.uuid})`);
      continue;
    }
    const data: any = source.toObject();
    delete data._id;
    delete data.folder;
    delete data.ownership;
    foundry.utils.setProperty(data, "system.method", "spell");
    foundry.utils.setProperty(data, "system.prepared", 2);
    foundry.utils.setProperty(data, "system.sourceClass", "bard");
    foundry.utils.setProperty(data, "system.sourceItem", "class:bard");
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.innovationSpellSource`, spellGrant.uuid);
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.originFeatureUuid`, feature.uuid);
    const grant = identifyInnovationSpellGrant({ uuid: spellGrant.uuid })?.grant;
    if (grant) foundry.utils.setProperty(data, "flags.dnd5e.advancementOrigin", `${feature.id}.${grant.advancementId}`);
    creates.push(data);
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { innovationsCodexMigration: true });
  if (creates.length) await actor.createEmbeddedDocuments("Item", creates, { innovationsCodexMigration: true });

  const advancements = advancementSourceList(feature);
  let advancementChanged = false;
  for (const grant of applicableInnovationSpellGrants(getBardLevel(actor))) {
    const advancement = advancements.find((candidate) => candidate._id === grant.advancementId);
    if (!advancement) continue;
    const added: Record<string, string> = {};
    for (const spellGrant of grant.spells) {
      const spell = actor.items.find((item: AnyDocument) => item.type === "spell"
        && item.getFlag?.(MODULE_ID, "innovationSpellSource") === spellGrant.uuid);
      if (spell) added[spell.id] = spellGrant.uuid;
    }
    advancement.value = {
      ...(advancement.value && typeof advancement.value === "object" ? advancement.value : {}),
      added
    };
    advancementChanged = true;
  }
  if (advancementChanged) {
    await feature.update({
      "system.advancement": liveAdvancementStorage(feature, advancements)
    }, { innovationsCodexMigration: true });
  }
}

async function repairLegacyGogglesBlueprint(actor: AnyDocument, codex: AnyDocument): Promise<void> {
  const goggles = actor.items.filter((item: AnyDocument) =>
    isItemInCodex(item, codex) && item.name === "Goggles of Night");
  if (goggles.length < 2) return;
  const legacyUuidMap = codex.getFlag(MODULE_ID, "slotLevelsByUuid");
  const canonical = goggles.find((item: AnyDocument) =>
    parseSlotLevel(foundry.utils.getProperty(legacyUuidMap, item.uuid)) !== null);
  const donor = goggles.find((item: AnyDocument) => item !== canonical
    && item.effects?.some?.((effect: AnyDocument) =>
      JSON.stringify(effect.toObject?.() ?? effect).toLowerCase().includes("darkvision")));
  if (!canonical || canonical.effects?.size || !donor) return;
  const effectData = donor.effects.map((effect: AnyDocument) => {
    const data = foundry.utils.deepClone(effect.toObject());
    delete data._id;
    return data;
  });
  if (effectData.length) {
    await canonical.createEmbeddedDocuments("ActiveEffect", effectData, { innovationsCodexMigration: true });
    console.info(`${MODULE_ID} | Restored the legacy Goggles of Night darkvision effect`, canonical.uuid);
  }
}

async function migrateCodex(
  codex: AnyDocument,
  state: WorldState,
  importLegacyTrust = false
): Promise<void> {
  if (!(codex.parent instanceof Actor)) return;
  const actor = codex.parent;
  if (importLegacyTrust) await repairLegacyGogglesBlueprint(actor, codex);
  const blueprints = actor.items.filter((item: AnyDocument) => isItemInCodex(item, codex));
  const byItemId: Record<string, SlotLevel> = {};
  const byName: Record<string, SlotLevel> = {};
  const blueprintUpdates: Record<string, unknown>[] = [];
  for (const blueprint of blueprints) {
    let approval: BlueprintApproval | undefined = state.approvalsByBlueprintUuid[blueprint.uuid];
    const approvalIsTrusted = approval
      && approval.blueprintUuid === blueprint.uuid
      && approval.codexUuid === codex.uuid
      && approval.ownerActorUuid === actor.uuid
      && parseSlotLevel(approval.slotLevel) !== null
      && snapshotsMatch(approval, blueprint);
    if (approval && !approvalIsTrusted) {
      delete state.approvalsByBlueprintUuid[blueprint.uuid];
      approval = undefined;
    }
    if (!approval && importLegacyTrust) {
      const legacyLevel = getSlotLevel(codex, blueprint, false);
      if (legacyLevel !== null && legacyLevel <= maximumPatternTier(actor.system?.spells ?? {})) {
        approval = {
          blueprintUuid: blueprint.uuid,
          codexUuid: codex.uuid,
          ownerActorUuid: actor.uuid,
          slotLevel: legacyLevel,
          approvedBy: "migration",
          approvedAt: Date.now(),
          snapshot: blueprintSnapshot(blueprint)
        };
        state.approvalsByBlueprintUuid[blueprint.uuid] = approval;
      }
    }
    const level = approval?.slotLevel ?? null;
    if (level !== null) {
      byItemId[blueprint.id] = level;
      byName[blueprint.name] = level;
    }
    blueprintUpdates.push({
      _id: blueprint.id,
      [`flags.${MODULE_ID}.isInnovation`]: true,
      [`flags.${MODULE_ID}.spellLevel`]: level,
      [`flags.${MODULE_ID}.approved`]: Boolean(approval)
    });
  }
  if (blueprintUpdates.length) {
    await actor.updateEmbeddedDocuments("Item", blueprintUpdates, { innovationsCodexMigration: true });
  }

  const temporaryUpdates = new Map<string, Record<string, unknown>[]>();
  const legacyTemporaries = importLegacyTrust
    ? game.actors.contents.flatMap((target: AnyDocument) => target.items.contents)
      .filter((temporary: AnyDocument) => temporary.getFlag?.(MODULE_ID, "isTemporary")
        && temporary.getFlag?.(MODULE_ID, "originUuid") === codex.uuid)
    : [];
  for (const temporary of legacyTemporaries) {
    let reservationId = String(temporary.getFlag(MODULE_ID, "reservationId") ?? "");
    if (reservationId && state.reservationsById[reservationId]) continue;
    const level = parseSlotLevel(temporary.getFlag(MODULE_ID, "spellLevel"));
    if (!level) continue;
    reservationId ||= foundry.utils.randomID();
    const bareName = temporary.name.replace(/^Temporary\s+/i, "");
    const flaggedBlueprintUuid = temporary.getFlag(MODULE_ID, "blueprintUuid");
    const blueprint = blueprints.find((candidate: AnyDocument) => candidate.uuid === flaggedBlueprintUuid)
      ?? blueprints.find((candidate: AnyDocument) => candidate.name === bareName && getSlotLevel(codex, candidate) === level)
      ?? blueprints.find((candidate: AnyDocument) => candidate.name === bareName);
    if (!blueprint) {
      console.warn(`${MODULE_ID} | Preserved unlinked legacy temporary item for GM review`, temporary.uuid);
      continue;
    }
    state.reservationsById[reservationId] = {
      id: reservationId,
      codexUuid: codex.uuid,
      ownerActorUuid: actor.uuid,
      temporaryItemUuid: temporary.uuid,
      blueprintUuid: blueprint.uuid,
      targetActorUuid: temporary.parent?.uuid ?? "",
      hostItemUuid: temporary.getFlag(MODULE_ID, "hostItemUuid") ?? null,
      slotLevel: level,
      payment: temporary.getFlag(MODULE_ID, "payment") === "free" ? "free" : "slot",
      createdAt: Number(temporary.getFlag(MODULE_ID, "createdAt") ?? Date.now())
    };
    const updates = temporaryUpdates.get(temporary.parent.uuid) ?? [];
    updates.push({
      _id: temporary.id,
      [`flags.${MODULE_ID}.reservationId`]: reservationId,
      [`flags.${MODULE_ID}.ownerActorUuid`]: actor.uuid,
      [`flags.${MODULE_ID}.blueprintUuid`]: blueprint.uuid,
      [`flags.${MODULE_ID}.payment`]: state.reservationsById[reservationId].payment,
      [`flags.${MODULE_ID}.spellLevel`]: level
    });
    temporaryUpdates.set(temporary.parent.uuid, updates);
  }
  for (const [actorUuid, updates] of temporaryUpdates) {
    const targetActor = await fromUuid(actorUuid);
    if (targetActor instanceof Actor) {
      await targetActor.updateEmbeddedDocuments("Item", updates, { innovationsCodexMigration: true });
    }
  }

  await codex.update({
    [`flags.${MODULE_ID}.schemaVersion`]: SCHEMA_VERSION,
    [`flags.${MODULE_ID}.slotLevelsByItemId`]: byItemId,
    [`flags.${MODULE_ID}.slotLevelsByName`]: byName,
    [`flags.${MODULE_ID}.canonical`]: true
  }, { innovationsCodexMigration: true });

  for (const blueprint of blueprints) {
    await syncMirrorFromBlueprint(blueprint, byItemId[blueprint.id] ?? null);
  }
}

async function migrateSubclassActor(
  actor: AnyDocument,
  state = getWorldState(),
  importLegacyTrust = false
): Promise<void> {
  if (!isCollegeOfInnovationActor(actor)) return;
  const worldFeature = game.items.find((item: AnyDocument) => isCreateFeature(item));
  let createFeature = actor.items.find((item: AnyDocument) => isCreateFeature(item));
  if (!createFeature && worldFeature) {
    const data = worldFeature.toObject();
    delete data._id;
    delete data.folder;
    delete data.ownership;
    [createFeature] = await actor.createEmbeddedDocuments("Item", [data], { innovationsCodexMigration: true });
  }
  if (createFeature) {
    await createFeature.update({
      [`flags.${MODULE_ID}.isCreateFeature`]: true,
      [`flags.${MODULE_ID}.schemaVersion`]: SCHEMA_VERSION
    }, { innovationsCodexMigration: true });
    await repairFeatureActivity(
      createFeature,
      "create-innovation",
      { innovationsCodexMigration: true }
    );
  }

  const prototype = getPrototypeFeature(actor);
  if (prototype) {
    await prototype.update({
      [`flags.${MODULE_ID}.feature`]: "prototype-imbuements",
      "system.uses.max": "1",
      "system.uses.recovery": [{ period: "lr", type: "recoverAll" }]
    }, { innovationsCodexMigration: true });
    await repairFeatureActivity(
      prototype,
      "prototype-imbuements",
      { innovationsCodexMigration: true }
    );
  }
  const analytical = actor.items.find((item: AnyDocument) => item.name === "Analytical Muse"
    || item.getFlag?.(MODULE_ID, "feature") === "analytical-muse");
  if (analytical) {
    await analytical.update({
      [`flags.${MODULE_ID}.feature`]: "analytical-muse",
      "system.uses.max": "@abilities.int.mod",
      "system.uses.recovery": [{ period: "lr", type: "recoverAll" }]
    }, { innovationsCodexMigration: true });
    await repairFeatureActivity(
      analytical,
      "analytical-muse",
      { innovationsCodexMigration: true }
    );
    await repairFeatureAdvancements(analytical, "analytical-muse");
  }

  const innovationSpells = actor.items.find((item: AnyDocument) => item.name === "Innovation Spells"
    || item.getFlag?.(MODULE_ID, "feature") === "innovation-spells");
  if (innovationSpells) {
    await repairFeatureAdvancements(innovationSpells, "innovation-spells");
    await ensureInnovationSpells(actor, innovationSpells);
  }

  const magicalDiscoveries = actor.items.find((item: AnyDocument) => item.name === "Magical Discoveries"
    || item.getFlag?.(MODULE_ID, "feature") === "magical-discoveries");
  if (magicalDiscoveries) {
    await repairFeatureAdvancements(magicalDiscoveries, "magical-discoveries");
  }
  await repairFeatureGrantedSpellSources(actor);

  const subclass = actor.items.find((item: AnyDocument) => item.type === "subclass"
    && (item.getFlag?.(MODULE_ID, "subclass") === true
      || item.system?.identifier === "bard-innovation"
      || item.system?.identifier === "bard_innovation"
      || item.name === "College of Innovation"));
  if (subclass) {
    await repairLegacySubclassAdvancements(subclass, worldFeature?.uuid ?? null, createFeature ?? null);
  }

  const codices = actor.items.filter((item: AnyDocument) => isCodexItem(item));
  if (codices.length) {
    const recorded = state.codexByActorUuid[actor.uuid];
    const canonical = codices.find((codex: AnyDocument) => codex.uuid === recorded) ?? codices[0];
    state.codexByActorUuid[actor.uuid] = canonical.uuid;
    await migrateCodex(canonical, state, importLegacyTrust);
    const duplicateUpdates = codices.filter((codex: AnyDocument) => codex !== canonical)
      .map((codex: AnyDocument) => ({ _id: codex.id, [`flags.${MODULE_ID}.canonical`]: false }));
    if (duplicateUpdates.length) {
      await actor.updateEmbeddedDocuments("Item", duplicateUpdates, { innovationsCodexMigration: true });
      console.warn(`${MODULE_ID} | Preserved duplicate codices as non-canonical for GM review`, actor.uuid);
    }
  }
}

async function migrateWorldCollegeContent(): Promise<void> {
  const createFeature = game.items.find((item: AnyDocument) => isCreateFeature(item));
  const analytical = game.items.find((item: AnyDocument) => item.name === "Analytical Muse");
  const prototype = game.items.find((item: AnyDocument) => item.name === PROTOTYPE_NAME);
  const innovationSpells = game.items.find((item: AnyDocument) => item.name === "Innovation Spells");
  const magicalDiscoveries = game.items.find((item: AnyDocument) => item.name === "Magical Discoveries");
  const subclass = game.items.find((item: AnyDocument) => item.type === "subclass"
    && item.name === "College of Innovation");
  if (analytical) {
    await analytical.update({
      [`flags.${MODULE_ID}.feature`]: "analytical-muse",
      "system.uses.max": "@abilities.int.mod",
      "system.uses.recovery": [{ period: "lr", type: "recoverAll" }]
    }, { innovationsCodexMigration: true });
    await repairFeatureActivity(analytical, "analytical-muse", { innovationsCodexMigration: true });
    await repairFeatureAdvancements(analytical, "analytical-muse");
  }
  if (prototype) {
    await prototype.update({
      [`flags.${MODULE_ID}.feature`]: "prototype-imbuements",
      "system.uses.max": "1",
      "system.uses.recovery": [{ period: "lr", type: "recoverAll" }]
    }, { innovationsCodexMigration: true });
    await repairFeatureActivity(prototype, "prototype-imbuements", { innovationsCodexMigration: true });
  }
  if (innovationSpells) await repairFeatureAdvancements(innovationSpells, "innovation-spells");
  if (magicalDiscoveries) await repairFeatureAdvancements(magicalDiscoveries, "magical-discoveries");
  if (subclass) await repairLegacySubclassAdvancements(subclass, createFeature?.uuid ?? null);
}

async function repairCollegeActor(actor: AnyDocument): Promise<void> {
  await withLock(WORLD_STATE_LOCK, async () => {
    const state = getWorldState();
    await migrateSubclassActor(actor, state, false);
    await setWorldState(state);
  });
}

async function runMigrations(): Promise<void> {
  await withLock(WORLD_STATE_LOCK, async () => {
    const importLegacyTrust = Number(game.settings.get(MODULE_ID, "schemaVersion") ?? 0) < SCHEMA_VERSION;
    const state = getWorldState();
    await migrateWorldCollegeContent();
    for (const actor of game.actors.contents) {
      await migrateSubclassActor(actor, state, importLegacyTrust);
    }
    await setWorldState(state);
    for (const actor of game.actors.contents.filter((candidate: AnyDocument) => isCollegeOfInnovationActor(candidate))) {
      const updates: Record<string, unknown> = {};
      for (const [level, reserved] of reservedSlotsByLevel(actor, state)) {
        const slot = getSpellSlot(actor, level);
        const current = Number(slot.value ?? 0);
        const maximum = Number(slot.max ?? 0);
        const cap = Math.max(0, maximum - reserved);
        if (Number.isFinite(current) && current > cap) updates[slot.path] = cap;
      }
      if (Object.keys(updates).length) {
        await actor.update(updates, { innovationsCodexMigration: true });
      }
    }
    await game.settings.set(MODULE_ID, "schemaVersion", SCHEMA_VERSION);
  });
}

async function reconcileWorldState(): Promise<void> {
  await withLock(WORLD_STATE_LOCK, async () => {
    const state = getWorldState();
    for (const [reservationId, receipt] of Object.entries(state.releaseReceiptsByReservationId)) {
      const reservation = state.reservationsById[reservationId];
      const ownerActor = await fromUuid(receipt.ownerActorUuid);
      if (!reservation || !(ownerActor instanceof Actor) || game.actors.get(ownerActor.id) !== ownerActor) {
        delete state.reservationsById[reservationId];
        delete state.releaseReceiptsByReservationId[reservationId];
        continue;
      }
      const slot = getSpellSlot(ownerActor, receipt.slotLevel);
      const current = Number(slot.value);
      if (current === receipt.beforeValue) {
        await ownerActor.update({ [slot.path]: receipt.restoredValue }, { innovationsCodexReconcile: true });
      } else if (current !== receipt.restoredValue) {
        console.error(`${MODULE_ID} | Interrupted slot release requires GM review`, receipt);
        continue;
      }
      delete state.reservationsById[reservationId];
      delete state.releaseReceiptsByReservationId[reservationId];
    }
    for (const reservation of Object.values(state.reservationsById)) {
      const ownerActor = await fromUuid(reservation.ownerActorUuid);
      if (!(ownerActor instanceof Actor) || game.actors.get(ownerActor.id) !== ownerActor) {
        delete state.reservationsById[reservation.id];
        continue;
      }
      const temporary = await fromUuid(reservation.temporaryItemUuid);
      if (!temporary) {
        await releaseReservation(ownerActor, state, reservation);
        continue;
      }
      const valid = temporary instanceof Item
        && temporary.parent instanceof Actor
        && game.actors.get(temporary.parent.id) === temporary.parent
        && temporary.parent.uuid === reservation.targetActorUuid
        && temporary.getFlag?.(MODULE_ID, "reservationId") === reservation.id
        && temporary.getFlag?.(MODULE_ID, "originUuid") === reservation.codexUuid
        && temporary.getFlag?.(MODULE_ID, "blueprintUuid") === reservation.blueprintUuid;
      if (!valid) {
        console.error(`${MODULE_ID} | Reservation conflict requires GM review; no slot was restored`, reservation);
      }
    }
    for (const [grantId, grant] of Object.entries(state.inspirationGrantsById)) {
      const grantItem = await fromUuid(grant.grantItemUuid);
      const reservation = state.reservationsById[grant.reservationId];
      const valid = grantItem instanceof Item
        && grantItem.parent instanceof Actor
        && grantItem.parent.uuid === grant.targetActorUuid
        && grantItem.getFlag?.(MODULE_ID, "inspirationGrantId") === grantId
        && Boolean(reservation);
      if (valid) continue;
      if (grantItem instanceof Item && grantItem.parent instanceof Actor) {
        await grantItem.parent.deleteEmbeddedDocuments("Item", [grantItem.id], { innovationsCodexInspiration: true });
      }
      delete state.inspirationGrantsById[grantId];
    }
    await setWorldState(state);
  });
}

function reservedSlotsByLevel(actor: AnyDocument, state = getWorldState()): Map<SlotLevel, number> {
  const counts = new Map<SlotLevel, number>();
  for (const reservation of getActiveOwnerReservations(actor, state)) {
    if (reservation.payment !== "slot" || !reservation.slotLevel) continue;
    counts.set(reservation.slotLevel, (counts.get(reservation.slotLevel) ?? 0) + 1);
  }
  return counts;
}

async function deleteMirrorForBlueprint(blueprintUuid: string): Promise<void> {
  const mirror = game.items.find((item: AnyDocument) => item.getFlag(MODULE_ID, "mirrorOf") === blueprintUuid);
  if (mirror) await mirror.delete({ innovationsCodexMirror: true });
}

async function invalidateBlueprintApproval(blueprint: AnyDocument): Promise<void> {
  if (!(blueprint.parent instanceof Actor)) return;
  await withLock(WORLD_STATE_LOCK, async () => {
    const state = getWorldState();
    if (state.approvalsByBlueprintUuid[blueprint.uuid]) {
      delete state.approvalsByBlueprintUuid[blueprint.uuid];
      await setWorldState(state);
    }
    await blueprint.update({
      [`flags.${MODULE_ID}.approved`]: false,
      [`flags.${MODULE_ID}.spellLevel`]: null
    }, { innovationsCodexApproval: true });
    const codex = findCodexForBlueprint(blueprint);
    if (codex && state.codexByActorUuid[blueprint.parent.uuid] === codex.uuid) {
      await syncMirrorFromBlueprint(blueprint, null);
    } else {
      await deleteMirrorForBlueprint(blueprint.uuid);
    }
  });
}

async function reconcileDeletedItem(item: AnyDocument): Promise<void> {
  await withLock(WORLD_STATE_LOCK, async () => {
    const state = getWorldState();
    const reservation = Object.values(state.reservationsById)
      .find((candidate) => candidate.temporaryItemUuid === item.uuid);
    if (reservation) {
      const ownerActor = await fromUuid(reservation.ownerActorUuid);
      if (ownerActor instanceof Actor && game.actors.get(ownerActor.id) === ownerActor) {
        await releaseReservation(ownerActor, state, reservation);
      } else {
        delete state.reservationsById[reservation.id];
      }
    }

    for (const [grantId, grant] of Object.entries(state.inspirationGrantsById)) {
      if (grant.grantItemUuid === item.uuid) delete state.inspirationGrantsById[grantId];
    }
    if (state.approvalsByBlueprintUuid[item.uuid]) {
      delete state.approvalsByBlueprintUuid[item.uuid];
    }
    const actorUuid = Object.entries(state.codexByActorUuid)
      .find(([, codexUuid]) => codexUuid === item.uuid)?.[0];
    if (actorUuid && !getCodexReservations(item.uuid, state).length) {
      delete state.codexByActorUuid[actorUuid];
      for (const [uuid, approval] of Object.entries(state.approvalsByBlueprintUuid)) {
        if (approval.codexUuid === item.uuid) delete state.approvalsByBlueprintUuid[uuid];
      }
    }
    await setWorldState(state);
    if (!actorUuid) await deleteMirrorForBlueprint(item.uuid);
  });
}

function findBardicInspirationFeature(actor: AnyDocument): AnyDocument | null {
  return actor?.items?.find((item: AnyDocument) => item.name === "Bardic Inspiration"
    || item.system?.identifier === "bardic-inspiration") ?? null;
}

async function useAnalyticalMuse(feature: AnyDocument): Promise<void> {
  const actor = feature?.parent;
  if (!(actor instanceof Actor)) throw new Error("Analytical Muse must be on an actor.");
  const analyticalSpent = Number(foundry.utils.getProperty(feature, "system.uses.spent") ?? 0);
  const analyticalMax = Math.max(0, Number(foundry.utils.getProperty(actor, "system.abilities.int.mod") ?? 0));
  const inspiration = findBardicInspirationFeature(actor);
  const inspirationSpent = Number(foundry.utils.getProperty(inspiration, "system.uses.spent") ?? 0);
  const inspirationMax = Number(foundry.utils.getProperty(inspiration, "system.uses.max") ?? 0);
  const payments: string[] = [];
  if (analyticalSpent < analyticalMax) payments.push(`<option value="analytical">Analytical Muse (${analyticalMax - analyticalSpent} remaining)</option>`);
  if (inspiration && inspirationSpent < inspirationMax) payments.push(`<option value="inspiration">Bardic Inspiration (${inspirationMax - inspirationSpent} remaining)</option>`);
  if (!payments.length) {
    ui.notifications?.warn("No Analytical Muse or Bardic Inspiration uses remain.");
    return;
  }
  const result = await foundry.applications.api.DialogV2.input({
    window: { title: "Analytical Muse" },
    content: `<label for="ic-skill">Skill</label><select id="ic-skill" name="skill">`
      + `<option value="arc">Arcana</option><option value="his">History</option>`
      + `<option value="inv">Investigation</option><option value="nat">Nature</option></select>`
      + `<label for="ic-analytical-payment">Resource</label>`
      + `<select id="ic-analytical-payment" name="payment">${payments.join("")}</select>`,
    ok: { label: "Roll" },
    rejectClose: false
  });
  if (!result) return;
  const skill = String(result.skill);
  if (!["arc", "his", "inv", "nat"].includes(skill)) throw new Error("Choose a valid Analytical Muse skill.");
  const payment = result.payment === "inspiration" ? inspiration : feature;
  if (!payment) throw new Error("The selected resource is unavailable.");
  await withLock(`analytical:${actor.uuid}`, async () => {
    const spent = Number(foundry.utils.getProperty(payment, "system.uses.spent") ?? 0);
    const maximum = payment === feature
      ? Math.max(0, Number(foundry.utils.getProperty(actor, "system.abilities.int.mod") ?? 0))
      : Number(foundry.utils.getProperty(payment, "system.uses.max") ?? 0);
    if (!Number.isFinite(spent) || spent >= maximum) throw new Error("The selected resource has no uses remaining.");
    await payment.update({ "system.uses.spent": spent + 1 });
    try {
      const roll = await actor.rollSkill({ skill, ability: "cha" });
      if (roll === null) await payment.update({ "system.uses.spent": spent });
    } catch (error) {
      await payment.update({ "system.uses.spent": spent });
      throw error;
    }
  });
}

async function useInnovationInspiration(feature: AnyDocument): Promise<void> {
  const actor = feature?.parent;
  if (!(actor instanceof Actor)) throw new Error("Innovation Bardic Inspiration must be on an actor.");
  const choice = await foundry.applications.api.DialogV2.input({
    window: { title: "Spend Innovation Bardic Inspiration" },
    content: `<label for="ic-inspired-roll">Roll type</label><select id="ic-inspired-roll" name="rollType">`
      + `<option value="attack">Attack roll</option><option value="check">Ability check</option>`
      + `<option value="save">Saving throw</option></select>`,
    ok: { label: "Roll Inspiration" },
    rejectClose: false
  });
  if (!choice) return;
  const consumed = await consumeInnovationInspiration(feature.uuid, String(choice.rollType));
  const roll = await new Roll(consumed.formula, actor.getRollData()).evaluate();
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `Innovation Bardic Inspiration from ${escapeHtml(consumed.ownerName)}`
  });
}

/* ================================================== */
/*  SECTION 7: Hooks                                  */
/* ================================================== */

Hooks.once("socketlib.ready", () => {
  _registerSocketlib();
});

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "schemaVersion", {
    name: "Schema Version",
    scope: "world", config: false, type: Number, default: 0
  });
  game.settings.register(MODULE_ID, "worldState", {
    name: "Trusted World State",
    scope: "world", config: false, type: Object, default: emptyWorldState()
  });

  for (const type of ["Trait", "ItemChoice", "ItemGrant"]) {
    CONFIG.DND5E?.advancementTypes?.[type]?.validItemTypes?.add?.("feat");
  }
  game.settings.register(MODULE_ID, "allowedActorNames", {
    name: "Allowed Actor Names",
    hint: "Comma-separated actor names to include as innovation targets.",
    scope: "world", config: true, type: String, default: ""
  });

  game.settings.register(MODULE_ID, "targetMode", {
    name: "Target Actor Filter",
    hint: "Choose which actors appear as fabrication targets.",
    scope: "world", config: true, type: String,
    choices: { pcs: "Player Characters", owned: "All Owned Characters" },
    default: "pcs"
  });

  game.settings.register(MODULE_ID, "iconSize", {
    name: "Item Icon Size",
    hint: "Size (in pixels) for blueprint item icons.",
    scope: "client", config: true, type: String,
    choices: { "64": "64 px", "96": "96 px", "128": "128 px", "256": "256 px" },
    default: "64"
  });

  game.settings.register(MODULE_ID, "portraitSize", {
    name: "Portrait Icon Size",
    hint: "Size (in pixels) for target portraits.",
    scope: "client", config: true, type: String,
    choices: { "32": "32 px", "48": "48 px", "64": "64 px", "96": "96 px" },
    default: "48"
  });

  const moduleApi = game.modules.get(MODULE_ID);
  if (moduleApi) {
    moduleApi.api = {
      openCodex: openCodexByUuid,
      useCreateFeature: async (featUuid: string) => {
        const feat = await fromUuid(featUuid);
        if (feat) await useCreateFeature(feat);
      },
      repairActor: async (actorUuid: string) => {
        if (!isActiveGM()) throw new Error("Only the active GM can repair an actor.");
        assertReady();
        const actor = requireActorDocument(await fromUuid(actorUuid));
        await repairCollegeActor(actor);
      }
    };
  }
});

Hooks.once("ready", () => {
  if (!isActiveGM()) {
    initializationReady = Number(game.settings.get(MODULE_ID, "schemaVersion") ?? 0) >= SCHEMA_VERSION;
    return;
  }
  void (async () => {
    const rootFolder = await ensureFolderHierarchy();
    await ensureWorldItems(rootFolder);
    await runMigrations();
    await reconcileWorldState();
    initializationReady = true;
  })().catch((error) => reportError(error, "Innovations Codex setup failed."));
});

Hooks.on("dnd5e.preUseActivity", (activity: AnyDocument, _usageConfig: AnyDocument, dialogConfig: AnyDocument, messageConfig: AnyDocument) => {
  const item = activity?.item;
  if (isCreateFeature(item)) {
    if (dialogConfig) dialogConfig.configure = false;
    if (messageConfig) messageConfig.create = false;
    void useCreateFeature(item).catch((error) => reportError(error, "Could not open the Innovations Codex."));
    return false;
  }
  if (item?.getFlag?.(MODULE_ID, "feature") === "prototype-imbuements") {
    if (dialogConfig) dialogConfig.configure = false;
    if (messageConfig) messageConfig.create = false;
    const createFeature = item.parent?.items?.find?.((candidate: AnyDocument) => isCreateFeature(candidate));
    if (createFeature) {
      void useCreateFeature(createFeature)
        .catch((error) => reportError(error, "Could not open the Innovations Codex."));
    } else {
      reportError(new Error("Create Innovation is missing from this actor."), "Could not open the Innovations Codex.");
    }
    return false;
  }
  if (item?.getFlag?.(MODULE_ID, "feature") === "analytical-muse") {
    if (dialogConfig) dialogConfig.configure = false;
    if (messageConfig) messageConfig.create = false;
    void useAnalyticalMuse(item).catch((error) => reportError(error, "Analytical Muse failed."));
    return false;
  }
  if (item?.getFlag?.(MODULE_ID, "inspirationGrantId")) {
    if (dialogConfig) dialogConfig.configure = false;
    if (messageConfig) messageConfig.create = false;
    void useInnovationInspiration(item)
      .catch((error) => reportError(error, "Innovation Bardic Inspiration failed."));
    return false;
  }
});

Hooks.on("dnd5e.preRestCompleted", (actor: AnyDocument, result: AnyDocument) => {
  if (result?.type === "long") {
    result.updateData ??= {};
    for (const [level, reserved] of reservedSlotsByLevel(actor)) {
      const slot = getSpellSlot(actor, level);
      const maximum = Number(slot.max ?? 0);
      if (!Object.prototype.hasOwnProperty.call(result.updateData, slot.path)) continue;
      const planned = Number(result.updateData[slot.path]);
      if (!Number.isFinite(planned)) continue;
      result.updateData[slot.path] = Math.min(planned, Math.max(0, maximum - reserved));
    }
  }

  const outstanding = Object.values(getWorldState().inspirationGrantsById)
    .filter((grant) => grant.ownerActorUuid === actor.uuid).length;
  if (outstanding > 0 && Array.isArray(result?.updateItems)) {
    const inspiration = findBardicInspirationFeature(actor);
    const update = inspiration
      ? result.updateItems.find((candidate: AnyDocument) => candidate._id === inspiration.id)
      : null;
    if (update) {
      const planned = Number(foundry.utils.getProperty(update, "system.uses.spent") ?? 0);
      foundry.utils.setProperty(update, "system.uses.spent", Math.max(planned, outstanding));
    }
  }
});

Hooks.on("updateItem", (item: AnyDocument, changes: AnyDocument, options: AnyDocument) => {
  if (!isActiveGM() || options?.innovationsCodexMirror || options?.innovationsCodexMigration
    || options?.innovationsCodexApproval || options?.innovationsCodexReconcile) return;
  const bardLevelChanged = item.type === "class"
    && (item.system?.identifier === "bard" || item.name === "Bard")
    && foundry.utils.getProperty(changes, "system.levels") !== undefined
    && item.parent instanceof Actor
    && isCollegeOfInnovationActor(item.parent);
  if (bardLevelChanged) {
    void repairCollegeActor(item.parent)
      .catch((error) => reportError(error, "Could not apply College of Innovation level advancements."));
  }
  if (item.parent instanceof Actor
    && ["innovation-spells", "magical-discoveries"].includes(String(item.getFlag?.(MODULE_ID, "feature") ?? ""))) {
    void repairFeatureGrantedSpellSources(item.parent)
      .catch((error) => console.warn(`${MODULE_ID} | Could not repair feature-granted spell sources`, error));
  }
  const state = getWorldState();
  const wasBlueprint = Boolean(state.approvalsByBlueprintUuid[item.uuid]
    || game.items.find((candidate: AnyDocument) => candidate.getFlag?.(MODULE_ID, "mirrorOf") === item.uuid));
  if (findCodexForBlueprint(item) || wasBlueprint) {
    void invalidateBlueprintApproval(item)
      .catch((error) => console.warn(`${MODULE_ID} | Blueprint review reset failed`, error));
  }
});

Hooks.on("createItem", (item: AnyDocument, options: AnyDocument) => {
  if (!isActiveGM() || options?.innovationsCodexMigration || item.type !== "spell"
    || !(item.parent instanceof Actor)) return;
  window.setTimeout(() => {
    void repairFeatureGrantedSpellSources(item.parent)
      .catch((error) => console.warn(`${MODULE_ID} | Could not repair a newly granted spell source`, error));
  }, 250);
});

Hooks.on("preDeleteItem", (item: AnyDocument, options: AnyDocument) => {
  const state = getWorldState();
  const isTrustedCodex = Object.values(state.codexByActorUuid).includes(item.uuid);
  if (isTrustedCodex && getCodexReservations(item.uuid, state).length) {
    ui.notifications?.error("Recall every active innovation before deleting its Innovations Codex.");
    return false;
  }
  if (Object.values(state.reservationsById).some((reservation) => reservation.blueprintUuid === item.uuid)) {
    ui.notifications?.error("Recall every active copy before deleting this innovation blueprint.");
    return false;
  }
});

Hooks.on("preDeleteActor", (actor: AnyDocument) => {
  const state = getWorldState();
  const related = Object.values(state.reservationsById).some((reservation) =>
    reservation.ownerActorUuid === actor.uuid || reservation.targetActorUuid === actor.uuid);
  if (related) {
    ui.notifications?.error("Recall this actor's active innovations before deleting the actor.");
    return false;
  }
});

Hooks.on("deleteItem", (item: AnyDocument, _options: AnyDocument) => {
  if (!isActiveGM()) return;
  void reconcileDeletedItem(item)
    .catch((error) => reportError(error, "Could not reconcile deleted Innovations Codex data."));
});

async function createOrReuseHotbarMacro(item: AnyDocument, slot: number): Promise<void> {
  if (!game.user.can?.("MACRO_SCRIPT")) {
    ui.notifications?.warn("You do not have permission to create script macros.");
    return;
  }
  const kind = isCreateFeature(item) ? "create-feature" : "codex";
  const existing = game.macros.find((macro: AnyDocument) =>
    macro.getFlag?.(MODULE_ID, "targetUuid") === item.uuid
    && macro.getFlag?.(MODULE_ID, "kind") === kind
  );
  const method = kind === "create-feature" ? "useCreateFeature" : "openCodex";
  const name = kind === "create-feature" ? "Create Innovation" : "Open Innovations Codex";
  const command = `game.modules.get("${MODULE_ID}")?.api.${method}("${item.uuid}")`;
  const macro = existing ?? await Macro.create({
    name,
    type: "script",
    img: item.img,
    command,
    flags: { [MODULE_ID]: { targetUuid: item.uuid, kind } }
  });
  await game.user.assignHotbarMacro(macro, slot);
}

Hooks.on("hotbarDrop", (_bar: AnyDocument, data: AnyDocument, slot: number) => {
  if (data?.type !== "Item" || !data?.uuid) return;
  const item = fromUuidSync(data.uuid);
  if (!isCreateFeature(item) && !isCodexItem(item)) return;
  void createOrReuseHotbarMacro(item, slot)
    .catch((error: unknown) => reportError(error, "Could not create the hotbar macro."));
  return false;
});
