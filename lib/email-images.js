import { SECTION_ICON_KEYS } from "./briefing-rules.js";
import { getEmailCard, getEmailIconUrl, getIconColor, getIconStorageKey } from "./issue-card.js";
import { getCardHash, getCardKey } from "./share-card.js";

// The card and section icons of an issue's email (docs/VISUALS-DESIGN.md) are drawn by the app on their first request and kept
// in the IMAGES bucket, which IMAGES_CDN_URL serves cached. An email client fetches images through its own proxy, which gives
// up on an address that is slow to answer, and the first request of a new card or color is the slow one. So a send makes sure
// the files are stored (asking the app to draw what is missing, once) and points the email at the bucket's address. Whether a file
// is stored is asked of the bucket binding: a Worker fetching the bucket's own public address gets nothing back. Anything
// that can't be checked leaves the email on the app's addresses, which still draw on request.
const DRAW_TIMEOUT_MS = 20_000;
// A file that couldn't be stored is asked about again after this, not by every email of the send.
const RETRY_AFTER_MS = 5 * 60_000;
const MAX_KNOWN = 2000;
const known = new Map();

export function forgetEmailImages() {
	known.clear();
}

// Stored files never change (their names carry what they show), so a yes is kept for good, a no for a few minutes. run() never
// throws; concurrent callers share one run.
function once(key, run) {
	const hit = known.get(key);
	if (hit && hit.expires > Date.now()) return hit.promise;
	if (known.size >= MAX_KNOWN) known.clear();
	const entry = { expires: Date.now() + RETRY_AFTER_MS, promise: null };
	entry.promise = run().then((stored) => {
		if (stored) entry.expires = Infinity;
		return stored;
	});
	known.set(key, entry);
	return entry.promise;
}

// Asked of the IMAGES binding itself (lib/rendered-images.js does the same): image-storage.js would bring every storage provider
// into the lean Workers that share this file.
async function hasBoundImage(key) {
	const { getCloudflareContext } = await import("@opennextjs/cloudflare");
	const { env } = await getCloudflareContext({ async: true });
	return Boolean(await env?.IMAGES?.head(key));
}

async function isKept(key, keeps) {
	try {
		return await keeps(key);
	} catch {
		return false;
	}
}

// The app draws and stores an image as it answers its first request.
async function ensureStored({ key, drawUrl, fetcher, keeps }) {
	if (await isKept(key, keeps)) return true;
	try {
		const response = await fetcher(drawUrl, { signal: AbortSignal.timeout(DRAW_TIMEOUT_MS) });
		await response.arrayBuffer();
	} catch {
		return false;
	}
	return isKept(key, keeps);
}

// { cardUrl, iconUrl } for the bucket's addresses of an issue's email: cardUrl is a string or null, iconUrl a function of a section
// key or null. null for all of it when the images aren't kept in R2 behind a CDN address.
export async function resolveEmailImages({ newsletter, campaign }, { fetcher = (...args) => globalThis.fetch(...args), keeps = hasBoundImage, cdnUrl = process.env.IMAGES_CDN_URL, storage = process.env.IMAGES_STORAGE } = {}) {
	const cdn = String(cdnUrl ?? "").replace(/\/+$/, "");
	if (storage !== "r2" || !/^https:\/\/[^/]+/.test(cdn)) return null;
	const color = getIconColor(newsletter);
	const card = getEmailCard({ newsletter, campaign });
	const cardKey = card ? getCardKey(newsletter._id, getCardHash(newsletter, campaign)) : null;
	const [cardStored, iconsStored] = await Promise.all([
		card ? once(cardKey, () => ensureStored({ key: cardKey, drawUrl: card.url, fetcher, keeps })) : false,
		// Every newsletter of one color shares the icon files.
		once(`icons:${color}`, async () => {
			const stored = await Promise.all(SECTION_ICON_KEYS.map((key) => ensureStored({ key: getIconStorageKey(color, key), drawUrl: getEmailIconUrl(newsletter, key), fetcher, keeps })));
			return stored.every(Boolean);
		}),
	]);
	return {
		cardUrl: cardStored ? `${cdn}/${cardKey}` : null,
		iconUrl: iconsStored ? (key) => `${cdn}/${getIconStorageKey(color, key)}` : null,
	};
}
