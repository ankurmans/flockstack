import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { PUBLISHED_STATUSES, revalidateArchive } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { MAX_AUDIO_CHARACTERS, getAudioUrl, hasElevenLabsKey, isAudioEnabled } from "@/lib/audio-config";
import { PODCAST_CATEGORIES } from "@/lib/podcast-categories";
import { assertAudioAvailable, createAudioVersion, deleteAudioVersion, findAudio, listVoices, previewAudio, setEmailLink } from "@/lib/audio";
import { getAudioQuota } from "@/lib/audio-quota";
import { formatNumber } from "@/lib/format";
import { isObjectIdString } from "@/lib/validation";
import { AUDIO_SCOPES, AUDIO_STATUSES } from "@/models/AudioVersion";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";

const GROUP = "Audio versions";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const campaignInput = idInput("issue's (campaign's)");

const FileSchema = z.object({
	url: z.string().nullable().describe("The MP3 everyone can play, for an issue with a web page that isn't for paid subscribers only. null otherwise: paid readers play it on the issue's page."),
	seconds: z.number().int().describe("Its length, from its size at the bit rate"),
	bytes: z.number().int(),
	voiceId: z.string(),
	scope: z.enum(AUDIO_SCOPES).describe("public: the part of the issue everyone reads. paid: the whole of an issue for paid subscribers only."),
	readyAt: dateOutput,
});

const AudioSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	campaignId: z.string(),
	status: z
		.enum(AUDIO_STATUSES)
		.describe("queued and running: being made. ready: file has the audio. failed: error says what and errorPart which part; file is still the earlier audio, if there was one."),
	voiceId: z.string().describe("The voice of the audio being made or last made"),
	scope: z.enum(AUDIO_SCOPES),
	characters: z.number().int().describe("Characters read for this audio: what counts against the month's quota"),
	progress: z.object({ done: z.number().int(), total: z.number().int() }).describe("Parts read so far"),
	error: z.string().nullable(),
	errorPart: z.number().int().nullable(),
	emailLink: z.boolean().describe("Emails of the issue open with a link to listen"),
	outOfDate: z.boolean().describe("The issue's text changed after the audio was made: create_audio_version makes it again, replacing the audio"),
	file: FileSchema.nullable(),
	createdAt: dateOutput,
	finishedAt: dateOutput,
});

const EstimateSchema = z.object({
	characters: z.number().int().describe("What the audio would read: this counts against the month's quota"),
	minutes: z.number().int().describe("About how long it would play"),
	scope: z.enum(AUDIO_SCOPES),
	tooLong: z.boolean().describe(`The issue is over ${formatNumber(MAX_AUDIO_CHARACTERS)} characters, the most one audio version takes`),
	hasText: z.boolean(),
	wouldExceed: z.boolean().describe("This month has fewer characters left than it needs: create_audio_version would be refused"),
	message: z.string().describe("What to tell the writer before they start, e.g. \"This will use about 9,200 of your 150,000 characters this month.\""),
});

async function requireCampaign(account, id) {
	const campaign = isObjectIdString(id) ? await Campaign.findOne(scoped(account, { _id: id })).lean() : null;
	if (!campaign || campaign.status === "canceled") throw actionError("not_found", "Campaign not found");
	return campaign;
}

function round(value, step) {
	return Math.round(value / step) * step;
}

function describeEstimate({ characters, quota }) {
	const about = formatNumber(round(characters, characters >= 1000 ? 100 : 10));
	if (quota.limit === null) return `This will read about ${about} characters.`;
	const base = `This will use about ${about} of your ${formatNumber(quota.limit)} characters this month.`;
	return characters > (quota.left ?? 0) ? `${base} Only ${formatNumber(quota.left ?? 0)} are left, so it can't be made until the count starts over on the 1st.` : base;
}

async function getEstimate(account, plan) {
	const quota = await getAudioQuota(account);
	return {
		characters: plan.characters,
		minutes: plan.minutes,
		scope: plan.scope,
		tooLong: plan.characters > MAX_AUDIO_CHARACTERS,
		hasText: plan.hasBody,
		wouldExceed: quota.limit !== null && plan.characters > (quota.left ?? 0),
		message: describeEstimate({ characters: plan.characters, quota }),
	};
}

function toAudio(audio, { campaign, newsletter, textHash }) {
	const file = audio.file?.key ? audio.file : null;
	const urls = getArchiveUrls(newsletter);
	const hasPage = Boolean(newsletter.archiveEnabled && campaign.archiveSlug && PUBLISHED_STATUSES.includes(campaign.status) && campaign.publishTo !== "email");
	return {
		id: String(audio._id),
		newsletterId: String(audio.newsletterId),
		campaignId: String(audio.campaignId),
		status: audio.status,
		voiceId: audio.voiceId,
		scope: audio.scope,
		characters: audio.characters ?? 0,
		progress: { done: audio.status === "ready" ? (audio.chunks ?? 0) : (audio.state?.parts?.length ?? 0), total: audio.chunks ?? 0 },
		error: audio.error ?? null,
		errorPart: audio.errorPart ?? null,
		emailLink: Boolean(audio.emailLink),
		outOfDate: Boolean(file && textHash && file.textHash !== textHash),
		file: file && {
			url: hasPage && file.scope === "public" ? getAudioUrl(urls, campaign.archiveSlug, file) : null,
			seconds: file.seconds ?? 0,
			bytes: file.bytes ?? 0,
			voiceId: file.voiceId,
			scope: file.scope,
			readyAt: toIso(file.readyAt),
		},
		createdAt: toIso(audio.createdAt),
		finishedAt: toIso(audio.finishedAt),
	};
}

async function loadView(account, campaign, audio, plan = previewAudio(campaign)) {
	const newsletter = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).lean();
	return toAudio(audio, { campaign, newsletter, textHash: plan.textHash });
}

const listVoicesAction = defineAction({
	name: "list_audio_voices",
	title: "List audio voices",
	group: GROUP,
	description: "Lists the voices an audio version can be read in, set by whoever runs the server: each has an ID, a name, a short description and a preview URL to listen to a sample. enabled is false, with no voices, while audio versions are off on this server.",
	http: { method: "GET", path: "/audio-voices" },
	readOnly: true,
	input: z.object({}),
	output: z.object({
		enabled: z.boolean(),
		voices: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), previewUrl: z.string().nullable().describe("A recording of the voice: playing it costs nothing") })),
	}),
	handler: async () => ({ enabled: isAudioEnabled() && hasElevenLabsKey(), voices: isAudioEnabled() ? listVoices() : [] }),
});

const getAudioUsageAction = defineAction({
	name: "get_audio_usage",
	title: "Get audio usage",
	group: GROUP,
	description:
		"Gets the characters of audio the account has used this month and how many are left. Audio is counted by the character read, per calendar month in UTC, and refused when an audio version would go past what the plan has left: there is no overage. Send campaign to get what making that issue's audio would cost, before creating it.",
	http: { method: "GET", path: "/audio-usage" },
	readOnly: true,
	input: z.object({ campaign: z.string().trim().max(100).optional().describe("An issue's ID, for what its audio would cost") }),
	output: z.object({
		enabled: z.boolean(),
		month: z.string().describe("The month counted, e.g. 2026-10"),
		limit: z.number().int().nullable().describe("The characters the plan allows a month. null on a self-hosted server: no limit"),
		used: z.number().int(),
		reserved: z.number().int().describe("Held for audio versions still being made"),
		left: z.number().int().nullable(),
		resetsAt: dateOutput,
		estimate: EstimateSchema.nullable(),
	}),
	handler: async ({ account, input }) => {
		const quota = await getAudioQuota(account);
		const estimate = input.campaign ? await getEstimate(account, previewAudio(await requireCampaign(account, input.campaign))) : null;
		return {
			enabled: isAudioEnabled() && hasElevenLabsKey(),
			month: quota.month,
			limit: quota.limit,
			used: quota.used,
			reserved: quota.reserved,
			left: quota.left,
			resetsAt: toIso(quota.resetsAt),
			estimate,
		};
	},
});

const createAudioVersionAction = defineAction({
	name: "create_audio_version",
	title: "Create an audio version",
	group: GROUP,
	description: `Makes an audio version of an issue, draft or sent, in the background. Rich issues with audience blocks are refused because one shared MP3 cannot enforce block tiers: its text is read aloud in the chosen voice and saved as an MP3, replacing the issue's earlier audio when it is made again. Headings and list items are read as sentences, links as their text, footnotes at the end; pictures, embeds, tables and code are left out. An issue for everyone has its audio read up to the paywall break; an issue for paid subscribers only is read whole and played to paid readers only. The characters read count against the month's quota (get_audio_usage says what is left, and what this issue needs), and the call is refused before anything is read when they don't fit. A failed audio version counts only the characters actually read. Up to ${formatNumber(MAX_AUDIO_CHARACTERS)} characters. Without changes since the last audio, nothing is read again. get_audio_version follows it; the audio.ready webhook announces it.`,
	http: { method: "POST", path: "/audio-versions", status: 202 },
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	example: { campaign: "6650f1c2e9b1d4a0123456bb" },
	input: z.object({
		campaign: campaignInput,
		voiceId: z.string().trim().max(100).optional().describe("One of the IDs list_audio_voices returns. Default: the newsletter's voice (update_audio_settings), else the first voice."),
		emailLink: z.boolean().optional().describe("Open the issue's emails with \"Listen to this issue\", linking to the player on its web page. Only for an issue with a web page that isn't for paid subscribers only."),
	}),
	output: AudioSchema.extend({ created: z.boolean().describe("False when the issue's audio was already up to date and nothing was read") }),
	handler: async ({ account, user, via, input }) => {
		assertAudioAvailable(account);
		const campaign = await requireCampaign(account, input.campaign);
		const { audio, created } = await createAudioVersion({ account, user, via, campaign, voiceId: input.voiceId, emailLink: input.emailLink });
		return { ...(await loadView(account, campaign, audio)), created };
	},
});

const getAudioVersionAction = defineAction({
	name: "get_audio_version",
	title: "Get an audio version",
	group: GROUP,
	description: "Gets the audio version of an issue: its status and progress, the error and the part that failed when it failed, the file once ready, and whether the issue changed since. estimate is what making it again would read and cost against the month's quota. audio is null for an issue without one.",
	http: { method: "GET", path: "/audio-versions/{id}" },
	readOnly: true,
	input: z.object({ id: campaignInput }),
	output: z.object({ audio: AudioSchema.nullable(), estimate: EstimateSchema.nullable() }),
	handler: async ({ account, input }) => {
		const campaign = await requireCampaign(account, input.id);
		const audio = await findAudio(account, campaign._id);
		const plan = previewAudio(campaign);
		return { audio: audio ? await loadView(account, campaign, audio, plan) : null, estimate: isAudioEnabled() ? await getEstimate(account, plan) : null };
	},
});

const updateAudioVersionAction = defineAction({
	name: "update_audio_version",
	title: "Update an audio version",
	group: GROUP,
	description: "Turns the \"Listen to this issue\" link at the top of the issue's emails on or off. It shows the audio's length and opens the player on the issue's web page, and only appears in emails sent after the audio is ready. Nothing is read again.",
	http: { method: "PATCH", path: "/audio-versions/{id}" },
	idempotent: true,
	input: z.object({ id: campaignInput, emailLink: z.boolean().describe("Show the link in the issue's emails") }),
	output: AudioSchema,
	handler: async ({ account, input }) => {
		const campaign = await requireCampaign(account, input.id);
		const audio = await findAudio(account, campaign._id);
		if (!audio) throw actionError("not_found", "This issue has no audio version");
		return loadView(account, campaign, await setEmailLink(account, audio, input.emailLink));
	},
});

const deleteAudioVersionAction = defineAction({
	name: "delete_audio_version",
	title: "Delete an audio version",
	group: GROUP,
	description: "Deletes the audio version of an issue: the file goes, the issue's page loses its player, its episode leaves the podcast feed and the emails' link goes. The characters it used stay counted in the month. One still being made is stopped, counting only what was read.",
	http: { method: "DELETE", path: "/audio-versions/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: campaignInput }),
	output: z.object({ deleted: z.boolean() }),
	handler: async ({ account, input }) => {
		const campaign = await requireCampaign(account, input.id);
		const audio = await findAudio(account, campaign._id);
		if (!audio) return { deleted: false };
		await deleteAudioVersion(account, audio);
		return { deleted: true };
	},
});

const SettingsSchema = z.object({
	newsletterId: z.string(),
	voiceId: z.string().nullable().describe("The newsletter's default voice; null follows the first of the voices"),
	podcast: z.object({
		enabled: z.boolean().describe("The newsletter's podcast feed answers; off, it answers 404"),
		feedUrl: z.string().describe("Where podcast apps subscribe"),
		category: z.string().describe("Apple Podcasts' category"),
		explicit: z.boolean(),
		ownerEmail: z.string().nullable().describe("Printed in the feed for Apple Podcasts and Spotify to verify the show's owner"),
	}),
});

function toSettings(newsletter) {
	const podcast = newsletter.audio?.podcast ?? {};
	return {
		newsletterId: String(newsletter._id),
		voiceId: newsletter.audio?.voiceId ?? null,
		podcast: {
			enabled: Boolean(podcast.enabled),
			feedUrl: getArchiveUrls(newsletter).podcast,
			category: podcast.category || "News",
			explicit: Boolean(podcast.explicit),
			ownerEmail: podcast.ownerEmail ?? null,
		},
	};
}

const getAudioSettingsAction = defineAction({
	name: "get_audio_settings",
	title: "Get audio settings",
	group: GROUP,
	description: "Gets a newsletter's audio settings: its default voice and its podcast feed (on or off, its address, category, explicit flag and owner email). The feed lists the issues that have audio and are for everyone; an issue for paid subscribers only is never in it.",
	http: { method: "GET", path: "/audio-settings" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: SettingsSchema,
	handler: async ({ account, input }) => toSettings(await findNewsletter(account, input.newsletter)),
});

const updateAudioSettingsAction = defineAction({
	name: "update_audio_settings",
	title: "Update audio settings",
	group: GROUP,
	description: "Changes a newsletter's audio settings: its default voice (one of list_audio_voices), and its podcast feed, served at /podcast.xml on the newsletter's website: turn it on, set the category, the explicit flag and an owner email. Only the fields sent change. An empty voiceId or ownerEmail clears it. The feed needs the website on and the newsletter's logo as cover art; Apple Podcasts wants it at least 1400 by 1400 pixels.",
	http: { method: "PATCH", path: "/audio-settings" },
	idempotent: true,
	input: z.object({
		newsletter: newsletterInput,
		voiceId: z.string().trim().max(100).optional().describe("The default voice, or an empty string to follow the first of the voices"),
		podcastEnabled: z.boolean().optional().describe("Turn the podcast feed on or off"),
		podcastCategory: z.enum(PODCAST_CATEGORIES).optional().describe("Apple Podcasts' category"),
		podcastExplicit: z.boolean().optional().describe("Mark the show explicit"),
		podcastOwnerEmail: z.string().trim().max(200).optional().describe("The show's owner for Apple Podcasts and Spotify to verify, printed in the feed; an empty string removes it"),
	}),
	output: SettingsSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const set = {};
		const unset = {};
		if (input.voiceId !== undefined) {
			if (input.voiceId && !listVoices().some(({ id }) => id === input.voiceId)) throw actionError("validation_failed", "voiceId: pick one of the voices list_audio_voices returns");
			if (input.voiceId) set["audio.voiceId"] = input.voiceId;
			else unset["audio.voiceId"] = 1;
		}
		if (input.podcastEnabled !== undefined) {
			if (input.podcastEnabled && !newsletter.archiveEnabled) throw actionError("conflict", "Turn the newsletter's website on first: the podcast is served from it");
			set["audio.podcast.enabled"] = input.podcastEnabled;
		}
		if (input.podcastCategory !== undefined) set["audio.podcast.category"] = input.podcastCategory;
		if (input.podcastExplicit !== undefined) set["audio.podcast.explicit"] = input.podcastExplicit;
		if (input.podcastOwnerEmail !== undefined) {
			if (input.podcastOwnerEmail && !EMAIL_PATTERN.test(input.podcastOwnerEmail)) throw actionError("validation_failed", "podcastOwnerEmail: use an email address");
			if (input.podcastOwnerEmail) set["audio.podcast.ownerEmail"] = input.podcastOwnerEmail.toLowerCase();
			else unset["audio.podcast.ownerEmail"] = 1;
		}
		const update = { ...(Object.keys(set).length > 0 && { $set: set }), ...(Object.keys(unset).length > 0 && { $unset: unset }) };
		if (Object.keys(update).length > 0) {
			await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), update);
			revalidateArchive();
		}
		return toSettings(await Newsletter.findOne(scoped(account, { _id: newsletter._id })).lean());
	},
});

export const audioActions = [
	listVoicesAction,
	getAudioUsageAction,
	createAudioVersionAction,
	getAudioVersionAction,
	updateAudioVersionAction,
	deleteAudioVersionAction,
	getAudioSettingsAction,
	updateAudioSettingsAction,
];
