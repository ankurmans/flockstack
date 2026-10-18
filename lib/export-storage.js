import "server-only";

// Where an export's files wait for the download: a private R2 bucket bound as EXPORTS, apart from the images' bucket,
// which is public. EXPORT_STORAGE=memory keeps them in the server's memory, for tests.
const LIST_PAGE = 1000;

export const memoryObjects = new Map();

function toStream(bytes) {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function createMemoryStore() {
	return {
		async put(key, bytes) {
			memoryObjects.set(key, typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
		},
		async get(key) {
			const bytes = memoryObjects.get(key);
			return bytes ? { size: bytes.length, body: toStream(bytes) } : null;
		},
		async deletePrefix(prefix) {
			for (const key of [...memoryObjects.keys()]) if (key.startsWith(prefix)) memoryObjects.delete(key);
		},
	};
}

async function getBucket() {
	const { getCloudflareContext } = await import("@opennextjs/cloudflare");
	const { env } = await getCloudflareContext({ async: true });
	return env?.EXPORTS ?? null;
}

function createR2Store(bucket) {
	return {
		put: (key, bytes) => bucket.put(key, bytes),
		async get(key) {
			const object = await bucket.get(key);
			return object ? { size: object.size, body: object.body } : null;
		},
		async deletePrefix(prefix) {
			let cursor;
			do {
				const page = await bucket.list({ prefix, cursor, limit: LIST_PAGE });
				if (page.objects.length > 0) await bucket.delete(page.objects.map(({ key }) => key));
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
		},
	};
}

// null while the server has nowhere to keep exports.
export async function getExportStore() {
	if (process.env.EXPORT_STORAGE === "memory") return createMemoryStore();
	try {
		const bucket = await getBucket();
		return bucket ? createR2Store(bucket) : null;
	} catch {
		return null;
	}
}

export function getExportPrefix(accountId, exportId) {
	return `exports/${accountId}/${exportId}/`;
}
