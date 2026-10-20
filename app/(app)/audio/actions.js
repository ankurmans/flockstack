"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function createAudio({ campaignId, voiceId, emailLink }) {
	const { output, failure } = await runDashboardAction("create_audio_version", {
		campaign: String(campaignId ?? ""),
		...(voiceId && { voiceId: String(voiceId) }),
		...(typeof emailLink === "boolean" && { emailLink }),
	});
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${campaignId}`);
	return { audio: output };
}

export async function getAudio(campaignId) {
	const { output, failure } = await runDashboardAction("get_audio_version", { id: String(campaignId ?? "") });
	return failure ? toFormError(failure) : output;
}

export async function getAudioCost(campaignId) {
	const { output, failure } = await runDashboardAction("get_audio_usage", { campaign: String(campaignId ?? "") });
	return failure ? toFormError(failure) : output;
}

export async function removeAudio(campaignId) {
	const { failure } = await runDashboardAction("delete_audio_version", { id: String(campaignId ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${campaignId}`);
	return { ok: true };
}

export async function setListenLink({ campaignId, emailLink }) {
	const { output, failure } = await runDashboardAction("update_audio_version", { id: String(campaignId ?? ""), emailLink: emailLink === true });
	if (failure) return toFormError(failure);
	return { audio: output };
}

export async function saveAudioSettings({ newsletterId, voiceId, podcastEnabled, podcastCategory, podcastExplicit, podcastOwnerEmail }) {
	const { failure } = await runDashboardAction("update_audio_settings", {
		newsletter: String(newsletterId ?? ""),
		voiceId: String(voiceId ?? ""),
		podcastEnabled: podcastEnabled === true,
		...(podcastCategory && { podcastCategory: String(podcastCategory) }),
		podcastExplicit: podcastExplicit === true,
		podcastOwnerEmail: String(podcastOwnerEmail ?? ""),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/audio");
	return { ok: true, savedAt: Date.now() };
}
