import "server-only";
import crypto from "node:crypto";
import { getLinkBaseUrl, getNewsletterHost } from "@/lib/archive-hosts";
import { readUtm, toReferrerHost } from "@/lib/attribution";
import { getAppHost, getAppSecret } from "@/lib/config";
import { findSignupNewsletter } from "@/lib/public-newsletters";
import { isRateLimited } from "@/lib/rate-limit";
import { limitKey } from "@/lib/reader-links";
import { signUp } from "@/lib/signup";
import { normalizeEmail } from "@/lib/validation";

// A Magic Link is one address for all of another newsletter's readers: https://<host>/subscribe/magic?email={{email}}&k=1&sig=…
// That newsletter's platform fills in each reader's address when it sends. So the signature can't cover the address: it
// covers the newsletter and a key id (k), and retiring a link means moving the newsletter to the next key id. What keeps
// it from subscribing people who never asked is what keeps any signup form from it: with confirmed opt-in the address is
// only mailed a confirmation, and the limits below stop one address or one network from being used over and over.
export const MAGIC_PER_IP = { name: "magic-ip", limit: 10, window: "10 m" };
export const MAGIC_PER_EMAIL = { name: "magic-email", limit: 3, window: "1 d" };
export const MAGIC_PATH = "/subscribe/magic";
export const MAGIC_EMAIL_TAG = "{{email}}";

function getSigningKey() {
	return Buffer.from(crypto.hkdfSync("sha256", getAppSecret(), "", "flockstack-magic-link-v1", 32));
}

export function getMagicKeyId(newsletter) {
	return newsletter.magicKeyId ?? 1;
}

export function getMagicSignature(newsletter, keyId = getMagicKeyId(newsletter)) {
	return crypto.createHmac("sha256", getSigningKey()).update(`${newsletter._id}:${keyId}`).digest("base64url").slice(0, 22);
}

// "valid", "retired" (a real link of an earlier key id) or "invalid".
export function checkMagicLink(newsletter, { keyId, signature }) {
	const id = Number(keyId);
	if (!Number.isInteger(id) || id < 1 || typeof signature !== "string" || signature.length !== 22) return "invalid";
	const expected = Buffer.from(getMagicSignature(newsletter, id));
	const provided = Buffer.from(signature);
	if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return "invalid";
	return id === getMagicKeyId(newsletter) ? "valid" : "retired";
}

// The address to give another platform: its own merge tag goes where {{email}} stands. Without a host of its own (local
// development) the address needs the newsletter's slug, which the host would have given.
export function getMagicTemplate(newsletter) {
	const base = getLinkBaseUrl(newsletter);
	const slug = getNewsletterHost(newsletter) ? "" : `&n=${newsletter.slug}`;
	return `${base}${MAGIC_PATH}?email=${MAGIC_EMAIL_TAG}&k=${getMagicKeyId(newsletter)}&sig=${getMagicSignature(newsletter)}${slug}`;
}

// Some platforms don't encode a + in an address, and it reaches us as a space.
export function readMagicEmail(value) {
	return normalizeEmail(String(value ?? "").trim().replaceAll(" ", "+"));
}

export const MAGIC_MESSAGES = {
	invalid: "This link doesn't work. Ask the newsletter that sent it for another.",
	retired: "This link was retired by the newsletter. Ask it for a newer one, or sign up on its website.",
	email: "Enter a valid email address.",
	limit: "This address has already asked a few times today. Check your inbox, including spam, for the confirmation email.",
	slow: "Too many signups from your network. Try again in a few minutes.",
};

// The click: checks the link, the limits and the address, then signs up like any form (honeypot, suppression, confirmed
// opt-in, the confirmation email). formData: email, newsletter (its slug), k, sig, and any utm_ parameters the link had.
export async function subscribeByMagicLink({ formData, ip, referer }) {
	if (formData.get("website")) return { ok: true };
	const newsletter = await findSignupNewsletter({ slug: String(formData.get("newsletter") ?? "") });
	if (!newsletter) return { error: MAGIC_MESSAGES.invalid };
	const status = checkMagicLink(newsletter, { keyId: formData.get("k"), signature: formData.get("sig") });
	if (status !== "valid") return { error: MAGIC_MESSAGES[status] };
	const email = readMagicEmail(formData.get("email"));
	if (!email) return { error: MAGIC_MESSAGES.email };
	if (await isRateLimited({ ...MAGIC_PER_IP, key: ip })) return { error: MAGIC_MESSAGES.slow };
	if (await isRateLimited({ ...MAGIC_PER_EMAIL, key: limitKey(`${newsletter._id}:${email}`) })) return { error: MAGIC_MESSAGES.limit };

	const utm = readUtm((name) => formData.get(name));
	const data = new FormData();
	data.set("email", email);
	data.set("newsletter", newsletter.slug);
	const result = await signUp({
		formData: data,
		ip,
		source: "magic-link",
		utm,
		referrer: toReferrerHost(referer, [getNewsletterHost(newsletter), getAppHost()]) ?? "",
		requireWebsite: false,
		resubscribe: false,
	});
	// The page shows what happened to the address it was given: nothing else about the signup.
	if (result.error) return { error: result.error };
	return result.pending ? { ok: true, pending: true, email, inbox: result.inbox } : { ok: true, email };
}
