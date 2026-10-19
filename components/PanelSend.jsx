"use client";

import { CalendarClock, Loader2, Send } from "lucide-react";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import CardAbTest from "@/components/CardAbTest";
import CardSettings from "@/components/CardSettings";
import InputCampaignSlug from "@/components/InputCampaignSlug";
import ListCleanupPreview from "@/components/ListCleanupPreview";
import NoticeFirstSend from "@/components/NoticeFirstSend";
import NoticeWarmup from "@/components/NoticeWarmup";
import PickerSendTime from "@/components/PickerSendTime";
import RowCampaign from "@/components/RowCampaign";
import SelectSegment from "@/components/SelectSegment";
import TextPlanLimit from "@/components/TextPlanLimit";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FIRST_SEND } from "@/lib/config";
import { formatCount, formatNumber, formatSendTime } from "@/lib/format";
import { getPaceHours } from "@/lib/send-spread";
import { slugify } from "@/lib/slug";
import { useIsClient } from "@/lib/use-is-client";
import { cn } from "@/lib/utils";

// The send step: who gets the issue and how fast it goes out, then now or at a time. Its button is in the editor's
// bar, and lib/use-send-campaign.js holds what it does.
export default function PanelSend({
	sending,
	campaign,
	newsletter,
	subject,
	audienceCount,
	isPaidTierOn,
	emailsLeft,
	pace,
	newContacts,
	archiveUrlBase,
	segments = [],
}) {
	const isClient = useIsClient();
	const scheduledAt = campaign.status === "scheduled" ? campaign.scheduledAt : null;
	// The browser's time zone, which the server doesn't know.
	const scheduledTime = scheduledAt && isClient ? formatSendTime(scheduledAt) : null;
	const isNow = sending.choice === "now";
	// As the send and schedule dialogs counted them: a send with its last-chance emails, a schedule its contacts.
	const paceEmails = isNow ? sending.sendEmails : sending.scheduleRecipients;
	const isPaced = Boolean(pace?.warmup) || getPaceHours(pace, { emails: paceEmails, newContacts }) > 0;
	const isCleanupEnabled = Boolean(newsletter.cleanup?.enabled);
	const isOverPlan = isNow && emailsLeft !== null && sending.sendEmails > emailsLeft;
	const isTesting = (campaign.abTest?.variants?.length ?? 0) >= 2;
	const from = newsletter.fromName ? `${newsletter.fromName} <${newsletter.fromEmail}>` : newsletter.fromEmail;

	return (
		<div className="flex flex-col gap-6">
			<CardSettings title="Who gets it">
				<RowCampaign label="From">
					<span className="truncate text-sm">{from}</span>
				</RowCampaign>
				<RowCampaign label="To">
					<span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
						<span className="flex min-w-0 items-center gap-2">
							<AvatarNewsletter newsletter={newsletter} size={18} />
							<span className="truncate">
								{campaign.resend?.of ? `Readers who didn't ${campaign.resend.to === "unclicked" ? "click" : "open"} the first send` : newsletter.name}
								<span className="text-muted-foreground tabular-nums">
									{" "}
									· {campaign.resend?.of && "up to "}
									{formatCount(audienceCount, "contact")}
								</span>
								{sending.audience === "paid" && <span className="text-muted-foreground"> · web page shows a teaser</span>}
							</span>
						</span>
						{(segments.length > 0 || campaign.segmentId) && (
							<SelectSegment campaignId={campaign._id} segmentId={campaign.segmentId ?? null} segments={segments} />
						)}
					</span>
				</RowCampaign>
				{(isPaidTierOn || sending.audience !== "all") && (
					<RowCampaign label="Audience">
						<div role="radiogroup" aria-label="Audience" className="flex min-w-0 flex-wrap gap-1.5 py-2">
							{AUDIENCE_CHOICES.map(({ value, label }) => (
								<button
									key={value}
									type="button"
									role="radio"
									aria-checked={sending.audience === value}
									disabled={sending.isPending}
									onClick={() => sending.audience !== value && sending.setAudience(value)}
									className={cn(
										"h-7 rounded-full px-3 text-xs font-medium outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
										sending.audience === value ? "bg-foreground text-background" : "text-muted-foreground shadow-border hover:bg-muted/60 hover:text-foreground"
									)}
								>
									{label}
								</button>
							))}
						</div>
					</RowCampaign>
				)}
				<RowCampaign label="Limit">
					<span className="flex min-w-0 items-center gap-3">
						<input
							type="number"
							min={1}
							inputMode="numeric"
							value={sending.limit}
							onChange={(event) => sending.setLimit(event.target.value)}
							placeholder={`All ${formatNumber(isNow ? sending.issueAudience : audienceCount)}`}
							aria-label="Limit"
							className="h-11 w-full min-w-0 bg-transparent text-sm tabular-nums outline-none placeholder:text-muted-foreground"
						/>
						<span className="shrink-0 text-xs text-muted-foreground">Most engaged first</span>
					</span>
				</RowCampaign>
				{archiveUrlBase && !campaign.resend?.of && (
					<RowCampaign label="Web page">
						<InputCampaignSlug
							campaignId={campaign._id}
							initialSlug={campaign.archiveSlug ?? ""}
							placeholder={slugify(subject, 80) || "issue"}
							urlBase={archiveUrlBase}
						/>
					</RowCampaign>
				)}
				{isCleanupEnabled &&
					(isNow ? (
						<div className="p-3">
							<ListCleanupPreview summary={sending.summary} isCounting={sending.isCounting} error={sending.preview?.error} />
						</div>
					) : (
						<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
							The list cleanup runs when it goes out, so cold contacts get the last-chance email instead.
						</p>
					))}
			</CardSettings>

			{!campaign.resend?.of && <CardAbTest campaign={campaign} subject={subject} audienceCount={audienceCount} stagger={1} />}

			<CardSettings title="When" stagger={2}>
				<div role="radiogroup" aria-label="When" className="grid gap-2 p-3 sm:grid-cols-2">
					<CardChoice
						icon={Send}
						title="Send now"
						description={scheduledTime ? `Instead of ${scheduledTime}` : "Goes out right away"}
						isSelected={isNow}
						onSelect={() => sending.setChoice("now")}
					/>
					<CardChoice
						icon={CalendarClock}
						title="Schedule"
						description={scheduledTime ? `Scheduled for ${scheduledTime}` : "Pick a day and time"}
						isSelected={!isNow}
						onSelect={() => sending.setChoice("later")}
					/>
				</div>
				{!isNow && sending.sendAt && (
					<div className="flex flex-col gap-4 px-4 py-4">
						<PickerSendTime
							value={sending.sendAt}
							onChange={sending.setSendAt}
							suggestions={sending.suggestions}
							history={sending.history}
						/>
						<SummarySendTime value={sending.sendAt} problem={sending.scheduleProblem} />
						<div className="flex items-center justify-between gap-3">
							<p className="text-sm text-muted-foreground tabular-nums">
								Goes out to {formatCount(sending.scheduleRecipients, "contact")}. You can keep editing until then.
							</p>
							{scheduledAt && (
								<Button variant="ghost" size="sm" onClick={sending.unschedule} disabled={sending.isPending}>
									Unschedule
								</Button>
							)}
						</div>
					</div>
				)}
				{(isPaced || newContacts > FIRST_SEND.minSlice) && (
					<div className="flex flex-col gap-2 p-3">
						<NoticeWarmup pace={pace} emails={paceEmails} newContacts={newContacts} />
						{newContacts > FIRST_SEND.minSlice && <NoticeFirstSend count={newContacts} />}
					</div>
				)}
			</CardSettings>

			{isOverPlan && <TextPlanLimit emailsLeft={emailsLeft} />}

			<Dialog open={sending.isConfirmOpen} onOpenChange={sending.setIsConfirmOpen}>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle className="tabular-nums">Send to {formatCount(sending.sendRecipients, "contact")}?</DialogTitle>
						<DialogDescription>
							{scheduledTime ? `It goes out now instead of ${scheduledTime}.` : "Most engaged contacts receive it first."}
							{isTesting
								? " The subject line test goes to a slice of them first, and the winner to the rest after the wait."
								: sending.sendRecipients < sending.issueAudience && " Send it to more later from its page."}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline">Cancel</Button>
						</DialogClose>
						<Button onClick={sending.send} disabled={sending.isPending} className="min-w-20">
							{sending.isPending ? <Loader2 className="animate-spin" /> : "Send"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

const AUDIENCE_CHOICES = [
	{ value: "all", label: "Everyone" },
	{ value: "free", label: "Free readers" },
	{ value: "paid", label: "Paid readers" },
];

function CardChoice({ icon: Icon, title, description, isSelected, onSelect }) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={isSelected}
			onClick={onSelect}
			className={cn(
				"flex items-start gap-3 rounded-lg p-3 text-left outline-none transition-[background-color,box-shadow,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]",
				isSelected ? "bg-muted/60 shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-border hover:bg-muted/60"
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"mt-0.5 grid size-4 shrink-0 place-items-center rounded-full transition-colors duration-150",
					isSelected ? "bg-foreground" : "shadow-border"
				)}
			>
				{isSelected && <span className="size-1.5 rounded-full bg-background" />}
			</span>
			<span className="min-w-0">
				<span className="flex items-center gap-1.5 text-sm font-medium">
					<Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
					{title}
				</span>
				<span className="block text-sm text-pretty text-muted-foreground tabular-nums">{description}</span>
			</span>
		</button>
	);
}

function SummarySendTime({ value, problem }) {
	if (problem) return <p className="text-sm text-destructive">{problem}</p>;

	const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
		.formatToParts(value)
		.find(({ type }) => type === "timeZoneName")?.value;

	return (
		<p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm tabular-nums">
			<span className="font-medium">{formatSendTime(value)}</span>{" "}
			<span className="text-muted-foreground">{zone}</span>
		</p>
	);
}
