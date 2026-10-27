import { getAppUrl } from "./config.js";
import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";
import { isObjectIdString } from "./validation.js";

const kinds = {
	verify: { info: "flockstack-sponsorship-verify-v1", age: 86400000, path: "verify" },
	manager: { info: "flockstack-sponsorship-manager-v1", age: 7 * 86400000, path: "manage" },
};
function valid(value) {
	return value && !Array.isArray(value) && Object.keys(value).sort().join(",") === "a,b,n,t,v" && [value.a, value.b, value.n].every(isObjectIdString) && Number.isSafeInteger(value.v) && value.v >= 0 && Number.isSafeInteger(value.t) && value.t > 0;
}

function create(kind, booking, now) {
	const data = { a: String(booking.accountId), b: String(booking._id), n: String(booking.newsletterId), v: kind === "verify" ? booking.verificationVersion ?? 0 : booking.managerVersion ?? 0, t: Math.floor(now / 1000) };
	if (!valid(data)) throw new Error("Invalid sponsorship link reference");
	const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
	return `${encoded}.${signWithAppKey(kinds[kind].info, encoded)}`;
}

// A token proves a scoped capability, not the current booking or its payment. Controllers must recheck the account,
// newsletter, row, current role version, cancellation and verified recipient before private reads or mutations.
export function readSponsorshipToken(token, kind, now = Date.now()) {
	if (!Object.hasOwn(kinds, kind) || typeof token !== "string" || !/^[A-Za-z0-9_-]{1,600}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const [encoded, signature] = token.split(".");
	if (!isSignedWithAppKey(kinds[kind].info, encoded, signature)) return null;
	try {
		const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!valid(data) || data.t * 1000 > now + 60000 || now - data.t * 1000 > kinds[kind].age) return null;
		return { accountId: data.a, newsletterId: data.n, bookingId: data.b, version: data.v };
	} catch { return null; }
}

export function getSponsorshipVerificationLink(booking, now = Date.now()) {
	return `${getAppUrl()}/reader/sponsorships/verify?token=${create("verify", booking, now)}`;
}
export function getSponsorshipManagerLink(booking, now = Date.now()) {
	return `${getAppUrl()}/reader/sponsorships/manage?token=${create("manager", booking, now)}`;
}
