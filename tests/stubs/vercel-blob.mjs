// The real module can't load on a Worker (tests/worker-runtime.test.mjs), so a test can see whether anything imported it.
globalThis.vercelBlobLoaded = true;

export const stored = [];
export const deleted = [];

export async function put(pathname, body, options) {
	const suffix = `-${stored.length + 1}`;
	const finalPath = pathname.replace(/(\.\w+)$/, `${suffix}$1`);
	stored.push({ pathname: finalPath, bytes: body.length, options });
	return { url: `https://blob.example.com/${finalPath}`, pathname: finalPath };
}

export async function del(urls) {
	deleted.push(...(Array.isArray(urls) ? urls : [urls]));
}
