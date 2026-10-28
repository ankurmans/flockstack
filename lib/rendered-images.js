import "server-only";
import { getImageStorage } from "@/lib/image-storage";

// Images the app draws itself (share cards, section icons: docs/VISUALS-DESIGN.md), kept in the IMAGES bucket under a name made
// from what they show, so each is drawn once. Only R2 keeps them: on S3 or Vercel Blob they are drawn on every request.
const inFlight = new Map();

async function getBucket() {
	if (getImageStorage() !== "r2") return null;
	const { getCloudflareContext } = await import("@opennextjs/cloudflare");
	const { env } = await getCloudflareContext({ async: true });
	return env?.IMAGES ?? null;
}

async function readStored(key) {
	const bucket = await getBucket().catch(() => null);
	const object = await bucket?.get(key).catch(() => null);
	return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

// A store that fails still answers with the image: the next request draws it again.
async function store(key, bytes) {
	const bucket = await getBucket().catch(() => null);
	await bucket?.put(key, bytes, { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" } }).catch((error) => {
		console.error(`Couldn't store ${key}`, error);
	});
}

// The stored image, else draw() made once per key in this isolate however many requests ask at the same time, stored, and
// returned. stored tells the caller which it was.
export async function getRenderedImage(key, draw) {
	const stored = await readStored(key);
	if (stored) return { bytes: stored, stored: true };
	if (!inFlight.has(key)) {
		const drawing = (async () => {
			const bytes = await draw();
			await store(key, bytes);
			return bytes;
		})().finally(() => inFlight.delete(key));
		inFlight.set(key, drawing);
	}
	return { bytes: await inFlight.get(key), stored: false };
}
