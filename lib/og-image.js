import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchRemoteImage } from "@/lib/remote-image";

// A logo is small; this leaves room for a large PNG without letting the card pull down a big file.
const MAX_LOGO_BYTES = 8 * 1024 * 1024;

// The card renderer only decodes PNG and JPEG. A remote logo is a URL the account set, so it's
// downloaded through the same guard as uploads (https only, never a private, loopback or link-local
// address, redirects re-checked), so the card can't make the server fetch an internal address.
async function loadImage(url) {
	const buffer = url.startsWith("/")
		? await readFile(join(process.cwd(), "public", url)).catch(() => null)
		: await fetchRemoteImage(url, { maxBytes: MAX_LOGO_BYTES })
				.then((bytes) => Buffer.from(bytes))
				.catch(() => null);
	if (!buffer) return null;
	const type = buffer[0] === 0x89 && buffer[1] === 0x50 ? "png" : buffer[0] === 0xff && buffer[1] === 0xd8 ? "jpeg" : null;
	return type && `data:image/${type};base64,${buffer.toString("base64")}`;
}

// The card renderer can't decode WebP, so a WebP logo uses the PNG saved next to it.
export async function readLogo(imageUrl) {
	if (!imageUrl) return null;
	return (await loadImage(imageUrl.replace(/\.webp$/i, ".png"))) ?? loadImage(imageUrl);
}

export { loadImage };
