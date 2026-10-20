// Reads the files of a ZIP from its central directory, as unzip tools do: stored files as they are, deflated ones through
// DecompressionStream, which Workers and Node both have. Only the files `accept` takes are read, and their sizes after
// decompression count against maxBytes, so a small ZIP that expands into gigabytes stops early. No ZIP64: exports this
// reads are far under 4 GB.
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const MAX_COMMENT = 0xffff;

function zipError(message) {
	return Object.assign(new Error(message), { code: "validation_failed" });
}

export function isZip(bytes) {
	return bytes?.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function findEnd(view, length) {
	for (let offset = length - 22; offset >= Math.max(0, length - 22 - MAX_COMMENT); offset -= 1) {
		if (view.getUint32(offset, true) === END_OF_DIRECTORY) return offset;
	}
	return -1;
}

async function inflate(bytes, maxBytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	const chunks = [];
	let size = 0;
	for await (const chunk of stream) {
		size += chunk.length;
		if (size > maxBytes) throw zipError("The ZIP file expands to more than an export should");
		chunks.push(chunk);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

// A Map of each accepted file's path to its bytes.
export async function readZipFiles(bytes, { accept = () => true, maxBytes = Number.POSITIVE_INFINITY } = {}) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = findEnd(view, bytes.length);
	if (end < 0) throw zipError("This isn't a ZIP file, or it's cut short");
	const count = view.getUint16(end + 10, true);
	let cursor = view.getUint32(end + 16, true);
	const decoder = new TextDecoder();
	const files = new Map();
	let total = 0;
	for (let index = 0; index < count; index += 1) {
		if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== DIRECTORY_ENTRY) throw zipError("The ZIP file is damaged");
		const method = view.getUint16(cursor + 10, true);
		const compressedSize = view.getUint32(cursor + 20, true);
		const nameLength = view.getUint16(cursor + 28, true);
		const extraLength = view.getUint16(cursor + 30, true);
		const commentLength = view.getUint16(cursor + 32, true);
		const localOffset = view.getUint32(cursor + 42, true);
		const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
		cursor += 46 + nameLength + extraLength + commentLength;
		if (name.endsWith("/") || !accept(name)) continue;

		if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_HEADER) throw zipError("The ZIP file is damaged");
		const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
		const data = bytes.subarray(start, start + compressedSize);
		let content;
		if (method === 0) content = data;
		else if (method === 8) content = await inflate(data, maxBytes - total);
		else throw zipError("The ZIP file uses a compression FlockStack can't read: save it again with your system's zip tool");
		total += content.length;
		if (total > maxBytes) throw zipError("The ZIP file expands to more than an export should");
		files.set(name, content);
	}
	return files;
}
