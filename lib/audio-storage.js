import "server-only";
import { getExportStore } from "@/lib/export-storage";
import { getBucket } from "@/lib/private-files";

// Where audio waits and where it lives. The parts the voice reads wait in the private EXPORTS bucket, whose lifecycle rule
// deletes whatever a job leaves behind after 8 days. The finished MP3 is a private object in FILES, which nothing serves but
// the audio routes (they check who may hear it). Both buckets are the region's own.
export const AUDIO_CONTENT_TYPE = "audio/mpeg";

export function getAudioPrefix(accountId, audioId) {
	return `audio/${accountId}/${audioId}/`;
}

export function getAudioFileKey(accountId, audioId, generation) {
	return `accounts/${accountId}/audio/${audioId}-g${generation}.mp3`;
}

export async function requireStagingStore() {
	const store = await getExportStore();
	if (!store) throw Object.assign(new Error("This server has nowhere to keep audio while it is made: it needs a private R2 bucket bound as EXPORTS"), { code: "unavailable" });
	return store;
}

export async function readText(store, key) {
	const object = await store.get(key);
	return object ? new Response(object.body).text() : null;
}

// The parts, in order, as one object. R2 takes a stream of known length (FixedLengthStream), so the file never sits in the
// Worker's memory; where there is no such stream (tests, Node), it is joined in memory.
export async function putJoined(store, partKeys, sizes, key) {
	const bucket = await getBucket();
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (typeof globalThis.FixedLengthStream === "function") {
		const { readable, writable } = new globalThis.FixedLengthStream(total);
		const stored = bucket.put(key, readable, { httpMetadata: { contentType: AUDIO_CONTENT_TYPE } });
		const pump = (async () => {
			try {
				for (const partKey of partKeys) {
					const part = await store.get(partKey);
					if (!part) throw new Error(`audio part ${partKey} is gone`);
					await part.body.pipeTo(writable, { preventClose: true });
				}
				await writable.close();
			} catch (error) {
				await writable.abort(error).catch(() => {});
				throw error;
			}
		})();
		await Promise.all([stored, pump]);
		return total;
	}
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const partKey of partKeys) {
		const part = await store.get(partKey);
		if (!part) throw new Error(`audio part ${partKey} is gone`);
		const bytes = new Uint8Array(await new Response(part.body).arrayBuffer());
		joined.set(bytes, offset);
		offset += bytes.length;
	}
	await bucket.put(key, joined, { httpMetadata: { contentType: AUDIO_CONTENT_TYPE } });
	return total;
}

// { size } or null.
export async function statAudioFile(key) {
	const object = await (await getBucket()).head(key);
	return object ? { size: object.size } : null;
}

// The object with its body, all of it or a byte range ({ start, end }, both included): { size, body } or null. size is the
// whole file's.
export async function readAudioFile(key, range = null) {
	const object = await (await getBucket()).get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
	return object ? { size: object.size, body: object.body } : null;
}

export async function deleteAudioFiles(keys) {
	const list = keys.filter(Boolean);
	if (list.length > 0) await (await getBucket()).delete(list);
}

// Everything an account's audio left in storage, for the purge of a deleted account.
export async function removeAccountAudioFiles(accountId) {
	const store = await getExportStore();
	await store?.deletePrefix(`audio/${accountId}/`);
	const bucket = await getBucket().catch(() => null);
	if (!bucket) return;
	let cursor;
	do {
		const page = await bucket.list({ prefix: `accounts/${accountId}/audio/`, cursor, limit: 1000 });
		if (page.objects.length > 0) await bucket.delete(page.objects.map(({ key }) => key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}
