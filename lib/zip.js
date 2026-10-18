// A ZIP writer that streams: every file is stored as it is (no compression, which the images and CSVs of an export
// gain little from), and its size and CRC-32 are known before its bytes are read, so the download never holds a file in
// memory. A ZIP can't hold more than 65,535 files or 4 GiB without ZIP64, so callers split a larger export into
// several (splitIntoVolumes).

export const MAX_VOLUME_BYTES = 3_500_000_000;
export const MAX_VOLUME_FILES = 60_000;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const UTF8_FLAG = 0x0800;
const UNIX_FILE_MODE = (0o100644 << 16) >>> 0;
const VERSION_MADE_BY = (3 << 8) | 20;
const encoder = new TextEncoder();

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();

// Chain it over chunks: crc32(second, crc32(first)) is the CRC-32 of both.
export function crc32(bytes, previous = 0) {
	let crc = ~previous >>> 0;
	for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
	return ~crc >>> 0;
}

function toDosDateTime(date) {
	const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
	const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
	const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
	return { time, day };
}

function localHeader({ name, size, crc }, stamp) {
	const bytes = new Uint8Array(LOCAL_HEADER_BYTES + name.length);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x04034b50, true);
	view.setUint16(4, 20, true);
	view.setUint16(6, UTF8_FLAG, true);
	view.setUint16(8, 0, true);
	view.setUint16(10, stamp.time, true);
	view.setUint16(12, stamp.day, true);
	view.setUint32(14, crc, true);
	view.setUint32(18, size, true);
	view.setUint32(22, size, true);
	view.setUint16(26, name.length, true);
	view.setUint16(28, 0, true);
	bytes.set(name, LOCAL_HEADER_BYTES);
	return bytes;
}

function centralHeader({ name, size, crc, offset }, stamp) {
	const bytes = new Uint8Array(CENTRAL_HEADER_BYTES + name.length);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x02014b50, true);
	view.setUint16(4, VERSION_MADE_BY, true);
	view.setUint16(6, 20, true);
	view.setUint16(8, UTF8_FLAG, true);
	view.setUint16(10, 0, true);
	view.setUint16(12, stamp.time, true);
	view.setUint16(14, stamp.day, true);
	view.setUint32(16, crc, true);
	view.setUint32(20, size, true);
	view.setUint32(24, size, true);
	view.setUint16(28, name.length, true);
	view.setUint32(38, UNIX_FILE_MODE, true);
	view.setUint32(42, offset, true);
	bytes.set(name, CENTRAL_HEADER_BYTES);
	return bytes;
}

function endRecord({ count, size, offset }) {
	const bytes = new Uint8Array(END_RECORD_BYTES);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x06054b50, true);
	view.setUint16(8, count, true);
	view.setUint16(10, count, true);
	view.setUint32(12, size, true);
	view.setUint32(16, offset, true);
	return bytes;
}

// files: [{ path, size, crc }]. What the finished ZIP weighs, for a Content-Length.
export function getZipSize(files) {
	return files.reduce((total, { path, size }) => total + LOCAL_HEADER_BYTES + CENTRAL_HEADER_BYTES + 2 * encoder.encode(path).length + size, END_RECORD_BYTES);
}

// Consecutive files that fit one ZIP. Sizes are what the next file would add, headers included.
export function splitIntoVolumes(files, { maxBytes = MAX_VOLUME_BYTES, maxFiles = MAX_VOLUME_FILES } = {}) {
	const volumes = [[]];
	let bytes = END_RECORD_BYTES;
	for (const file of files) {
		const weight = LOCAL_HEADER_BYTES + CENTRAL_HEADER_BYTES + 2 * encoder.encode(file.path).length + file.size;
		const current = volumes.at(-1);
		if (current.length > 0 && (bytes + weight > maxBytes || current.length >= maxFiles)) {
			volumes.push([]);
			bytes = END_RECORD_BYTES;
		}
		volumes.at(-1).push(file);
		bytes += weight;
	}
	return volumes;
}

// files: [{ path, size, crc }]. read(file) answers an async iterable of the file's Uint8Array chunks, exactly size bytes.
export function createZipStream({ files, read, date = new Date() }) {
	const stamp = toDosDateTime(date);
	const entries = [];
	let index = 0;
	let offset = 0;
	let iterator = null;
	let current = null;
	let remaining = 0;

	function enqueue(controller, bytes) {
		controller.enqueue(bytes);
		offset += bytes.length;
	}

	// A pull has to enqueue something or close the stream, or the reader waits for ever: it loops past the steps that don't.
	return new ReadableStream({
		async pull(controller) {
			for (;;) {
				if (iterator) {
					const { value, done } = await iterator.next();
					if (done) {
						if (remaining !== 0) throw new Error(`${current.path} is ${remaining} bytes short of its size`);
						iterator = null;
						continue;
					}
					remaining -= value.length;
					if (remaining < 0) throw new Error(`${current.path} is longer than its size`);
					enqueue(controller, value);
					return;
				}
				if (index < files.length) {
					current = files[index];
					index += 1;
					const name = encoder.encode(current.path);
					entries.push({ name, size: current.size, crc: current.crc, offset });
					enqueue(controller, localHeader({ name, size: current.size, crc: current.crc }, stamp));
					remaining = current.size;
					iterator = current.size > 0 ? read(current)[Symbol.asyncIterator]() : null;
					return;
				}
				const start = offset;
				for (const entry of entries) enqueue(controller, centralHeader(entry, stamp));
				controller.enqueue(endRecord({ count: entries.length, size: offset - start, offset: start }));
				controller.close();
				return;
			}
		},
		async cancel() {
			await iterator?.return?.();
		},
	});
}

// Chunks of a stream as an async iterable, for read().
export async function* readStream(stream) {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}
