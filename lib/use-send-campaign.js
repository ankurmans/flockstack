import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scheduleCampaign, setCampaignAudience, startSend, unscheduleCampaign } from "@/app/(app)/campaigns/actions";
import { countRecipients } from "@/components/InputAudienceLimit";
import { getSendProblem } from "@/lib/campaign-steps";
import { summarizePreview } from "@/lib/cleanup";
import { formatSendTime } from "@/lib/format";
import { reportGoal } from "@/lib/goals";
import { SEND_HELD_EVENT } from "@/lib/send-hold-rules";
import { getScheduleProblem, getScheduleSuggestions } from "@/lib/schedule";
import { toast } from "@/lib/toast";
import { useCleanupPreview } from "@/lib/use-cleanup-preview";
import { useToastError } from "@/lib/use-toast-error";

const FALLBACK_MINUTES = 9 * 60;

// The send step (FormCampaign): who gets the issue, now or at a time, and what sending and scheduling do.
export function useSendCampaign({
	campaignId,
	allCount,
	paidCount = 0,
	audience: savedAudience = "all",
	audienceLimit,
	emailsLeft,
	scheduledAt,
	isCleanupEnabled,
	sendTimes,
	blockingMessage,
	hasPlan,
	onBeforeSend,
}) {
	const router = useRouter();
	const toastError = useToastError();
	const { preview, isCounting, loadPreview } = useCleanupPreview(campaignId);
	const [audience, setAudienceState] = useState(savedAudience);
	// Free readers are everyone who isn't paying; a send to one audience counts only its contacts.
	const audienceCount = audience === "paid" ? paidCount : audience === "free" ? Math.max(0, allCount - paidCount) : allCount;
	const [choice, setChoice] = useState(scheduledAt ? "later" : "now");
	const [limit, setLimit] = useState(audienceLimit ? String(audienceLimit) : "");
	const [sendAt, setSendAt] = useState(null);
	const [suggestions, setSuggestions] = useState([]);
	const [isConfirmOpen, setIsConfirmOpen] = useState(false);
	const [isPending, startPending] = useTransition();
	// With the list cleanup on, cold contacts get the last-chance email instead and don't count.
	const summary = preview?.enabled ? summarizePreview(preview, Number.parseInt(limit, 10)) : null;
	const issueAudience = preview?.enabled ? preview.issue : audienceCount;
	const sendRecipients = summary ? summary.issue : countRecipients(limit, audienceCount);
	const sendEmails = sendRecipients + (summary?.lastChance ?? 0);
	const scheduleRecipients = countRecipients(limit, audienceCount);
	const scheduleProblem = getScheduleProblem(sendAt) ?? blockingMessage;
	const problem = getSendProblem({
		hasPlan,
		choice,
		blockingMessage,
		scheduledAt,
		scheduleProblem,
		sendEmails,
		scheduleRecipients,
		emailsLeft,
	});

	// Each time the step opens: the cleanup count reads the whole list, and suggestions depend on the time.
	function prepare() {
		if (isCleanupEnabled) loadPreview();
		const nextSuggestions = getScheduleSuggestions(sendTimes);
		const suggested = nextSuggestions.find(({ isLastIssue }) => isLastIssue) ?? nextSuggestions[0];
		setSuggestions(nextSuggestions);
		setSendAt((current) => current ?? (scheduledAt ? new Date(scheduledAt) : (suggested?.at ?? tomorrowAt(FALLBACK_MINUTES))));
	}

	// The list cleanup's count is made for the campaign as saved, so the audience is saved first and the count asked again.
	function setAudience(value) {
		const previous = audience;
		setAudienceState(value);
		startPending(async () => {
			const result = await setCampaignAudience(campaignId, value);
			if (result?.error) {
				setAudienceState(previous);
				return toastError(result);
			}
			if (isCleanupEnabled) loadPreview();
		});
	}

	function send() {
		startPending(async () => {
			if (!(await onBeforeSend())) return;
			const result = await startSend(campaignId, { audienceLimit: Number.parseInt(limit, 10) || undefined, audience });
			if (result?.error) return toastError(result);
			setIsConfirmOpen(false);
			reportGoal("campaign_sent", { when: "now" });
			// A held send is the bar's to show; one that went out at once has only the toast.
			if (result.status === "held") window.dispatchEvent(new CustomEvent(SEND_HELD_EVENT, { detail: { id: campaignId, ...result } }));
			else toast.success("Sending started");
			router.refresh();
		});
	}

	function schedule() {
		startPending(async () => {
			if (!(await onBeforeSend())) return;
			const result = await scheduleCampaign(campaignId, {
				scheduledAt: sendAt.toISOString(),
				audienceLimit: Number.parseInt(limit, 10) || undefined,
				audience,
			});
			if (result?.error) return toastError(result);
			reportGoal("campaign_sent", { when: "scheduled" });
			toast.success(`Scheduled for ${formatSendTime(sendAt)}`);
			router.refresh();
		});
	}

	function unschedule() {
		startPending(async () => {
			const result = await unscheduleCampaign(campaignId);
			if (result?.error) return toast.error(result.error);
			toast.success("Unscheduled, it's a draft again");
			router.refresh();
		});
	}

	return {
		audience,
		setAudience,
		audienceCount,
		choice,
		setChoice,
		limit,
		setLimit,
		sendAt,
		setSendAt,
		suggestions,
		history: sendTimes.history,
		preview,
		isCounting,
		summary,
		issueAudience,
		sendRecipients,
		sendEmails,
		scheduleRecipients,
		scheduleProblem,
		problem,
		isConfirmOpen,
		setIsConfirmOpen,
		isPending,
		prepare,
		send,
		schedule,
		unschedule,
	};
}

function tomorrowAt(minutes) {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, Math.floor(minutes / 60), minutes % 60);
}
