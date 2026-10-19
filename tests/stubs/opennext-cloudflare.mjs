// The Cloudflare bindings of a Worker, in memory: the private R2 bucket digital products live in (FILES), and Workers AI
// (AI) once a test sets one. `files` maps each key to what was stored, so a test can see what is in the bucket.
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

// request.cf, the visitor's data Cloudflare adds to a request: set it to { country: "IE" } for a test.
let cf;

export function setCf(value) {
	cf = value;
}

// Workers AI: an object with run(model, input, options), as the binding has, or null for a Worker without it.
let ai = null;

export function setAi(value) {
	ai = value;
}

// false: a server without the FILES bucket.
let hasFiles = true;

export function setFilesBound(value) {
	hasFiles = value;
}

export async function getCloudflareContext() {
	return { env: { ...(hasFiles && { FILES: bucket }), ...(ai && { AI: ai }) }, cf };
}
