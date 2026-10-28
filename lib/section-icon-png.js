import { MASK_SIZE, SECTION_ICON_MASKS } from "./section-icon-masks.js";

// A section icon as a PNG in one color: its mask (scripts/make-section-icon-masks.mjs) as the alpha channel. Written here byte by
// byte, because next/og draws an SVG image blank on Cloudflare Workers; the email's icons and the share card's both use it.
export const ICON_PNG_SIZE = MASK_SIZE;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

// zlib's format, which PNG's image data is in: CompressionStream runs in Workers and Node alike.
async function deflate(bytes) {
	return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
}

function decodeBase64(text) {
	return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

// key: a section icon key (an unknown one draws generic). color: #rrggbb. A PNG's bytes.
export async function sectionIconPng(key, color) {
	const mask = decodeBase64(SECTION_ICON_MASKS[key] ?? SECTION_ICON_MASKS.generic);
	const [red, green, blue] = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
	const rows = new Uint8Array(MASK_SIZE * (1 + MASK_SIZE * 4));
	for (let y = 0; y < MASK_SIZE; y++) {
		const row = y * (1 + MASK_SIZE * 4);
		for (let x = 0; x < MASK_SIZE; x++) rows.set([red, green, blue, mask[y * MASK_SIZE + x]], row + 1 + x * 4);
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, MASK_SIZE);
	view.setUint32(4, MASK_SIZE);
	header.set([8, 6, 0, 0, 0], 8);
	const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk("IHDR", header), chunk("IDAT", await deflate(rows)), chunk("IEND", new Uint8Array())];
	const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		png.set(part, at);
		at += part.length;
	}
	return png;
}

export async function sectionIconDataUri(key, color) {
	const png = await sectionIconPng(key, color);
	let binary = "";
	for (const byte of png) binary += String.fromCharCode(byte);
	return `data:image/png;base64,${btoa(binary)}`;
}
