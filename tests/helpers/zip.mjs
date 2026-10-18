import assert from "node:assert/strict";
import zlib from "node:zlib";

// Reads a stored (uncompressed) ZIP the way an unzip tool does: from the central directory at its end, checking each
// file's CRC-32 against its bytes. Answers a Map of path to Buffer.
export function readZip(buffer) {
	const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	assert.ok(end >= 0, "the ZIP ends with its end-of-directory record");
	const count = buffer.readUInt16LE(end + 10);
	const directorySize = buffer.readUInt32LE(end + 12);
	const directoryOffset = buffer.readUInt32LE(end + 16);
	assert.equal(directoryOffset + directorySize, end, "the central directory runs up to the end record");

	const files = new Map();
	let cursor = directoryOffset;
	for (let index = 0; index < count; index += 1) {
		assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, "a central directory entry");
		const method = buffer.readUInt16LE(cursor + 10);
		const crc = buffer.readUInt32LE(cursor + 16);
		const size = buffer.readUInt32LE(cursor + 24);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
		assert.equal(method, 0, `${name} is stored`);

		assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `${name} has a local header`);
		const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
		const bytes = buffer.subarray(start, start + size);
		assert.equal(zlib.crc32(bytes), crc, `${name} matches its CRC-32`);
		assert.equal(buffer.readUInt32LE(localOffset + 14), crc, `${name}'s local header agrees`);
		files.set(name, bytes);
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return files;
}

export async function readResponseBytes(response) {
	return Buffer.from(await response.arrayBuffer());
}
