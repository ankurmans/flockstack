// A 12-byte id as 24 hex characters, shaped like MongoDB's ObjectId, so ids still sort by creation and every id in
// links, signed tokens and the REST API keeps its format. Stored as the hex string.
const HEX = /^[a-f0-9]{24}$/i;

// Like MongoDB's: the time, 5 random bytes fixed for this process, and a 3-byte counter, so ids made in the same
// second still sort in the order they were made.
// Filled on first use: Workers refuse random values while a module loads.
let processBytes = null;
let counter = 0;

function generateHex() {
	if (!processBytes) {
		processBytes = crypto.getRandomValues(new Uint8Array(5));
		counter = new DataView(crypto.getRandomValues(new Uint8Array(4)).buffer).getUint32(0) & 0xffffff;
	}
	const bytes = new Uint8Array(12);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, Math.floor(Date.now() / 1000));
	bytes.set(processBytes, 4);
	counter = (counter + 1) & 0xffffff;
	bytes[9] = counter >> 16;
	bytes[10] = (counter >> 8) & 0xff;
	bytes[11] = counter & 0xff;
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ObjectId {
	#hex;

	constructor(value) {
		if (value === undefined || value === null) this.#hex = generateHex();
		else {
			const hex = String(value instanceof ObjectId ? value.toHexString() : value);
			if (!HEX.test(hex)) throw new TypeError("Argument passed in must be a string of 24 hex characters");
			this.#hex = hex.toLowerCase();
		}
	}

	static isValid(value) {
		if (value instanceof ObjectId) return true;
		return typeof value === "string" && HEX.test(value);
	}

	get _bsontype() {
		return "ObjectId";
	}

	get id() {
		return this.#hex;
	}

	toHexString() {
		return this.#hex;
	}

	toString() {
		return this.#hex;
	}

	toJSON() {
		return this.#hex;
	}

	valueOf() {
		return this.#hex;
	}

	equals(other) {
		return other !== null && other !== undefined && String(other).toLowerCase() === this.#hex;
	}

	getTimestamp() {
		return new Date(parseInt(this.#hex.slice(0, 8), 16) * 1000);
	}

	[Symbol.for("nodejs.util.inspect.custom")]() {
		return `ObjectId('${this.#hex}')`;
	}
}

export const OBJECT_ID_PATTERN = HEX;
