"use client";

import { useCallback, useDeferredValue, useEffect, useEffectEvent, useId, useMemo, useRef, useState, useTransition } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import {
	ArrowRight,
	CalendarClock,
	Check,
	ChevronLeft,
	CircleAlert,
	Copy,
	Eye,
	FlaskConical,
	Loader2,
	MoreHorizontal,
	Send,
	Trash2,
} from "lucide-react";
import { duplicateCampaign, saveCampaign, sendTestCampaign } from "@/app/(app)/campaigns/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeStatus from "@/components/BadgeStatus";
import CardSettings from "@/components/CardSettings";
import DialogDiscardCampaign from "@/components/DialogDiscardCampaign";
import DialogPreviewEmail from "@/components/DialogPreviewEmail";
import EditorRich from "@/components/EditorRich";
import IconWarmup from "@/components/IconWarmup";
import ListChecks from "@/components/ListChecks";
import NavSteps from "@/components/NavSteps";
import PanelSend from "@/components/PanelSend";
import RowCampaign from "@/components/RowCampaign";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getCheckFix } from "@/lib/campaign-steps";
import { formatCount, formatSendTime } from "@/lib/format";
import { markdownToHtml } from "@/lib/markdown";
import { fillMergeTags } from "@/lib/merge-tags";
import { getPresendChecks } from "@/lib/presend-checks";
import { UNSUBSCRIBE_PLACEHOLDER, escapeHtml, renderEmail, withResponsiveImages } from "@/lib/render-email";
import { getPaceHours } from "@/lib/send-spread";
import { toast } from "@/lib/toast";
import { useMediaQuery } from "@/lib/use-media-query";
import { usePaywall } from "@/lib/use-paywall";
import { useSendCampaign } from "@/lib/use-send-campaign";
import { useToastError } from "@/lib/use-toast-error";
import { useAutosave } from "@/lib/use-autosave";
import { cn } from "@/lib/utils";

const UPLOADING_MESSAGE = "Wait for images to finish uploading";
// Below lg, as the step bar's classes.
const COMPACT_SCREEN = "(width < 64rem)";

export default function FormCampaign({
	campaign,
	newsletter,
	audienceCount,
	paidCount,
	senderProblem,
	isSendingEnabled,
	testEmail,
	sendTimes,
	archiveUrlBase,
	planProblem,
	emailsLeft,
	pace,
	newContacts,
	fields = [],
	segments = [],
}) {
	const isHtml = campaign.format === "html";
	const [step, setStep] = useState("write");
	const [isDiscardOpen, setIsDiscardOpen] = useState(false);
	const [isPreviewOpen, setIsPreviewOpen] = useState(false);
	const format = isHtml ? "html" : "rich";
	const [initialBody] = useState(() =>
		campaign.format === "markdown" ? markdownToHtml(campaign.markdown) : campaign.html
	);
	const [values, setValues] = useState({
		subject: campaign.subject,
		previewText: campaign.previewText,
		body: initialBody,
	});
	const save = useCallback((snapshot) => saveCampaign(campaign._id, { ...snapshot, format }), [campaign._id, format]);
	const { isDirty, isSaving, error, flush } = useAutosave(values, save);
	const [isTesting, startTesting] = useTransition();
	const [isWorking, startWorking] = useTransition();
	const toastError = useToastError();
	const paywall = usePaywall();
	const hasPlan = paywall?.hasPlan ?? true;
	const deferredValues = useDeferredValue(values);
	const isUploading = values.body.includes('src="blob:');
	const scheduledAt = campaign.status === "scheduled" ? campaign.scheduledAt : null;
	const isCompact = useMediaQuery(COMPACT_SCREEN);
	const rootRef = useRef(null);
	const subjectRef = useRef(null);
	const previewTextRef = useRef(null);
	const previewOpenerRef = useRef(null);
	const scrollsRef = useRef({});

	async function persist() {
		if (await flush()) return true;
		toast.error("Couldn't save the draft");
		return false;
	}

	const rendered = useMemo(
		() =>
			renderEmail({
				format,
				html: deferredValues.body,
				subject: deferredValues.subject,
				previewText: deferredValues.previewText,
				newsletter,
			}),
		[format, deferredValues, newsletter]
	);
	// The preview has no reader, so merge tags show their fallbacks.
	const previewHtml = useMemo(
		() => withResponsiveImages(fillMergeTags(rendered.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#"), null, { escape: escapeHtml })),
		[rendered.html]
	);
	const { checks, blocking } = getPresendChecks({
		campaign: { ...campaign, ...values },
		newsletter,
		rendered,
		senderProblem,
		isSendingEnabled,
		planProblem,
	});
	// Without a plan, Send and Schedule open the paywall first; the checks wait until there's one.
	const blockingMessage = !hasPlan ? null : isUploading ? UPLOADING_MESSAGE : blocking[0]?.message;
	const reviewChecks = checks.map((check) => ({ ...check, fix: getCheckFix(check, { newsletterId: newsletter._id }) }));
	const warmupCheck = getWarmupCheck(pace, { emails: audienceCount, newContacts });
	const sending = useSendCampaign({
		campaignId: campaign._id,
		allCount: audienceCount,
		paidCount,
		audience: campaign.audience ?? "all",
		audienceLimit: campaign.audienceLimit,
		emailsLeft,
		scheduledAt,
		isCleanupEnabled: Boolean(newsletter.cleanup?.enabled),
		sendTimes,
		blockingMessage,
		hasPlan,
		onBeforeSend: persist,
	});
	const isTestDisabled = hasPlan && !isSendingEnabled;

	function sendTest() {
		if (!hasPlan) return paywall.open("test");
		startTesting(async () => {
			if (isUploading) return void toast.error(UPLOADING_MESSAGE);
			if (!(await persist())) return;
			const result = await sendTestCampaign(campaign._id);
			if (result?.error) toastError(result);
			else toast.success(`Test sent to ${testEmail}`);
		});
	}

	function runAction(action) {
		startWorking(async () => {
			const result = await action(campaign._id);
			if (result?.error) toast.error(result.error);
		});
	}

	// Each step keeps its own scroll, so going back to the draft lands where the writing was.
	function goToStep(next) {
		if (next === step) return;
		scrollsRef.current[step] = window.scrollY;
		if (next === "send") sending.prepare();
		flushSync(() => setStep(next));
		window.scrollTo({ top: scrollsRef.current[next] ?? 0 });
	}

	function editField(field) {
		goToStep("write");
		const target =
			field === "subject"
				? subjectRef.current
				: field === "previewText"
					? previewTextRef.current
					: rootRef.current?.querySelector('[aria-label="Content"]');
		target?.focus({ preventScroll: true });
		target?.scrollIntoView({ block: "center" });
	}

	function openPreview(event) {
		previewOpenerRef.current = event.currentTarget;
		setIsPreviewOpen(true);
	}

	const onKeyDown = useEffectEvent((event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			flush();
		}
	});
	const onBeforeUnload = useEffectEvent((event) => {
		if (!isDirty && !isSaving) return;
		flush();
		event.preventDefault();
	});

	useEffect(() => {
		function handleKeyDown(event) {
			onKeyDown(event);
		}
		function handleBeforeUnload(event) {
			onBeforeUnload(event);
		}
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("beforeunload", handleBeforeUnload);
		};
	}, []);

	function update(key) {
		return (event) => setValues((current) => ({ ...current, [key]: event.target.value }));
	}

	const updateBody = useCallback((body) => setValues((current) => ({ ...current, body })), []);

	const sendAction =
		sending.choice === "now"
			? { label: "Send now", icon: Send, reason: "send", run: () => sending.setIsConfirmOpen(true) }
			: { label: "Schedule", icon: CalendarClock, reason: "schedule", run: sending.schedule };
	const action = {
		write: { label: "Next: review", icon: ArrowRight, isIconAfter: true, onClick: () => goToStep("review") },
		review: { label: "Next: send", icon: ArrowRight, isIconAfter: true, onClick: () => goToStep("send"), problem: blockingMessage },
		send: {
			label: sendAction.label,
			icon: sendAction.icon,
			onClick: () => (hasPlan ? sendAction.run() : paywall.open(sendAction.reason)),
			problem: sending.problem,
			isPending: sending.isPending,
		},
	}[step];

	function renderStatus() {
		if (error) return <StatusSave isSaving={false} error={error} onRetry={flush} />;
		if (action.problem) return <TextProblem>{action.problem}</TextProblem>;
		if (step === "write") {
			return (
				<>
					<StatusSave isSaving={isDirty || isSaving} error={null} onRetry={flush} />
					<Button variant="ghost" size="sm" onClick={openPreview} aria-label="Preview" className="text-muted-foreground max-sm:px-2">
						<Eye data-icon="inline-start" />
						<span className="max-sm:sr-only">Preview</span>
					</Button>
				</>
			);
		}
		if (step !== "send") return null;
		return (
			<span className="truncate text-sm text-muted-foreground tabular-nums">
				{sending.choice === "now"
					? `To ${formatCount(sending.sendRecipients, "contact")}`
					: sending.sendAt && formatSendTime(sending.sendAt)}
			</span>
		);
	}

	const title = <TitleCampaign title={values.subject} newsletter={newsletter} status={campaign.status} />;
	const menu = (
		<MenuMore
			isWorking={isWorking}
			onDuplicate={() => runAction(duplicateCampaign)}
			onDiscard={() => setIsDiscardOpen(true)}
		/>
	);

	return (
		<div ref={rootRef} data-campaign-steps className="pb-(--step-bar-space) lg:pb-0">
			{/* Phones and tablets: the title and the menu first, then the steps, which stick under the top bar. */}
			<div className="mb-4 flex items-center gap-2 animate-enter lg:hidden">
				{title}
				{menu}
			</div>
			<header className="sticky top-[calc(var(--plan-bar-height)+3.5rem)] z-20 -mx-4 mb-6 border-b border-border/60 bg-background/80 px-4 py-2 backdrop-blur-md md:top-(--plan-bar-height) md:-mx-10 md:px-10 lg:-mt-10 lg:mb-8 lg:grid lg:h-16 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center lg:gap-6 lg:border-b-0 lg:py-0">
				<div className="hidden min-w-0 lg:flex">{title}</div>
				<NavSteps step={step} onStep={goToStep} />
				<div className="hidden min-w-0 items-center justify-end gap-2 lg:flex">
					<BarAction action={action} status={renderStatus()} />
					{menu}
				</div>
			</header>

			<div className="mx-auto w-full max-w-2xl">
				<section aria-label="Write" hidden={step !== "write"}>
					<div className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
						<div className="divide-y divide-border/60 border-b border-border/60">
							<RowCampaign label="Subject">
								<input
									ref={subjectRef}
									value={values.subject}
									onChange={update("subject")}
									placeholder="Subject"
									aria-label="Subject"
									maxLength={200}
									className="h-11 w-full min-w-0 bg-transparent text-sm font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground"
								/>
							</RowCampaign>
							<RowCampaign label="Preview text">
								<input
									ref={previewTextRef}
									value={values.previewText}
									onChange={update("previewText")}
									placeholder="Shown after the subject in inboxes"
									aria-label="Preview text"
									maxLength={300}
									className="h-11 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
								/>
							</RowCampaign>
						</div>
						{isHtml ? (
							<div className="relative">
								<span className="pointer-events-none absolute top-3 right-4 text-xs text-muted-foreground">HTML</span>
								<textarea
									value={values.body}
									onChange={update("body")}
									placeholder="<html>"
									spellCheck={false}
									aria-label="Content"
									className="block min-h-[560px] w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground"
								/>
							</div>
						) : (
							<EditorRich content={initialBody} onChange={updateBody} fields={fields} />
						)}
					</div>
				</section>

				<section aria-label="Review" hidden={step !== "review"} className="flex flex-col gap-6">
					<ListChecks
						checks={warmupCheck ? [...reviewChecks, warmupCheck] : reviewChecks}
						renderFix={({ fix }) =>
							fix && (
								<ButtonFix
									fix={fix}
									onEdit={editField}
									onTest={sendTest}
									isTesting={isTesting}
									isTestDisabled={isTestDisabled}
								/>
							)
						}
					/>
					<CardSettings title="Test and preview" stagger={1}>
						<ButtonRow
							icon={FlaskConical}
							title="Send a test email"
							description={isTestDisabled ? "Sending is off" : `Goes to ${testEmail}`}
							onClick={sendTest}
							isDisabled={isTestDisabled}
							isPending={isTesting}
						/>
						<ButtonRow
							icon={Eye}
							title="Preview"
							description="On desktop and mobile, at their real width"
							onClick={openPreview}
						/>
					</CardSettings>
				</section>

				<section aria-label="Send" hidden={step !== "send"}>
					<PanelSend
						sending={sending}
						campaign={campaign}
						newsletter={newsletter}
						subject={values.subject}
						audienceCount={sending.audienceCount}
						isPaidTierOn={Boolean(newsletter.paidTier?.enabled)}
						emailsLeft={emailsLeft}
						pace={pace}
						newContacts={newContacts}
						archiveUrlBase={archiveUrlBase}
						segments={segments}
					/>
				</section>
			</div>

			{/* Below lg the step's button floats at the bottom like a save bar, clear of the support chat's button, and the
			    get-started pill steps aside for it (app/globals.css). */}
			<div
				data-save-bar={isCompact ? "" : undefined}
				data-shown={isCompact ? "" : undefined}
				className="fixed right-(--dock-right) bottom-(--dock-bottom) left-4 z-30 flex h-12 items-center rounded-xl bg-card p-1.5 pl-4 shadow-float md:left-64 lg:hidden"
			>
				<BarAction action={action} status={renderStatus()} className="w-full" />
			</div>

			<DialogPreviewEmail
				isOpen={isPreviewOpen}
				onOpenChange={setIsPreviewOpen}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					previewOpenerRef.current?.focus();
				}}
				html={previewHtml}
				sender={newsletter}
				subject={deferredValues.subject}
				previewText={deferredValues.previewText}
			/>
			<DialogDiscardCampaign
				id={campaign._id}
				subject={values.subject}
				scheduledAt={scheduledAt}
				isOpen={isDiscardOpen}
				onOpenChange={setIsDiscardOpen}
				redirectTo="/campaigns"
			/>
		</div>
	);
}

// The checklist's warm-up row, for a send to everyone: while the account warms up, or when the send would go out over
// hours (lib/send-spread.js). It never blocks and isn't counted.
function getWarmupCheck(pace, { emails, newContacts }) {
	const hours = getPaceHours(pace, { emails, newContacts });
	if (!hours && !pace?.warmup) return null;
	const { warmup } = pace;
	return {
		id: "warmup",
		label: hours ? `Goes out over ${formatCount(hours, "hour")}` : "Sends now",
		detail: warmup ? (warmup.hasStarted ? `Warm-up day ${warmup.day} of ${warmup.days}` : "Starts the warm-up") : null,
		isOk: true,
		icon: IconWarmup,
	};
}

function TitleCampaign({ title, newsletter, status }) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<Link
				href="/campaigns"
				aria-label="Back"
				className="-ml-2 grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
			>
				<ChevronLeft className="size-5" />
			</Link>
			<AvatarNewsletter newsletter={newsletter} size={24} />
			<h1 className="truncate text-lg font-semibold tracking-tight lg:text-base">{title || "Untitled"}</h1>
			<BadgeStatus status={status} />
		</div>
	);
}

function MenuMore({ isWorking, onDuplicate, onDiscard }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" aria-label="More" disabled={isWorking}>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={onDuplicate}>
					<Copy />
					Duplicate
				</DropdownMenuItem>
				<DropdownMenuItem variant="destructive" onSelect={onDiscard}>
					<Trash2 />
					Discard
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// The step's one button, with what it waits for, or the step's status, next to it. The width doesn't change from a
// step to the next.
function BarAction({ action, status, className }) {
	const statusId = useId();
	const Icon = action.icon;

	return (
		<div className={cn("flex min-w-0 items-center gap-3", className)}>
			<div id={statusId} className="flex min-w-0 flex-1 items-center justify-start gap-1 lg:justify-end">
				{status}
			</div>
			<Button
				onClick={action.onClick}
				disabled={Boolean(action.problem) || action.isPending}
				aria-describedby={action.problem ? statusId : undefined}
				className="min-w-32"
			>
				{action.isPending ? (
					<Loader2 className="animate-spin" />
				) : action.isIconAfter ? (
					<>
						{action.label}
						<Icon data-icon="inline-end" />
					</>
				) : (
					<>
						<Icon data-icon="inline-start" />
						{action.label}
					</>
				)}
			</Button>
		</div>
	);
}

function TextProblem({ children }) {
	return (
		<span className="flex min-w-0 items-center gap-1.5 text-xs leading-snug text-muted-foreground">
			<CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="line-clamp-2 text-pretty lg:max-w-48">{children}</span>
		</span>
	);
}

function ButtonFix({ fix, onEdit, onTest, isTesting, isTestDisabled }) {
	if (fix.href) {
		return (
			<Button asChild variant="outline" size="sm">
				<Link href={fix.href}>{fix.label}</Link>
			</Button>
		);
	}
	if (fix.action === "test") {
		return (
			<Button variant="outline" size="sm" onClick={onTest} disabled={isTestDisabled || isTesting} className="min-w-24">
				{isTesting ? <Loader2 className="animate-spin" /> : fix.label}
			</Button>
		);
	}
	return (
		<Button variant="outline" size="sm" onClick={() => onEdit(fix.field)}>
			{fix.label}
		</Button>
	);
}

function ButtonRow({ icon: Icon, title, description, onClick, isDisabled = false, isPending = false }) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={isDisabled || isPending}
			className="group/row flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:bg-muted/40 disabled:pointer-events-none disabled:opacity-50"
		>
			<span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
				<Icon className="size-4" aria-hidden="true" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-medium">{title}</span>
				<span className="block truncate text-sm text-muted-foreground">{description}</span>
			</span>
			{isPending ? (
				<Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
			) : (
				<ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover/row:translate-x-0.5" />
			)}
		</button>
	);
}

function StatusSave({ isSaving, error, onRetry }) {
	if (error) {
		return (
			<button
				type="button"
				onClick={onRetry}
				title={error}
				className="flex items-center gap-1.5 text-xs text-destructive hover:underline"
			>
				<CircleAlert className="size-3.5" />
				Not saved, retry
			</button>
		);
	}
	return (
		<span aria-live="polite" className="flex min-w-16 items-center gap-1.5 text-xs text-muted-foreground lg:justify-end">
			{isSaving ? (
				"Saving…"
			) : (
				<>
					<Check className="size-3.5" />
					Saved
				</>
			)}
		</span>
	);
}
