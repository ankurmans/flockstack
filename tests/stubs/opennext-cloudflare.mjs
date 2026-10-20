// The Cloudflare bindings of a Worker, in memory: the private R2 bucket digital products live in (FILES), and Workers AI
// (AI) once a test sets one. `files` maps each key to what was stored, so a test can see what is in the bucket.
export const files = new Map();

const bucket = {
	async put(key, value, options = {}) {
		const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
		files.set(key, { bytes, contentType: options.httpMetadata?.contentType });
	},
	async get(key, options = {}) {
		const stored = files.get(key);
		if (!stored) return null;
		const { offset = 0, length = stored.bytes.length - offset } = options.range ?? {};
		const bytes = stored.bytes.subarray(offset, offset + length);
		return {
			key,
			size: stored.bytes.length,
			httpMetadata: { contentType: stored.contentType },
			body: new Response(bytes).body,
			arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
		};
	},
	async head(key) {
		const stored = files.get(key);
		return stored ? { key, size: stored.bytes.length, httpMetadata: { contentType: stored.contentType } } : null;
	},
	async list({ prefix = "" } = {}) {
		return { objects: [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
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
