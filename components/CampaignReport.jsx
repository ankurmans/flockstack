import Link from "next/link";
import { Copy, Eye, EyeOff, ExternalLink, Globe, Pause, PencilLine, Pin, PinOff, Play, Repeat } from "lucide-react";
import {
	duplicateCampaign,
	pauseCampaign,
	resumeCampaign,
	toggleArchiveListed,
	toggleArchivePin,
} from "@/app/(app)/campaigns/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonCampaignAction from "@/components/ButtonCampaignAction";
import ButtonCopy from "@/components/ButtonCopy";
import ButtonSocialPosts from "@/components/ButtonSocialPosts";
import GatePlan from "@/components/GatePlan";
import DialogLinkClicks from "@/components/DialogLinkClicks";
import DialogResend from "@/components/DialogResend";
import DialogSendMore from "@/components/DialogSendMore";
import HeaderPage from "@/components/HeaderPage";
import LiveResults from "@/components/LiveResults";
import IconWarmup from "@/components/IconWarmup";
import ImageFavicon from "@/components/ImageFavicon";
import CardSeo from "@/components/CardSeo";
import InputCampaignSlug from "@/components/InputCampaignSlug";
import InputIssueTags from "@/components/InputIssueTags";
import PreviewEmail from "@/components/PreviewEmail";
import TextEmpty from "@/components/TextEmpty";
import TimeLocal from "@/components/TimeLocal";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { VARIANT_LABELS, hasAbTest } from "@/lib/ab-test-rules";
import { isPlanLimitCode } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { FIRST_SEND, isSendingEnabled } from "@/lib/config";
import { formatCount, formatDate, formatNumber, formatRate } from "@/lib/format";
import { PROVIDER_DOMAINS, PROVIDER_LABELS } from "@/lib/providers";
import { renderEmail, withPreviewLinks, withResponsiveImages } from "@/lib/render-email";
import { getAudienceLabel } from "@/lib/tiers";
import CardPollResults from "@/components/CardPollResults";

const RECENT_MS = 5 * 60 * 1000;
const COUNT_KEYS = ["recipients", "sent", "delivered", "opened", "clicked", "bounced", "unsubscribed", "complained", "failed"];

export default function CampaignReport({
	campaign,
	newsletter,
	providers,
	links = [],
	clickMapHtml = null,
	resendCounts = null,
	remainingCount = 0,
	emailsLeft = 0,
	sentWith = false,
	isBlocked = false,
	pace = null,
	newContacts = 0,
	polls = [],
	audioCard = null,
	authorControl = null,
	isAiEnabled = false,
}) {
	const { stats } = campaign;
	const id = campaign._id.toString();
	const isOnArchive = newsletter.archiveEnabled && Boolean(campaign.archiveSlug) && campaign.archiveListed !== false;
	const reached = stats.delivered || stats.sent;
	const { html } = renderEmail({
		format: campaign.format,
		markdown: campaign.markdown,
		html: campaign.html,
		subject: campaign.subject,
		previewText: campaign.previewText,
		newsletter,
		sentWith,
	});

	return (
		<>
			<HeaderPage
				title={campaign.subject || "Untitled"}
				backHref="/campaigns"
				icon={<AvatarNewsletter newsletter={newsletter} size={28} />}
				meta={
					<>
						<BadgeStatus status={campaign.status} />
						{campaign.audience && campaign.audience !== "all" && <BadgeStatus status="audience" label={getAudienceLabel(campaign.audience)} />}
					</>
				}
			>
				{campaign.status === "sent" && remainingCount > 0 && isSendingEnabled() && !isBlocked && (
					<GatePlan reason="send">
						<DialogSendMore
							campaignId={id}
							sentCount={stats.recipients}
							remainingCount={remainingCount}
							emailsLeft={emailsLeft}
							isCleanupEnabled={Boolean(newsletter.cleanup?.enabled)}
							pace={pace}
							newContacts={newContacts}
							isRandom={campaign.audienceOrder === "random"}
						/>
					</GatePlan>
				)}
				{resendCounts && isSendingEnabled() && !isBlocked && (
					<GatePlan reason="send">
						<DialogResend campaignId={id} subject={campaign.subject} sentAt={campaign.sentAt ?? campaign.startedAt} counts={resendCounts} />
					</GatePlan>
				)}
				{(campaign.resentAs || campaign.resend?.of) && (
					<Button variant="outline" asChild>
						<Link href={`/campaigns/${campaign.resentAs ?? campaign.resend.of}`}>
							<Repeat data-icon="inline-start" />
							{campaign.resentAs ? "View resend" : "View first send"}
						</Link>
					</Button>
				)}
				{isAiEnabled && campaign.status === "sent" && <ButtonSocialPosts campaignId={id} newsletterId={String(campaign.newsletterId)} subject={campaign.subject} />}
				{campaign.status === "sending" && (
					<ButtonCampaignAction action={pauseCampaign} id={id}>
						<Pause data-icon="inline-start" />
						Pause
					</ButtonCampaignAction>
				)}
				{campaign.status === "paused" && (
					<GatePlan reason="send">
						<ButtonCampaignAction
							action={resumeCampaign}
							id={id}
							disabledReason={isBlocked ? "The account is blocked" : isSendingEnabled() ? null : "Sending is off"}
						>
							<Play data-icon="inline-start" />
							Resume
						</ButtonCampaignAction>
					</GatePlan>
				)}
				{isOnArchive && (
					<>
						<Button variant="outline" asChild>
							<a href={getArchiveUrls(newsletter).post(campaign.archiveSlug)} target="_blank" rel="noreferrer">
								<ExternalLink data-icon="inline-start" />
								View page
							</a>
						</Button>
						<ButtonCampaignAction action={toggleArchivePin} id={id}>
							{campaign.archivePinned ? <PinOff data-icon="inline-start" /> : <Pin data-icon="inline-start" />}
							{campaign.archivePinned ? "Unpin" : "Pin"}
						</ButtonCampaignAction>
					</>
				)}
				{newsletter.archiveEnabled && campaign.archiveSlug && campaign.publishTo !== "email" && (
					<ButtonCampaignAction action={toggleArchiveListed} id={id}>
						{campaign.archiveListed === false ? <Eye data-icon="inline-start" /> : <EyeOff data-icon="inline-start" />}
						{campaign.archiveListed === false ? "List on website" : "Unlist"}
					</ButtonCampaignAction>
				)}
				{campaign.status === "sent" && campaign.archiveSlug && campaign.publishTo !== "email" && !campaign.resend?.of && campaign.abTest?.status !== "testing" && (
					<Button variant="outline" asChild>
						<Link href={`/campaigns/${id}/edit`}>
							<PencilLine data-icon="inline-start" />
							Edit web version
						</Link>
					</Button>
				)}
				<ButtonCampaignAction action={duplicateCampaign} id={id}>
					<Copy data-icon="inline-start" />
					Duplicate
				</ButtonCampaignAction>
			</HeaderPage>

			<div className="flex flex-col gap-6">
				{campaign.status === "paused" && campaign.pauseReason && (
					<TextPauseReason reason={campaign.pauseReason} code={campaign.pauseCode} />
				)}
				{campaign.status === "held" && campaign.hold?.sendAfter && (
					<p className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-pretty animate-enter">
						Held: this send waits until{" "}
						<TimeLocal value={campaign.hold.sendAfter} options={{ hour: "numeric", minute: "2-digit", second: "2-digit" }} /> so you can still undo it.
						Nothing has been queued, counted or emailed yet.
					</p>
				)}
				<LiveResults campaignId={id} initial={getLiveStart(campaign)}>
					{campaign.status === "sending" && campaign.firstSend?.held > 0 && !campaign.firstSend.checkedAt && (
						<p className="text-xs text-pretty text-muted-foreground">
							{formatNumber(campaign.firstSend.slice)} contacts who never got an email from you go first. The other{" "}
							{formatNumber(campaign.firstSend.held)} follow {FIRST_SEND.waitMinutes / 60} hours after them if their bounces and
							complaints stay low. If they don&apos;t, the rest waits for you to resume, and if they&apos;re far over, your account is
							blocked.
						</p>
					)}
					{campaign.status === "sending" && campaign.sendingUntil && campaign.spreadHours > 0 && (
						<p className="flex gap-1.5 text-xs text-pretty text-muted-foreground">
							<IconWarmup className="size-3.5 translate-y-px" />
							<span>
								It goes out over hours while your account warms up{pace?.warmup ? "" : " to sends this size"}: about{" "}
								{formatCount(hoursUntil(campaign.sendingUntil), "hour")} to go.
							</span>
						</p>
					)}
				</LiveResults>

				{authorControl}
				{audioCard}

				{campaign.publishTo === "web" && (
					<p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-pretty animate-enter">Published on the website only: no email went out.</p>
				)}
				{campaign.publishTo === "email" && (
					<p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-pretty animate-enter">Email only: this issue has no page on the website.</p>
				)}

				{hasAbTest(campaign) && campaign.abTest.status && <TableAbTest abTest={campaign.abTest} />}

				{providers.length > 0 && (
					<div
						style={{ "--stagger": 2 }}
						className="overflow-hidden rounded-xl shadow-border animate-enter"
					>
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Inbox</TableHead>
									<TableHead className="text-right">Sent</TableHead>
									<TableHead className="text-right">Delivered</TableHead>
									<TableHead className="text-right">Opened</TableHead>
									<TableHead className="hidden text-right sm:table-cell">Clicked</TableHead>
									<TableHead className="hidden text-right sm:table-cell">Bounced</TableHead>
									<TableHead className="pr-4 text-right">Complaints</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{providers.map((row) => (
									<TableRow key={row.provider} className="tabular-nums">
										<TableCell className="pl-4 font-medium">
											<span className="flex items-center gap-2.5">
												{PROVIDER_DOMAINS[row.provider] ? (
													<ImageFavicon domain={PROVIDER_DOMAINS[row.provider]} size={16} />
												) : (
													<Globe className="size-4 text-muted-foreground" />
												)}
												{PROVIDER_LABELS[row.provider] || PROVIDER_LABELS.other}
											</span>
										</TableCell>
										<TableCell className="text-right">{formatNumber(row.sent)}</TableCell>
										<TableCell className="text-right">{formatRate(row.delivered, row.sent) ?? <TextEmpty />}</TableCell>
										<TableCell className="text-right">{formatRate(row.opened, row.delivered) ?? <TextEmpty />}</TableCell>
										<TableCell className="hidden text-right sm:table-cell">
											{formatRate(row.clicked, row.delivered) ?? <TextEmpty />}
										</TableCell>
										<TableCell className="hidden text-right sm:table-cell">
											{formatRate(row.bounced, row.sent, 2) ?? <TextEmpty />}
										</TableCell>
										<TableCell className="pr-4 text-right">
											{formatRate(row.complained, row.sent, 3) ?? <TextEmpty />}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}

				{links.length > 0 && (
					<div style={{ "--stagger": 3 }} className="overflow-hidden rounded-xl shadow-border animate-enter">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Link</TableHead>
									<TableHead className="text-right">Unique clicks</TableHead>
									<TableHead className="hidden text-right sm:table-cell">Total</TableHead>
									<TableHead className="text-right">CTR</TableHead>
									<TableHead className="pr-4">
										<span className="sr-only">Who clicked</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{links.map((link) => (
									<TableRow key={link.index} className="tabular-nums">
										<TableCell className="max-w-0 pl-4 font-medium">
											<span className="flex items-center gap-2.5">
												<span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] text-muted-foreground">
													{link.index + 1}
												</span>
												<a href={link.url} target="_blank" rel="noreferrer noopener" className="truncate hover:underline" title={link.url}>
													{link.url.replace(/^https?:\/\//, "")}
												</a>
											</span>
										</TableCell>
										<TableCell className="text-right">{formatNumber(link.uniqueClicks)}</TableCell>
										<TableCell className="hidden text-right sm:table-cell">{formatNumber(link.clicks)}</TableCell>
										<TableCell className="text-right">{formatRate(link.uniqueClicks, reached) ?? <TextEmpty />}</TableCell>
										<TableCell className="w-0 pr-2 text-right">
											<DialogLinkClicks campaignId={id} link={link} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}

				{polls.map((poll) => (
					<CardPollResults key={poll.id} poll={poll} />
				))}

				{newsletter.archiveEnabled && campaign.archiveSlug && (
					<div
						style={{ "--stagger": 4 }}
						className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-xl bg-card px-4 shadow-border transition-colors duration-150 animate-enter focus-within:bg-muted/40"
					>
						<span className="text-sm text-muted-foreground">URL</span>
						<InputCampaignSlug
							campaignId={id}
							initialSlug={campaign.archiveSlug}
							urlBase={getArchiveUrls(newsletter).absolutePost("")}
							isPublished
						/>
						<ButtonCopy value={getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug)} label="Copy link" />
					</div>
				)}

				{newsletter.archiveEnabled && campaign.archiveSlug && (
					<div
						style={{ "--stagger": 4 }}
						className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 rounded-xl bg-card px-4 shadow-border transition-colors duration-150 animate-enter focus-within:bg-muted/40"
					>
						<span className="text-sm text-muted-foreground">Tags</span>
						<InputIssueTags campaignId={id} initialTags={campaign.tags ?? []} />
					</div>
				)}

				{newsletter.archiveEnabled && campaign.archiveSlug && campaign.publishTo !== "email" && (
					<CardSeo campaignId={id} seo={campaign.seo} subject={campaign.subject} previewText={campaign.previewText} stagger={5} />
				)}

				<div style={{ "--stagger": 5 }} className="animate-enter">
					<PreviewEmail
						fit="content"
						sender={newsletter}
						subject={campaign.subject}
						previewText={campaign.previewText}
						html={withResponsiveImages(clickMapHtml ?? withPreviewLinks(html))}
						// Rendered next to PreviewEmail's own children, so dev React asks for a key.
						toolbar={
							<span key="toolbar" className="truncate text-xs text-muted-foreground">
								{clickMapHtml ? "Click map: unique clicks on each link" : newsletter.name}
								{!clickMapHtml && campaign.sentAt && ` · ${formatDate(campaign.sentAt)}`}
							</span>
						}
					/>
				</div>
			</div>
		</>
	);
}

const TIME_OPTIONS = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

// The subject line test's slice, subject by subject, and where the pick stands.
function TableAbTest({ abTest }) {
	const isPicked = abTest.status === "picked";
	const measure = abTest.metric === "opens" ? "opens" : "unique clicks";
	return (
		<div style={{ "--stagger": 2 }} className="overflow-hidden rounded-xl shadow-border animate-enter">
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				{isPicked ? (
					<>
						Subject {VARIANT_LABELS[abTest.winner]} won by {measure}
						{abTest.pickedAt && (
							<>
								{" "}
								on <TimeLocal value={abTest.pickedAt} options={TIME_OPTIONS} />
							</>
						)}
						{abTest.problem ? `, but it didn't reach the rest: ${abTest.problem}` : " and went to the rest."}
					</>
				) : (
					<>
						Subject line test: the winner by {measure} goes to the rest
						{abTest.pickAt ? (
							<>
								{" "}
								around <TimeLocal value={abTest.pickAt} options={TIME_OPTIONS} />
							</>
						) : (
							" after the wait"
						)}
						.
					</>
				)}
			</p>
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="pl-4">Subject</TableHead>
						<TableHead className="text-right">Sent</TableHead>
						<TableHead className="text-right">Opened</TableHead>
						<TableHead className="pr-4 text-right">Clicked</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{abTest.variants.map((variant, index) => (
						<TableRow key={index} className="tabular-nums">
							<TableCell className="max-w-0 pl-4">
								<span className="flex items-center gap-2.5">
									<span
										className={
											isPicked && abTest.winner === index
												? "grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-medium text-background"
												: "grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] text-muted-foreground"
										}
										title={isPicked && abTest.winner === index ? "Winner" : undefined}
									>
										{VARIANT_LABELS[index]}
									</span>
									<span className="truncate font-medium" title={variant.subject}>
										{variant.subject}
									</span>
								</span>
							</TableCell>
							<TableCell className="text-right">{formatNumber(variant.sent)}</TableCell>
							<TableCell className="text-right">{formatRate(variant.opened, variant.sent) ?? <TextEmpty />}</TableCell>
							<TableCell className="pr-4 text-right">{formatRate(variant.clicked, variant.sent) ?? <TextEmpty />}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function TextPauseReason({ reason, code }) {
	return (
		<p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-amber-500/10 px-4 py-3 text-sm animate-enter">
			<span className="text-pretty">Paused: {reason}</span>
			{isPlanLimitCode(code) && (
				<Link href="/billing" className="font-medium underline underline-offset-4">
					Upgrade
				</Link>
			)}
		</p>
	);
}

// What the numbers at the top start from: the campaign's counters as the server read them, and whether they are worth watching.
function getLiveStart(campaign) {
	const { stats } = campaign;
	const isLive = campaign.status === "sending" || campaign.status === "held";
	const finishedAt = campaign.finishedAt ?? campaign.sentAt;
	return {
		status: campaign.status,
		isLive,
		watch: isLive || (campaign.status === "sent" && Boolean(finishedAt) && Date.now() - new Date(finishedAt).getTime() < RECENT_MS),
		counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, stats[key] ?? 0])),
	};
}

// Whole hours left, at least one: the last batch's time is approximate.
function hoursUntil(date) {
	return Math.max(1, Math.ceil((new Date(date).getTime() - Date.now()) / 3_600_000));
}
