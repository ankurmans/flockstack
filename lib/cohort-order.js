// A random cohort send (beehiiv calls it a random cohort): audienceLimit takes a random share of the audience instead of the
// most engaged contacts. Random here means a fixed shuffle per campaign: every contact gets a rank from a hash of the
// campaign's ID and its own, so the cohort is the lowest ranks. That makes a cohort
//   - fair: the hash knows nothing about engagement, sign-up date or address, so every contact is equally likely to be early;
//   - repeatable: counting it, queueing it again after a failure and sending it in steps all see the same order, and a later
//     step's cohort contains the earlier ones (the one-email-per-contact index skips whoever already got it);
//   - different for each campaign, so the same readers don't always go first.
export const AUDIENCE_ORDERS = ["engaged", "random"];
// The ranks of the whole audience are held in memory to sort them: 12 bytes or so a contact.
export const RANDOM_COHORT_MAX_CONTACTS = 500_000;

function hash32(text, seed) {
	let hash = seed >>> 0;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35);
	hash ^= hash >>> 16;
	return hash >>> 0;
}

// A number in [0, 1) with 53 bits of it, the same for the same campaign and contact.
export function getCohortRank(campaignId, contactId) {
	const key = `${campaignId}:${contactId}`;
	return (hash32(key, 0x811c9dc5) * 2 ** 21 + (hash32(key, 0x9747b28c) >>> 11)) / 2 ** 53;
}

export function isRandomOrder(campaign) {
	return campaign?.audienceOrder === "random";
}

// The ids in the order a random cohort takes them, lowest rank first. A tie (as good as never) goes by id.
export function orderByCohort(campaignId, ids) {
	const ranks = Float64Array.from(ids, (id) => getCohortRank(campaignId, id));
	const order = Uint32Array.from(ids.keys()).sort((a, b) => ranks[a] - ranks[b] || (String(ids[a]) < String(ids[b]) ? -1 : 1));
	return Array.from(order, (index) => ids[index]);
}
