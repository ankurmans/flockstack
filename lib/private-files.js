import "server-only";
import { codedError } from "@/lib/account-state";

// Private originals: the digital products buyers download, paid perk files and sponsor images. They live in the R2 bucket bound as FILES
// (wrangler.jsonc), a bucket with no public domain and no r2.dev access, and are only read by the download route after it
// has checked a signed order link or the paid reader session and current perk entitlement. The sponsor asset route separately serves only
// a consented image selected in human-approved creative; approval makes that image public. Ordinary uploaded images use lib/image-storage.js.
export async function getBucket() {
	const { getCloudflareContext } = await import("@opennextjs/cloudflare");
	const { env } = await getCloudflareContext({ async: true });
	if (!env?.FILES) throw codedError({ code: "unavailable", message: "This server has nowhere to keep product files: it needs a private R2 bucket bound as FILES" });
	return env.FILES;
}

function safeFileName(name) {
	const cleaned = String(name ?? "")
		.replace(/[/\\]/g, "-")
		.replace(/[^\w. -]/g, "")
		.trim()
		.replace(/^\.+/, "")
		.slice(-120);
	return cleaned || "download";
}

export function makeProductFileKey({ accountId, productId, fileName }) {
	return `accounts/${accountId}/products/${productId}/${crypto.randomUUID()}-${safeFileName(fileName)}`.replace(/ /g, "-");
}

export { safeFileName };

export async function putPrivateFile(key, bytes, contentType) {
	await (await getBucket()).put(key, bytes, { httpMetadata: { contentType: contentType || "application/octet-stream" } });
}

// The R2 object with its body stream, or null when the key has no file.
export async function getPrivateFile(key) {
	return (await (await getBucket()).get(key)) ?? null;
}

export async function deletePrivateFiles(keys) {
	const list = keys.filter(Boolean);
	if (list.length === 0) return;
	const bucket = await getBucket();
	// R2 deletes up to 1,000 keys a call.
	for (let start = 0; start < list.length; start += 1000) await bucket.delete(list.slice(start, start + 1000));
}
