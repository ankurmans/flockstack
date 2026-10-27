import { hasAudienceBlocks } from "@/lib/audience-blocks";
import "server-only";
import { hasActiveSubscription } from "@/lib/account-state";
import { runAction } from "@/lib/actions/run-action";
import { isAudioEnabled } from "@/lib/audio-config";
import { getAudioLimit } from "@/lib/plans";

// What the audio card on an issue's page needs, or null while audio versions are off (the card is hidden). An account
// without a plan, or whose plan has no audio, gets the card with a line about plans.
export async function getAudioCardProps({ account, user, campaign, newsletter }) {
	if (!isAudioEnabled()) return null;
	const campaignId = String(campaign._id);
	if (campaign.format === "rich" && hasAudienceBlocks(campaign.html)) return { campaignId, unsupportedReason: "Audio versions are unavailable for issues with audience blocks. Remove the blocks to make one shared audio version." };
	if (!hasActiveSubscription(account) || getAudioLimit(account) === 0) return { campaignId, hasPlan: false };
	const run = (name, input) => runAction(name, { account, user, via: "dashboard", input });
	try {
		const [version, voices, settings] = await Promise.all([
			run("get_audio_version", { id: campaignId }),
			run("list_audio_voices", {}),
			run("get_audio_settings", { newsletter: String(newsletter._id) }),
		]);
		if (voices.voices.length === 0) return null;
		return {
			campaignId,
			hasPlan: true,
			initial: { audio: version.audio, estimate: version.estimate },
			voices: voices.voices,
			defaultVoiceId: settings.voiceId,
			canLink: Boolean(newsletter.archiveEnabled && campaign.audience !== "paid" && campaign.publishTo !== "email"),
			isPaidOnly: campaign.audience === "paid",
		};
	} catch (error) {
		console.error("[audio] The audio card didn't load:", error?.message);
		return null;
	}
}
