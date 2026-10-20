import "server-only";

// The only module that talks to ElevenLabs, with the owner's own account: ELEVENLABS_API_KEY is a Worker secret
// (wrangler secret put), read here and nowhere else, and never logged or put in an error. Tests replace this module with
// tests/stubs/elevenlabs.mjs.
// API shape from elevenlabs.io/docs/api-reference/text-to-speech/convert, read on 2026-10-20: POST /v1/text-to-speech/{voice_id}
// with output_format as a query parameter, a JSON body of text, model_id, previous_request_ids (up to 3), previous_text
// and next_text, and the audio as the response. The request-id response header names a request for request stitching
// (docs: how-to-use-request-stitching): ids older than two hours are no good, and eleven_v3 doesn't take them.
const DEFAULT_BASE = "https://api.elevenlabs.io";
const TIMEOUT_MS = 150_000;
export const MAX_STITCHED_REQUESTS = 3;

export class ElevenLabsError extends Error {
	constructor(message, { status = 0, retryable = false, setup = false } = {}) {
		super(message);
		this.name = "ElevenLabsError";
		this.status = status;
		// A try again may work: ElevenLabs is busy or unreachable. Otherwise the same request would fail the same way.
		this.retryable = retryable;
		// Nothing the writer can fix: the owner's key, plan or credit.
		this.setup = setup;
	}
}

function getBase(env) {
	return String(env.ELEVENLABS_API_BASE ?? "").trim().replace(/\/+$/, "") || DEFAULT_BASE;
}

async function readProblem(response) {
	const body = await response.json().catch(() => null);
	const detail = body?.detail;
	const text = typeof detail === "string" ? detail : (detail?.message ?? detail?.status ?? "");
	return { text: String(text).slice(0, 200), code: String(detail?.status ?? "") };
}

function describe({ status, text, code }) {
	if (status === 401 || status === 403) return { message: "The voice service refused FlockStack's key", setup: true };
	if (code === "quota_exceeded" || status === 402) return { message: "The voice service has no credit left this month", setup: true };
	if (status === 404) return { message: "The voice isn't available at the voice service", setup: true };
	if (status === 429) return { message: "The voice service is busy", retryable: true };
	if (status >= 500) return { message: `The voice service had a problem (${status})`, retryable: true };
	return { message: `The voice service refused this text${text ? `: ${text}` : ""}` };
}

// One request: up to a chunk of text read in the voice. previousRequestIds are the request-id values of the chunks before
// it, previousText and nextText the words around it; the ones the model can't take are left out by the caller.
// Resolves { bytes, requestId }. Throws ElevenLabsError.
export async function synthesizeSpeech({ voiceId, text, modelId, outputFormat, previousRequestIds = [], previousText = "", nextText = "" }, { env = process.env, fetchImpl = fetch } = {}) {
	const apiKey = String(env.ELEVENLABS_API_KEY ?? "").trim();
	if (!apiKey) throw new ElevenLabsError("This server has no voice service key", { setup: true });
	const body = {
		text,
		model_id: modelId,
		...(previousRequestIds.length > 0 ? { previous_request_ids: previousRequestIds.slice(-MAX_STITCHED_REQUESTS) } : previousText && { previous_text: previousText }),
		...(nextText && { next_text: nextText }),
	};
	let response;
	try {
		response = await fetchImpl(`${getBase(env)}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`, {
			method: "POST",
			headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		throw new ElevenLabsError(error?.name === "TimeoutError" ? "The voice service took too long" : "The voice service couldn't be reached", { retryable: true });
	}
	if (!response.ok) {
		const problem = await readProblem(response);
		const { message, retryable = false, setup = false } = describe({ status: response.status, ...problem });
		throw new ElevenLabsError(message, { status: response.status, retryable, setup });
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) throw new ElevenLabsError("The voice service answered with no audio", { retryable: true });
	return { bytes, requestId: response.headers.get("request-id") || null };
}
