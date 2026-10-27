import { hasAudienceBlocks } from "@/lib/audience-blocks";
import "server-only";
import crypto from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { codedError } from "@/lib/account-state";
import { sendAlert } from "@/lib/alerts";
import { PUBLISHED_STATUSES, revalidateArchive } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { listFreeIssueIds } from "@/lib/archive-gate";
import { getIssueDate } from "@/lib/archive-issues";
import {
	AUDIO_CONTEXT_CHARS,
	MAX_AUDIO_CHARACTERS,
	findVoice,
	getAudioFormat,
	getAudioUrl,
	getAudioModel,
	getAudioOffReason,
	getBytesPerSecond,
	getModelInfo,
	getVoices,
	hasElevenLabsKey,
	isAudioEnabled,
} from "@/lib/audio-config";
import { getAudioQuota, reserveCharacters, settleCharacters } from "@/lib/audio-quota";
import { deleteAudioFiles, getAudioFileKey, getAudioPrefix, putJoined, readText, requireStagingStore, statAudioFile } from "@/lib/audio-storage";
import { PODCAST_EPISODE_LIMIT } from "@/lib/audio-feed";
import { estimateMinutes, planAudio } from "@/lib/audio-text";
import { getAppUrl } from "@/lib/config";
import { getPopupSettings, isGatedIssue } from "@/lib/popup-rules";
import { connectDb } from "@/lib/db";
import { ElevenLabsError, MAX_STITCHED_REQUESTS, synthesizeSpeech } from "@/lib/elevenlabs";
import { getAudioLimit, isOnFreeTier } from "@/lib/plans";
import { publishJob } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";
import { emitWebhookEvent } from "@/lib/webhooks";
import { toAudioData } from "@/lib/webhook-events";
import Account from "@/models/Account";
import AudioVersion from "@/models/AudioVersion";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";

// Audio versions of issues, made in the background (chained QStash steps, like lib/post-import.js). A step does one thing:
// read one chunk of the text in the voice and keep the audio, or join the parts into the file. It saves where it got to
// and publishes the next step, so a step is short (one request to the voice service, a few database writes, one R2 write)
// and a step run twice adds nothing: a chunk whose audio is already kept isn't read again.
const LOCK_MS = 10 * 60_000;
const STALE_MS = 60 * 60_000;
// QStash tries a job 4 times in all (the first and three retries, with growing waits): the fourth failing fails the job.
const MAX_ATTEMPTS = 4;
const RESUME_WINDOW_MS = 7 * 24 * 60 * 60_000;
// ElevenLabs asks for request ids no older than two hours; a little less to be safe.
const STITCH_MAX_AGE_MS = 105 * 60_000;
const ACTIVE = ["queued", "running"];

export function getAudioJobUrl() {
	return `${getAppUrl()}/api/jobs/make-audio`;
}

function publishStep(audio) {
	return publishJob({ url: getAudioJobUrl(), body: { accountId: String(audio.accountId), audioId: String(audio._id) } });
}

function audioError(code, message) {
	return codedError({ code, message });
}

// Everything that has to be true before audio is made: the feature is on, the server can reach the voice service, the plan
// has audio. Hidden and refused while AUDIO_ENABLED is off on FlockStack Cloud (lib/audio-config.js).
export function assertAudioAvailable(account) {
	if (!isAudioEnabled()) {
		const reason = getAudioOffReason();
		if (reason) console.info(`[audio] refused: ${reason}`);
		throw audioError("unavailable", "Audio versions aren't available yet");
	}
	if (!hasElevenLabsKey()) throw audioError("unavailable", "Audio versions aren't set up on this server");
	if (getAudioLimit(account) === 0) {
		throw audioError("audio_quota_exceeded", isOnFreeTier(account) ? "Audio versions aren't part of the Free plan: choose a paid plan to make one" : "This account's plan has no audio versions");
	}
}

export function listVoices() {
	return getVoices();
}

function chooseVoice(newsletter, voiceId) {
	const voices = getVoices();
	const wanted = voiceId || newsletter?.audio?.voiceId;
	const voice = wanted ? voices.find(({ id }) => id === wanted) : voices[0];
	if (!voice) throw audioError("validation_failed", wanted ? "voiceId: pick one of the voices list_audio_voices returns" : "No voices are set up");
	return voice;
}

function hashChunks(chunks) {
	return crypto.createHash("sha256").update(chunks.join("\u0000")).digest("hex");
}

export function getAudioScope(campaign) {
	return campaign.audience === "paid" ? "paid" : "public";
}

// What audio of this issue would be and cost, from its text as it is now.
export function previewAudio(campaign) {
	const scope = getAudioScope(campaign);
	const plan = planAudio(campaign, { includePaid: scope === "paid" });
	return { ...plan, scope, textHash: hashChunks(plan.chunks), minutes: estimateMinutes(plan.characters) };
}

export async function findAudio(account, campaignId) {
	if (!isObjectIdString(String(campaignId))) return null;
	await connectDb();
	return AudioVersion.findOne(scoped(account, { campaignId })).lean();
}

// A job that stopped making progress (a lost job, a Worker cut off) holds the issue's audio for ever.
async function failStale(audio) {
	if (!audio || !ACTIVE.includes(audio.status) || new Date(audio.updatedAt).getTime() > Date.now() - STALE_MS) return audio;
	await endJob(audio, { status: "failed", error: "It stopped making progress. Create it again." });
	return AudioVersion.findOne(scoped(audio.accountId, { _id: audio._id })).lean();
}

// A job ends, ready or not: what the voice read is used from the month's quota for good, the rest of what it held goes back.
// Once, whoever gets here first.
async function endJob(audio, { status, error = null, errorPart = null, file = null }) {
	const claimed = await AudioVersion.findOneAndUpdate(scoped(audio.accountId, { _id: audio._id, settledAt: null }), { $set: { settledAt: new Date() } }, { returnDocument: "before" }).lean();
	if (claimed?.month) {
		await settleCharacters(audio.accountId, claimed.month, { reserved: claimed.reserved ?? 0, used: Math.max(0, (claimed.charsDone ?? 0) - (claimed.usedSettled ?? 0)) });
	}
	await AudioVersion.updateOne(scoped(audio.accountId, { _id: audio._id }), {
		$set: { status, finishedAt: new Date(), reserved: 0, ...(claimed && { usedSettled: claimed.charsDone ?? 0 }), ...(error && { error }), ...(errorPart && { errorPart }), ...(file && { file }) },
		$unset: { lockedUntil: 1, ...(status === "ready" && { error: 1, errorPart: 1, state: 1 }) },
	});
}

// Starts the audio version of an issue, or does nothing when it already is that audio. A failed one with the same text,
// voice and model goes on from the parts it kept. Throws coded errors: unavailable, audio_quota_exceeded, validation_failed,
// conflict.
export async function createAudioVersion({ account, user = null, via = "dashboard", campaign, voiceId, emailLink }) {
	assertAudioAvailable(account);
	if (campaign.format === "rich" && hasAudienceBlocks(campaign.html)) throw audioError("validation_failed", "Audio versions are unavailable for issues with audience blocks");
	await connectDb();
	if (!["draft", "scheduled", "held", "sending", "paused", "sent"].includes(campaign.status)) throw audioError("conflict", "A canceled issue has no audio");
	const newsletter = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).lean();
	if (!newsletter) throw audioError("not_found", "Newsletter not found");
	const voice = chooseVoice(newsletter, voiceId);
	const model = getAudioModel();
	const format = getAudioFormat();
	const plan = previewAudio(campaign);
	if (!plan.hasBody || plan.characters === 0) throw audioError("validation_failed", "The issue has no text to read");
	if (plan.characters > MAX_AUDIO_CHARACTERS) {
		throw audioError("validation_failed", `The issue is too long for one audio version: ${plan.characters.toLocaleString("en-US")} characters, the most is ${MAX_AUDIO_CHARACTERS.toLocaleString("en-US")}`);
	}

	let existing = await failStale(await findAudio(account, campaign._id));
	if (existing && ACTIVE.includes(existing.status)) throw audioError("conflict", "The audio version of this issue is being made");
	const same = existing && existing.textHash === plan.textHash && existing.voiceId === voice.id && existing.model === model && existing.format === format && existing.scope === plan.scope;
	if (existing?.status === "ready" && same && existing.file?.key) {
		if (typeof emailLink === "boolean" && emailLink !== Boolean(existing.emailLink)) existing = await setEmailLink(account, existing, emailLink);
		return { audio: existing, created: false };
	}
	const canResume = Boolean(
		existing?.status === "failed" && same && (existing.state?.parts?.length ?? 0) > 0 && Date.now() - new Date(existing.updatedAt).getTime() < RESUME_WINDOW_MS
	);
	const done = canResume ? existing.charsDone : 0;
	const store = await requireStagingStore();

	const month = await reserveCharacters(account, plan.characters - done);
	const fields = {
		newsletterId: campaign.newsletterId,
		userId: user?.id,
		via,
		status: "queued",
		voiceId: voice.id,
		model,
		format,
		scope: plan.scope,
		characters: plan.characters,
		chunks: plan.chunks.length,
		textHash: plan.textHash,
		month,
		reserved: plan.characters - done,
		attempts: 0,
		startedAt: new Date(),
		emailLink: typeof emailLink === "boolean" ? emailLink : Boolean(existing?.emailLink),
		...(canResume ? {} : { state: { parts: [] }, charsDone: 0, usedSettled: 0 }),
	};
	let audio;
	try {
		if (existing) {
			audio = await AudioVersion.findOneAndUpdate(
				scoped(account, { _id: existing._id, status: { $in: ["ready", "failed"] } }),
				{ $set: { ...fields, generation: canResume ? existing.generation : (existing.generation ?? 0) + 1 }, $unset: { error: 1, errorPart: 1, finishedAt: 1, lockedUntil: 1, settledAt: 1 } },
				{ returnDocument: "after" }
			).lean();
			if (!audio) throw audioError("conflict", "The audio version of this issue is being made");
		} else {
			audio = (await AudioVersion.create({ accountId: account._id, campaignId: campaign._id, generation: 1, ...fields })).toObject();
		}
	} catch (error) {
		await settleCharacters(account, month, { reserved: plan.characters - done, used: 0 });
		if (error?.code === 11000) throw audioError("conflict", "The audio version of this issue is being made");
		throw error;
	}
	try {
		if (!canResume) await store.deletePrefix(getAudioPrefix(account._id, audio._id));
		await store.put(`${getAudioPrefix(account._id, audio._id)}chunks.json`, JSON.stringify(plan.chunks));
		await publishStep(audio);
	} catch (error) {
		console.error(`[audio] ${audio._id} could not be queued:`, error?.message);
		await endJob(audio, { status: "failed", error: "The job queue didn't take it. Try again." });
		throw audioError("unavailable", "The job queue didn't take it. Try again.");
	}
	return { audio, created: true };
}

// The Campaign says what an email needs to link to the audio without a query for each reader.
async function syncListen(account, audio) {
	const minutes = audio.emailLink && audio.file?.key ? estimateMinutesOf(audio.file) : null;
	await Campaign.updateOne(scoped(account, { _id: audio.campaignId }), minutes ? { $set: { "listen.minutes": minutes } } : { $unset: { listen: 1 } });
}

export function estimateMinutesOf(file) {
	return Math.max(1, Math.round((file?.seconds ?? 0) / 60));
}

export async function setEmailLink(account, audio, emailLink) {
	if (emailLink && audio.scope === "paid") {
		throw audioError("validation_failed", "An issue for paid subscribers has no public page to link to");
	}
	const updated = await AudioVersion.findOneAndUpdate(scoped(account, { _id: audio._id }), { $set: { emailLink } }, { returnDocument: "after" }).lean();
	await syncListen(account, updated);
	return updated;
}

// Deletes the audio of an issue: its file, what a job left behind, and the email link.
export async function deleteAudioVersion(account, audio) {
	if (ACTIVE.includes(audio.status)) await endJob(audio, { status: "failed", error: "Deleted" });
	await AudioVersion.deleteOne(scoped(account, { _id: audio._id }));
	await Campaign.updateOne(scoped(account, { _id: audio.campaignId }), { $unset: { listen: 1 } });
	await deleteAudioFiles([audio.file?.key]);
	const store = await requireStagingStore().catch(() => null);
	await store?.deletePrefix(getAudioPrefix(account._id, audio._id));
	revalidateArchive();
}

// A deleted draft takes its audio with it. It never fails the delete: the audio would only wait for the account's purge.
export async function deleteAudioOfCampaign(account, campaignId) {
	try {
		const audio = await findAudio(account, campaignId);
		if (audio) await deleteAudioVersion(account, audio);
	} catch (error) {
		console.error(`[audio] The audio of deleted campaign ${campaignId} stays:`, error?.message);
	}
}

function tail(text, length) {
	return text.length <= length ? text : text.slice(text.length - length).replace(/^\S*\s/, "");
}

function head(text, length) {
	return text.length <= length ? text : text.slice(0, length).replace(/\s\S*$/, "");
}

// The request ids that tie a chunk to the ones before it (request stitching): the last three, each fresh enough, and only
// when the chunk right before it has one. Without them the voice hears the end of the previous text instead.
function getContext({ chunks, index, parts, model }) {
	if (!getModelInfo(model).stitching) return { previousRequestIds: [], previousText: "", nextText: "" };
	const nextText = index + 1 < chunks.length ? head(chunks[index + 1], AUDIO_CONTEXT_CHARS) : "";
	if (index === 0) return { previousRequestIds: [], previousText: "", nextText };
	const recent = parts.slice(-MAX_STITCHED_REQUESTS);
	const canStitch = recent.every(({ requestId, at }) => requestId && Date.now() - new Date(at).getTime() < STITCH_MAX_AGE_MS);
	return {
		previousRequestIds: canStitch ? recent.map(({ requestId }) => requestId) : [],
		previousText: canStitch ? "" : tail(chunks[index - 1], AUDIO_CONTEXT_CHARS),
		nextText,
	};
}

async function failJob(audio, error, part = null) {
	const message = String(error?.message ?? error).slice(0, 300);
	const text = part ? `Part ${part} of ${audio.chunks} failed: ${message}` : message;
	await endJob(audio, { status: "failed", error: text, errorPart: part });
	if (error?.setup) {
		await sendAlert({
			accountId: null,
			key: "audio-setup:voice-service",
			title: "Audio versions can't reach the voice service",
			detail: `${message}. Account ${audio.accountId} was told the audio failed.`,
			action: "Check ELEVENLABS_API_KEY, the ElevenLabs plan and its credit. Audio stops working for everyone until it's fixed.",
		});
	}
}

// One step of a job: claims it, does one thing, publishes the next. A step that throws is tried again by QStash; the fourth
// failure in a row fails the job, with the part that failed. A voice service answer that no retry would change fails it at
// once.
export async function runAudioStep({ accountId, audioId }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(audioId))) return { skipped: "invalid job" };
	await connectDb();
	const now = new Date();
	const claimed = await AudioVersion.findOneAndUpdate(
		{ _id: audioId, accountId, status: { $in: ACTIVE }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
		{ $set: { status: "running", lockedUntil: new Date(now.getTime() + LOCK_MS) } },
		{ returnDocument: "after" }
	)
		.lean();
	if (!claimed) {
		const current = await AudioVersion.findOne({ _id: audioId, accountId }).lean();
		return current && ACTIVE.includes(current.status) ? { busy: true } : { skipped: current?.status ?? "not found" };
	}

	const parts = [...(claimed.state?.parts ?? [])];
	const index = parts.length;
	try {
		const account = await Account.findById(claimed.accountId).lean();
		if (!account) throw Object.assign(new Error("the account is gone"), { isFinal: true });
		const store = await requireStagingStore();
		const prefix = getAudioPrefix(claimed.accountId, claimed._id);
		const chunks = JSON.parse((await readText(store, `${prefix}chunks.json`)) ?? "null");
		if (!Array.isArray(chunks) || chunks.length !== claimed.chunks) {
			throw Object.assign(new Error("the text it was making has expired: create the audio version again"), { isFinal: true });
		}
		if (index >= chunks.length) return await finishAudio({ claimed, account, store, prefix, parts });

		const partKey = `${prefix}part-${index}.mp3`;
		const kept = await store.get(partKey);
		let entry;
		if (kept) {
			// Its audio was kept by a step that was cut off before saving: reading it again would cost twice.
			entry = { bytes: kept.size, requestId: null, at: new Date().toISOString(), chars: chunks[index].length };
		} else {
			const context = getContext({ chunks, index, parts, model: claimed.model });
			const { bytes, requestId } = await synthesizeSpeech({
				voiceId: claimed.voiceId,
				text: chunks[index],
				modelId: claimed.model,
				outputFormat: claimed.format,
				...context,
			});
			await store.put(partKey, bytes);
			entry = { bytes: bytes.length, requestId, at: new Date().toISOString(), chars: chunks[index].length };
		}
		parts.push(entry);
		await AudioVersion.updateOne(scoped(claimed.accountId, { _id: claimed._id }), {
			$set: { state: { parts }, charsDone: (claimed.charsDone ?? 0) + entry.chars, attempts: 0 },
			$unset: { lockedUntil: 1 },
		});
		await publishStep(claimed);
		return { continued: { part: index + 1, of: chunks.length } };
	} catch (error) {
		const part = index < claimed.chunks ? index + 1 : null;
		if (error instanceof ElevenLabsError && !error.retryable) {
			await failJob(claimed, error, part);
			return { failed: error.message };
		}
		const attempts = (claimed.attempts ?? 0) + 1;
		if (error?.isFinal || attempts >= MAX_ATTEMPTS) {
			await failJob(claimed, error instanceof ElevenLabsError ? error : error?.isFinal ? error : new Error("Something went wrong on our side. Try again in a few minutes."), part);
			if (!(error instanceof ElevenLabsError) && !error?.isFinal) console.error(`[audio] ${claimed._id} part ${part} failed:`, error);
			return { failed: String(error?.message ?? error) };
		}
		await AudioVersion.updateOne(scoped(claimed.accountId, { _id: claimed._id }), { $set: { attempts }, $unset: { lockedUntil: 1 } });
		throw error;
	}
}

// Every part is kept: they become the one file, its length and size are saved and the issue's page is told.
async function finishAudio({ claimed, account, store, prefix, parts }) {
	const key = getAudioFileKey(claimed.accountId, claimed._id, claimed.generation);
	const total = await putJoined(
		store,
		parts.map((_, index) => `${prefix}part-${index}.mp3`),
		parts.map(({ bytes }) => bytes),
		key
	);
	const stored = await statAudioFile(key);
	if (stored?.size !== total) throw new Error(`the joined file is ${stored?.size ?? "missing"} bytes, not ${total}`);
	const previous = (await AudioVersion.findOne(scoped(account, { _id: claimed._id })).select({ file: 1 }).lean())?.file;
	const file = {
		key,
		bytes: total,
		seconds: Math.round(total / getBytesPerSecond(claimed.format)),
		voiceId: claimed.voiceId,
		scope: claimed.scope,
		characters: claimed.characters,
		textHash: claimed.textHash,
		readyAt: new Date(),
	};
	await endJob(claimed, { status: "ready", file });
	const audio = await AudioVersion.findOne(scoped(account, { _id: claimed._id })).lean();
	if (previous?.key && previous.key !== key) await deleteAudioFiles([previous.key]).catch((error) => console.error("[audio] The old file stays:", error?.message));
	await store.deletePrefix(prefix).catch(() => {});
	await syncListen(account, audio);
	revalidateArchive();
	await emitAudioReady(account, audio);
	return { done: true, bytes: total };
}

async function emitAudioReady(account, audio) {
	await emitWebhookEvent({
		accountId: account._id,
		newsletterId: audio.newsletterId,
		type: "audio.ready",
		data: async () => {
			const campaign = await Campaign.findOne(scoped(account, { _id: audio.campaignId })).select({ subject: 1, archiveSlug: 1, archiveListed: 1, status: 1, audience: 1 }).lean();
			const newsletter = await Newsletter.findOne(scoped(account, { _id: audio.newsletterId })).lean();
			if (!campaign || !newsletter) return null;
			const urls = getArchiveUrls(newsletter);
			const hasPage = Boolean(newsletter.archiveEnabled && campaign.archiveSlug);
			return {
				audio: toAudioData(audio, {
					subject: campaign.subject,
					issueUrl: hasPage ? urls.absolutePost(campaign.archiveSlug) : null,
					audioUrl: hasPage && audio.scope === "public" ? getAudioUrl(urls, campaign.archiveSlug, audio.file) : null,
				}),
			};
		},
	});
}

// What the issue's web page needs to show a player: the file's length, who may hear it and the address. null without audio.
export async function getIssueAudio(newsletter, issue) {
	if (issue.format === "rich" && hasAudienceBlocks(issue.html)) return null;
	await connectDb();
	const audio = await AudioVersion.findOne(scoped(newsletter.accountId, { campaignId: issue._id, "file.key": { $type: "string" } }))
		.select({ file: 1, scope: 1 })
		.lean();
	if (!audio) return null;
	const urls = getArchiveUrls(newsletter);
	return { seconds: audio.file.seconds ?? 0, scope: audio.file.scope ?? audio.scope, src: getAudioUrl(urls, issue.archiveSlug, audio.file) };
}

// The newsletter's podcast episodes, newest first: issues for everyone with public audio, on the website and listed there, and
// open to anyone who finds them.
export async function listPodcastEpisodes(newsletter, { limit = PODCAST_EPISODE_LIMIT } = {}) {
	await connectDb();
	const audios = await AudioVersion.find(scoped(newsletter.accountId, { newsletterId: newsletter._id, "file.scope": "public", "file.key": { $type: "string" } }))
		.sort({ "file.readyAt": -1 })
		.limit(limit * 2)
		.select({ campaignId: 1, file: 1 })
		.lean();
	if (audios.length === 0) return [];
	const issues = await Campaign.find(
		scoped(newsletter.accountId, {
			_id: { $in: audios.map(({ campaignId }) => campaignId) },
			archiveSlug: { $type: "string" },
			archiveListed: { $ne: false },
			status: { $in: PUBLISHED_STATUSES },
			publishTo: { $ne: "email" },
			audience: { $ne: "paid" },
		})
	)
		.select("subject previewText archiveSlug sentAt startedAt audience access format html")
		.lean();
	// An issue the newsletter's gate holds is for signed-in subscribers, so it is no public episode.
	const popup = getPopupSettings(newsletter);
	const freeIds = await listFreeIssueIds(newsletter, popup);
	const byId = new Map(issues.filter((issue) => !(issue.format === "rich" && hasAudienceBlocks(issue.html)) && !isGatedIssue(popup, issue, freeIds)).map((issue) => [String(issue._id), issue]));
	return audios
		.map((audio) => ({ issue: byId.get(String(audio.campaignId)), audio }))
		.filter(({ issue }) => issue)
		.sort((a, b) => (getIssueDate(b.issue) ?? 0) - (getIssueDate(a.issue) ?? 0))
		.slice(0, limit);
}

// Whether audio is on for this account, its numbers and the month's quota: what the dashboard and get_audio_usage show.
export async function getAudioOverview(account) {
	const quota = await getAudioQuota(account);
	return { isOn: isAudioEnabled() && hasElevenLabsKey(), ...quota };
}
