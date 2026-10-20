// ElevenLabs, answered from memory: tests choose what the voice service does and read what it was asked. Every request
// is kept in `requests`; the audio it answers is 16 bytes a character (1 ms at mp3_44100_128's 16,000 bytes a second),
// filled with the request's number so a test can tell which part is where in a joined file.
export const MAX_STITCHED_REQUESTS = 3;

export class ElevenLabsError extends Error {
	constructor(message, { status = 0, retryable = false, setup = false } = {}) {
		super(message);
		this.name = "ElevenLabsError";
		this.status = status;
		this.retryable = retryable;
		this.setup = setup;
	}
}

export const requests = [];
let behavior = null;

// behavior(request, number) may return nothing (the default audio), { requestId } or throw; null restores the default.
export function setVoiceBehavior(next) {
	behavior = next;
}

export function resetVoice() {
	requests.length = 0;
	behavior = null;
}

export async function synthesizeSpeech(params) {
	const number = requests.length + 1;
	requests.push({ ...params, number });
	const answer = (await behavior?.(params, number)) ?? {};
	const bytes = new Uint8Array(params.text.length * 16).fill(number);
	return { bytes, requestId: Object.hasOwn(answer, "requestId") ? answer.requestId : `req_${number}` };
}
