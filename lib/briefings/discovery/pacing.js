import { scoped } from "../../account-scope.js";
import DiscoveryUsage from "../../../models/DiscoveryUsage.js";

// Pacing of discovery providers (docs/BRIEFINGS-DESIGN.md, When a free-tier limit is hit): a counter per account, provider, key,
// operation and window, so two briefings on one key share its published limits. A request takes a slot in every window first;
// when one is full the slot is given back and the caller learns which window and until when.
export const WINDOWS = { minute: 60_000, hour: 60 * 60_000, day: 24 * 60 * 60_000 };

export function windowStart(scope, now) {
	return new Date(Math.floor(now.getTime() / WINDOWS[scope]) * WINDOWS[scope]);
}

export function windowEnd(scope, now) {
	return new Date(windowStart(scope, now).getTime() + WINDOWS[scope]);
}

// DiscoveryUsage's unique index has no accountId in it, so a keyless provider (the free indexes, paced per account) is counted
// under a key id of the account's own: two accounts in the same minute would otherwise share, and collide on, one row.
function filterFor({ accountId, provider, keyId = "", operation, scope, now }) {
	return scoped(accountId, { provider, keyId: String(keyId || `account:${accountId}`), operation, window: scope, windowStart: windowStart(scope, now) });
}

// An upsert that lost a race to another's insert of the same row is tried once more, as an update.
async function upsert(run) {
	try {
		return await run();
	} catch (error) {
		if (error?.code !== 11000 && !/UNIQUE constraint/.test(`${error?.message} ${error?.cause?.message ?? ""}`)) throw error;
		return run();
	}
}

// { ok: true } or { ok: false, scope, until }.
export async function takeSlot({ accountId, provider, keyId, operation, limits = {}, now }) {
	for (const scope of Object.keys(WINDOWS)) {
		const row = await DiscoveryUsage.findOne(filterFor({ accountId, provider, keyId, operation, scope, now })).lean();
		if (row?.exhaustedUntil && new Date(row.exhaustedUntil) > now) return { ok: false, scope, until: new Date(row.exhaustedUntil) };
	}
	const taken = [];
	for (const [scope, limit] of Object.entries(limits)) {
		if (!WINDOWS[scope] || !Number.isFinite(limit)) continue;
		const filter = filterFor({ accountId, provider, keyId, operation, scope, now });
		const row = await upsert(() => DiscoveryUsage.findOneAndUpdate(filter, { $inc: { count: 1 } }, { upsert: true, returnDocument: "after" }).lean());
		taken.push(filter);
		if (row.count > limit) {
			for (const each of taken) await DiscoveryUsage.updateOne(each, { $inc: { count: -1 } });
			return { ok: false, scope, until: windowEnd(scope, now) };
		}
	}
	return { ok: true };
}

// The provider said the window is used up (or a 402 said the day's free allowance is): no asking again before `until`.
export async function markExhausted({ accountId, provider, keyId, operation, scope, until, now }) {
	await upsert(() => DiscoveryUsage.updateOne(filterFor({ accountId, provider, keyId, operation, scope, now }), { $set: { exhaustedUntil: until } }, { upsert: true }));
}
