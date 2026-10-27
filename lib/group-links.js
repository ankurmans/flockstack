import { getAppUrl } from "./config.js";
import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";
import { isObjectIdString } from "./validation.js";

export const GROUP_LINK_MAX_AGE_MS = 7 * 86400000;
const kinds = { manager: "flockstack-group-manager-v1", seat: "flockstack-group-seat-v1" };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function valid(reference, kind) {
	const keys = kind === "manager" ? "a,g,n,t,v" : "a,g,n,s,t,v";
	return Object.keys(reference).sort().join(",") === keys && [reference.a, reference.g, reference.n].every(isObjectIdString) && Number.isSafeInteger(reference.v) && reference.v >= 0 && Number.isSafeInteger(reference.t) && reference.t > 0 && (kind === "manager" || uuid.test(reference.s ?? ""));
}

function create(kind, group, { seat, now = Date.now() } = {}) {
	const reference = { a: String(group.accountId), g: String(group._id), n: String(group.newsletterId), v: kind === "manager" ? group.managerVersion ?? 0 : seat?.invitationVersion ?? 0, t: Math.floor(now / 1000), ...(seat && { s: seat.id }) };
	if (!valid(reference, kind)) throw new Error("Invalid group link reference");
	const encoded = Buffer.from(JSON.stringify(reference)).toString("base64url");
	return `${encoded}.${signWithAppKey(kinds[kind], encoded)}`;
}

// A signature proves only this scoped capability. The controller must still check the current row, version, recipient,
// seat state and funded access before reading private data or changing anything.
export function readGroupToken(token, kind, now = Date.now()) {
	if (!Object.hasOwn(kinds, kind) || typeof token !== "string" || !/^[A-Za-z0-9_-]{1,600}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const [encoded, signature] = token.split(".");
	if (!isSignedWithAppKey(kinds[kind], encoded, signature)) return null;
	try {
		const reference = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!reference || Array.isArray(reference) || !valid(reference, kind) || reference.t * 1000 > now + 60000 || now - reference.t * 1000 > GROUP_LINK_MAX_AGE_MS) return null;
		return { accountId: reference.a, newsletterId: reference.n, groupId: reference.g, version: reference.v, ...(kind === "seat" && { seatId: reference.s }) };
	} catch { return null; }
}

export function getGroupManagerLink(group, now = Date.now()) {
	return `${getAppUrl()}/reader/groups/manage?token=${create("manager", group, { now })}`;
}

export function getGroupSeatLink(group, seat, now = Date.now()) {
	return `${getAppUrl()}/reader/groups/invite?token=${create("seat", group, { seat, now })}`;
}

export function getGroupBuyLink(newsletter) {
	return `${getAppUrl()}/reader/groups/buy?newsletter=${encodeURIComponent(newsletter.slug)}`;
}

export function getGroupCompleteLink(newsletter) {
	return `${getAppUrl()}/reader/groups/complete?session_id={CHECKOUT_SESSION_ID}&newsletter=${encodeURIComponent(newsletter.slug)}`;
}
