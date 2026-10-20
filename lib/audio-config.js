import { isCloud } from "./config.js";
import { ELEVENLABS_NOTICE_SENT_ON, isElevenLabsNoticeOver } from "./legal.js";

// Audio versions of issues: text to speech through the owner's ElevenLabs account. Everything the owner chooses is an
// environment variable, so switching a model or a voice never needs a deploy of code:
//   ELEVENLABS_API_KEY   secret (wrangler secret put): its value is only read by lib/elevenlabs.js, never logged or shown
//   ELEVENLABS_VOICES    JSON: [{ "id": "...", "name": "...", "description": "...", "previewUrl": "https://..." }]
//   ELEVENLABS_MODEL     default eleven_multilingual_v2
//   ELEVENLABS_OUTPUT_FORMAT  default mp3_44100_128 (an mp3_* format: the parts are joined byte by byte)
//   AUDIO_ENABLED        "true" turns the feature on at FlockStack Cloud, after the sub-processor notice (lib/legal.js)

// Read from elevenlabs.io/docs on 2026-10-20 (models page, text-to-speech convert reference): the characters one request
// takes, and whether request stitching (previous_request_ids) works. Eleven v3 doesn't stitch; a model not listed here is
// treated as the smallest limit with stitching on.
export const AUDIO_MODELS = {
	eleven_multilingual_v2: { maxChars: 10_000, stitching: true },
	eleven_flash_v2_5: { maxChars: 40_000, stitching: true },
	eleven_flash_v2: { maxChars: 30_000, stitching: true },
	eleven_v4: { maxChars: 10_000, stitching: true },
	eleven_v3: { maxChars: 5_000, stitching: false },
};
export const DEFAULT_AUDIO_MODEL = "eleven_multilingual_v2";
export const DEFAULT_AUDIO_FORMAT = "mp3_44100_128";
const UNKNOWN_MODEL = { maxChars: 5_000, stitching: true };

// One request carries this many characters at most, whatever the model allows: a step stays short, and a failure costs a
// small part of the issue.
export const AUDIO_CHUNK_CHARS = 2_500;
// An issue longer than this isn't turned into audio: the parts are joined in one step, and a listener gets an hour.
export const MAX_AUDIO_CHARACTERS = 50_000;
// How much of the next chunk the one before it hears, for the voice to carry on (next_text).
export const AUDIO_CONTEXT_CHARS = 400;

const VOICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_VOICES = 50;

export function getAudioModel(env = process.env) {
	return String(env.ELEVENLABS_MODEL ?? "").trim() || DEFAULT_AUDIO_MODEL;
}

export function getModelInfo(model) {
	return AUDIO_MODELS[model] ?? UNKNOWN_MODEL;
}

// An mp3 format as ElevenLabs names it: mp3_<sample rate>_<kbps>.
export function getAudioFormat(env = process.env) {
	const value = String(env.ELEVENLABS_OUTPUT_FORMAT ?? "").trim();
	return /^mp3_\d{4,5}_\d{2,3}$/.test(value) ? value : DEFAULT_AUDIO_FORMAT;
}

export function getBytesPerSecond(format) {
	const kbps = Number(/_(\d+)$/.exec(format)?.[1]);
	return (Number.isFinite(kbps) && kbps > 0 ? kbps : 128) * 125;
}

function readVoice(entry) {
	if (!entry || typeof entry !== "object") return null;
	const id = String(entry.id ?? "").trim();
	const name = String(entry.name ?? "").trim().slice(0, 60);
	if (!VOICE_ID.test(id) || !name) return null;
	const preview = String(entry.previewUrl ?? entry.preview_url ?? "").trim();
	return {
		id,
		name,
		description: String(entry.description ?? "").trim().slice(0, 200),
		previewUrl: /^https:\/\/[^\s]+$/.test(preview) ? preview : null,
	};
}

// The owner's curated voices, in the order they wrote them. Entries without a usable id or name are left out; bad JSON is
// no voices at all.
export function parseVoices(value) {
	if (!String(value ?? "").trim()) return [];
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const seen = new Set();
	const voices = [];
	for (const entry of parsed) {
		const voice = readVoice(entry);
		if (!voice || seen.has(voice.id)) continue;
		seen.add(voice.id);
		voices.push(voice);
		if (voices.length === MAX_VOICES) break;
	}
	return voices;
}

export function getVoices(env = process.env) {
	return parseVoices(env.ELEVENLABS_VOICES);
}

export function findVoice(voiceId, env = process.env) {
	return getVoices(env).find((voice) => voice.id === voiceId) ?? null;
}

// The day the sub-processor notice went out. Tests set the day themselves (the real one is the owner's to set in lib/legal.js);
// outside a test run only the constant counts.
function getNoticeSentOn(env) {
	return (env.NODE_ENV === "test" && env.ELEVENLABS_NOTICE_SENT_ON_TEST) || ELEVENLABS_NOTICE_SENT_ON;
}

// Why audio versions are off, or null when they are on. Without voices the feature is hidden everywhere. On FlockStack
// Cloud it also waits for AUDIO_ENABLED and for the sub-processor notice to be over (lib/legal.js): a flag turned on
// early stays off, and says why in the logs.
export function getAudioOffReason(env = process.env, now = new Date()) {
	if (getVoices(env).length === 0) return "ELEVENLABS_VOICES is not set";
	if (!isCloud(env)) return null;
	if (env.AUDIO_ENABLED !== "true") return "AUDIO_ENABLED is not true";
	if (!isElevenLabsNoticeOver(now, getNoticeSentOn(env))) return "the 30 days' notice of ElevenLabs as a sub-processor is not over (ELEVENLABS_NOTICE_SENT_ON in lib/legal.js)";
	return null;
}

export function isAudioEnabled(env = process.env, now = new Date()) {
	return getAudioOffReason(env, now) === null;
}

export function hasElevenLabsKey(env = process.env) {
	return Boolean(String(env.ELEVENLABS_API_KEY ?? "").trim());
}

// The address of an issue's audio file. versioned adds the file's version, so a replaced file is fetched again (the audio
// route sends such an address with a year of caching); a podcast feed's enclosure stays a plain address, which podcast
// apps and Apple's validator like best, and tells a new file by its length.
export function getAudioUrl(urls, archiveSlug, file, { versioned = true } = {}) {
	const url = urls.absoluteAudio(archiveSlug);
	return versioned && file?.readyAt ? `${url}?v=${new Date(file.readyAt).getTime()}` : url;
}
