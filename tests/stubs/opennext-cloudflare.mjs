// The Cloudflare bindings of a Worker, in memory: the private R2 bucket digital products live in (FILES). `files` maps each
// key to what was stored, so a test can see what is in the bucket.
export const files = new Map();

const bucket = {
	async put(key, value, options = {}) {
		const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
		files.set(key, { bytes, contentType: options.httpMetadata?.contentType });
	},
	async get(key) {
		const stored = files.get(key);
		if (!stored) return null;
		return {
			key,
			size: stored.bytes.length,
			httpMetadata: { contentType: stored.contentType },
			body: new Response(stored.bytes).body,
			arrayBuffer: async () => stored.bytes.buffer.slice(stored.bytes.byteOffset, stored.bytes.byteOffset + stored.bytes.length),
		};
	},
	async delete(keys) {
		for (const key of Array.isArray(keys) ? keys : [keys]) files.delete(key);
	},
};

export async function getCloudflareContext() {
	return { env: { FILES: bucket } };
}
