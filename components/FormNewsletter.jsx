"use client";

import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { Check, ExternalLink, FlaskConical, Loader2, X } from "lucide-react";
import { checkSlug, saveNewsletter, sendWelcomeTest } from "@/app/(app)/newsletters/actions";
import BarSave from "@/components/BarSave";
import ButtonCopy from "@/components/ButtonCopy";
import InputImage from "@/components/InputImage";
import NoticeWelcomePaused from "@/components/NoticeWelcomePaused";
import PreviewBrand from "@/components/PreviewBrand";
import PreviewEmail from "@/components/PreviewEmail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FONT_PAIRS, THEME_IDS } from "@/lib/brand";
import { THEMES } from "@/lib/site-themes";
import { CLEANUP_LIMITS, LAST_CHANCE_DAYS, getCleanupSettings } from "@/lib/cleanup";
import { CONFIRM_URL_PLACEHOLDER } from "@/lib/confirmation-content";
import { formatNumber } from "@/lib/format";
import { KEEP_URL_PLACEHOLDER, getLastChanceContent } from "@/lib/last-chance-content";
import {
	getDraftConfirmation,
	getDraftFromEmail,
	getDraftKey,
	getNewsletterDraft,
	getSlugChanges,
	getWebsiteAddress,
} from "@/lib/newsletter-form";
import { getSlugFormatProblem } from "@/lib/newsletter-settings";
import { MAX_AUTHOR_BIO_LENGTH, MAX_DESCRIPTION_LENGTH } from "@/lib/newsletters";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail } from "@/lib/render-email";
import { getSharedAddress } from "@/lib/sender-rules";
import { slugify } from "@/lib/slug";
import { toast } from "@/lib/toast";
import { usePaywall } from "@/lib/use-paywall";
import { cn } from "@/lib/utils";
import { prefillWelcome } from "@/lib/welcome-content";

const IMAGE_PREVIEW_PATTERN = /^(https:\/\/\S+\.\S{2,}\/\S+|\/\S+\.\w{3,4})$/;

// welcomePause: the notice to show while the month's emails are used up and welcome emails are skipped. It saves from
// onSubmit, not a form action: React resets a form after its action, which turned the switches back to how the page
// opened and dropped what an error refused. Discard goes back to what the newsletter has saved.
// defaultPostalAddress: what its emails print until it has its own (lib/postal-address.js); the editor's checks link
// to the field with #postal-address. hasArchiveHost: the server hosts websites on customers' own subdomains.
// hasSentIssue: an issue went out, so the website can be live (lib/archive-data.js).
export default function FormNewsletter({
	newsletter,
	domains,
	sharedDomain,
	appUrl,
	hasArchiveHost,
	hasSentIssue,
	defaultPostalAddress,
	isSendingEnabled,
	testEmail,
	cleanupTotals,
	welcomePause,
}) {
	const paywall = usePaywall();
	const hasPlan = paywall?.hasPlan ?? true;
	const slugId = useId();
	const postalAddressRef = useRef(null);
	const [draft, setDraft] = useState(() => getNewsletterDraft({ newsletter, domains, sharedDomain, defaultPostalAddress }));
	const draftKey = getDraftKey(draft, { newsletter, sharedDomain });
	const [savedKey, setSavedKey] = useState(draftKey);
	const [savedAt, setSavedAt] = useState(null);
	// The image inputs keep their own URL: a discard starts them over.
	const [discardCount, setDiscardCount] = useState(0);
	const [isSaving, startSaving] = useTransition();
	const [isTesting, startTesting] = useTransition();
	const { name, description, accentColor, isPreferencesLinked, slug, fromName, fromLocal, fromDomain, imageUrl, postalAddress, isConfirmationRequired, confirmationEdits, isWelcomeEnabled, welcome, isArchiveEnabled, isCleanupEnabled, cleanup } = draft;
	const savedCleanup = getCleanupSettings(newsletter);
	const deferredWelcome = useDeferredValue(welcome);
	const deferredPostalAddress = useDeferredValue(postalAddress);
	const sharedAddress = sharedDomain ? getSharedAddress(slug || "slug", sharedDomain) : null;
	const fromEmail = getDraftFromEmail(draft, sharedDomain);
	const isDirty = draftKey !== savedKey;
	const savedSlug = newsletter?.slug ?? "";
	const archiveHost = newsletter?.archiveHost;
	const websiteAddress = getWebsiteAddress({ slug: savedSlug || slug || "slug", archiveHost }, { sharedDomain, appUrl });
	const slugCheck = useSlugCheck({ slug, savedSlug, newsletterId: newsletter?._id });

	useEffect(() => {
		if (window.location.hash === `#${POSTAL_ADDRESS_ID}`) postalAddressRef.current?.focus();
	}, []);

	const welcomeHtml = useMemo(
		() =>
			renderEmail({
				markdown: deferredWelcome.markdown,
				subject: deferredWelcome.subject,
				previewText: deferredWelcome.previewText,
				newsletter: { name, postalAddress: deferredPostalAddress },
			}).html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#"),
		[deferredWelcome, name, deferredPostalAddress]
	);

	const confirmation = useMemo(
		() => getDraftConfirmation({ name, description, confirmationEdits }, newsletter),
		[name, description, confirmationEdits, newsletter]
	);
	const deferredConfirmation = useDeferredValue(confirmation);
	const confirmationHtml = useMemo(
		() =>
			renderEmail({ ...deferredConfirmation, newsletter: { name, postalAddress: deferredPostalAddress } })
				.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#")
				.replaceAll(CONFIRM_URL_PLACEHOLDER, "#"),
		[deferredConfirmation, name, deferredPostalAddress]
	);

	const lastChance = useMemo(() => {
		const content = getLastChanceContent({ name, fromEmail });
		const { html } = renderEmail({ ...content, newsletter: { name, postalAddress: deferredPostalAddress } });
		return {
			...content,
			html: html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#").replaceAll(KEEP_URL_PLACEHOLDER, "#"),
		};
	}, [name, fromEmail, deferredPostalAddress]);

	const previewImageUrl = IMAGE_PREVIEW_PATTERN.test(imageUrl) ? imageUrl : "";
	const brandPreview = useMemo(
		() => ({
			name,
			description,
			imageUrl: previewImageUrl,
			fromName,
			fromEmail,
			postalAddress: deferredPostalAddress,
			accentColor: /^#[0-9a-f]{6}$/i.test(accentColor) ? accentColor.toLowerCase() : "",
			brand: { theme: draft.theme, fontPair: draft.fontPair, headerUrl: draft.headerUrl, emailLogo: draft.isEmailLogo },
		}),
		[name, description, previewImageUrl, fromName, fromEmail, deferredPostalAddress, accentColor, draft.theme, draft.fontPair, draft.headerUrl, draft.isEmailLogo]
	);
	const isShared = Boolean(sharedDomain) && fromDomain === sharedDomain;
	const isDomainUnverified = !isShared && domains.some(({ domain, verified }) => domain === fromDomain && !verified);
	const fromHint = getFromHint({ isShared, isDomainUnverified, fromDomain, hasDomains: domains.length > 0 });

	function set(key, value) {
		setDraft((current) => ({ ...current, [key]: value }));
	}

	function update(key) {
		return (event) => set(key, event.target.value);
	}

	function updateConfirmation(key) {
		return (event) => {
			const { value } = event.target;
			setDraft((current) => ({ ...current, confirmationEdits: { ...(current.confirmationEdits ?? confirmation), [key]: value } }));
		};
	}

	function updateWelcome(key) {
		return (event) => {
			const { value } = event.target;
			setDraft((current) => ({ ...current, welcome: { ...current.welcome, [key]: value } }));
		};
	}

	function switchWelcome(isEnabled) {
		setDraft((current) => ({
			...current,
			isWelcomeEnabled: isEnabled,
			welcome: isEnabled ? prefillWelcome(current.welcome, { name: current.name, description: current.description }) : current.welcome,
		}));
	}

	function updateCleanup(key) {
		return (event) => {
			const { value } = event.target;
			setDraft((current) => ({ ...current, cleanup: { ...current.cleanup, [key]: value } }));
		};
	}

	function save(event) {
		event.preventDefault();
		const formData = new FormData(event.currentTarget);
		startSaving(async () => {
			const result = await saveNewsletter(null, formData);
			if (result?.error) return void toast.error(result.error);
			setSavedKey(draftKey);
			setSavedAt(result.savedAt);
		});
	}

	function discard() {
		const saved = getNewsletterDraft({ newsletter, domains, sharedDomain, defaultPostalAddress });
		setDraft(saved);
		setSavedKey(getDraftKey(saved, { newsletter, sharedDomain }));
		setSavedAt(null);
		setDiscardCount((count) => count + 1);
	}

	function sendTest() {
		if (!hasPlan) return paywall.open("test");
		startTesting(async () => {
			const result = await sendWelcomeTest(newsletter._id);
			if (result?.error) toast.error(result.error);
			else toast.success(`Test sent to ${testEmail}`);
		});
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			{newsletter && <input type="hidden" name="id" value={newsletter._id} />}

			<Section title="General" stagger={0}>
				<Field label="Name">
					<Input
						name="name"
						value={name}
						required
						placeholder="Field notes"
						onChange={(event) => {
							const { value } = event.target;
							setDraft((current) => ({ ...current, name: value, ...(!current.isSlugEdited && { slug: slugify(value) }) }));
						}}
					/>
				</Field>
				<Field label="Slug" htmlFor={slugId}>
					<span className="relative flex">
						<Input
							id={slugId}
							name="slug"
							value={slug}
							required
							placeholder="field-notes"
							aria-invalid={slugCheck.message ? true : undefined}
							aria-describedby={slugCheck.status === "saved" ? undefined : `${slugId}-check`}
							className="pr-9 font-mono"
							onChange={(event) => {
								const { value } = event.target;
								setDraft((current) => ({ ...current, slug: value, isSlugEdited: true }));
							}}
						/>
						<IconSlugCheck status={slugCheck.status} />
					</span>
					{slugCheck.status !== "saved" && (
						<span id={`${slugId}-check`} className="flex flex-col gap-2">
							<span aria-live="polite" className={cn("text-xs", slugCheck.message ? "text-red-600 dark:text-red-400" : "sr-only")}>
								{slugCheck.message ?? (slugCheck.status === "available" ? `${slug.trim().toLowerCase()} is available` : "")}
							</span>
							{newsletter && (
								<ListSlugChanges
									changes={getSlugChanges({
										slug: slug.trim().toLowerCase(),
										savedSlug,
										archiveHost,
										isShared,
										sharedDomain,
										appUrl,
									})}
								/>
							)}
						</span>
					)}
				</Field>
				<Field label="Image" hint="Square logo, 128×128 or larger">
					<InputImage
						key={discardCount}
						name="imageUrl"
						defaultValue={imageUrl}
						label="newsletter image"
						onChange={(value) => set("imageUrl", value)}
					/>
				</Field>
			</Section>

			<Section title="Brand" stagger={1}>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					One look for your website and your emails. The logo is the image above; readers see the rest in every issue.
				</p>
				<Field label="Accent color" hint="Buttons, links and poll answers, on the website and in emails. A pale color gets a darker shade for text." as="div">
					<span className="flex items-center gap-2">
						<input
							type="color"
							value={/^#[0-9a-f]{6}$/i.test(accentColor) ? accentColor : "#18181b"}
							onChange={(event) => set("accentColor", event.target.value)}
							aria-label="Pick the accent color"
							className="size-9 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-1"
						/>
						<Input name="accentColor" value={accentColor} onChange={update("accentColor")} placeholder="#18181b" maxLength={7} className="w-32 font-mono" aria-label="Accent color" />
					</span>
				</Field>
				<Field label="Theme" as="div">
					<input type="hidden" name="theme" value={draft.theme} />
					<div role="radiogroup" aria-label="Theme" className="grid gap-2 sm:grid-cols-2">
						{THEME_IDS.map((id) => (
							<ChoiceCard key={id} isSelected={draft.theme === id} onSelect={() => set("theme", id)} title={THEMES[id].label} description={THEMES[id].description} />
						))}
					</div>
				</Field>
				<Field label="Fonts" hint="Fonts every device has, so the email looks like the website." as="div">
					<input type="hidden" name="fontPair" value={draft.fontPair} />
					<div role="radiogroup" aria-label="Fonts" className="grid gap-2 sm:grid-cols-2">
						{Object.entries(FONT_PAIRS).map(([id, pair]) => (
							<ChoiceCard
								key={id}
								isSelected={draft.fontPair === id}
								onSelect={() => set("fontPair", id)}
								title={pair.label}
								titleStyle={{ fontFamily: pair.heading }}
								description={pair.description}
							/>
						))}
					</div>
				</Field>
				<Field label="Header image" hint="Wide, about 3 to 1. Above the issue in emails and at the top of your website." as="div">
					<InputImage key={discardCount} name="headerUrl" defaultValue={draft.headerUrl} label="header image" onChange={(value) => set("headerUrl", value)} />
				</Field>
				<Field label="Email header" hint="The logo and your name above every issue. Without it, issues open with the text." as="div">
					<span className="flex items-center gap-2 text-sm">
						<Switch name="emailLogo" checked={draft.isEmailLogo} onCheckedChange={(isChecked) => set("isEmailLogo", isChecked)} aria-label="Show the logo and name above every issue" />
						Show the logo and name
					</span>
				</Field>
				<PreviewBrand newsletter={brandPreview} />
			</Section>

			<Section title="Sender" stagger={2}>
				<Field label="From name">
					<Input name="fromName" value={fromName} placeholder="Jane Doe" onChange={update("fromName")} />
				</Field>
				<Field label="From email" hint={fromHint} isWarning={isDomainUnverified}>
					<span className="flex flex-wrap items-center gap-2">
						<span className="flex items-center gap-2">
							<Input
								value={isShared ? sharedAddress.split("@")[0] : fromLocal}
								readOnly={isShared}
								required
								aria-label="From email name"
								placeholder="hi"
								className={cn("w-32 font-mono", isShared && "text-muted-foreground")}
								onChange={(event) => set("fromLocal", event.target.value.trim())}
							/>
							<span className="text-sm text-muted-foreground">@</span>
						</span>
						{/* The shared domain has the slug in it, so it can be wider than the column. */}
						<Select value={fromDomain} onValueChange={(value) => set("fromDomain", value)}>
							<SelectTrigger
								className="min-h-9 min-w-0 flex-auto py-1.5 text-left font-mono whitespace-normal wrap-anywhere data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none"
								aria-label="From domain"
							>
								<SelectValue placeholder="Add a domain first" />
							</SelectTrigger>
							<SelectContent className="max-w-[calc(100vw-20px)] wrap-anywhere">
								{sharedDomain && <SelectItem value={sharedDomain}>{sharedAddress.split("@")[1]}</SelectItem>}
								{domains.map(({ domain }) => (
									<SelectItem key={domain} value={domain}>
										{domain}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</span>
					<input type="hidden" name="fromEmail" value={fromEmail} />
				</Field>
				<Field label="Reply-to">
					<Input name="replyTo" type="email" value={draft.replyTo} placeholder="Optional" onChange={update("replyTo")} />
				</Field>
				<Field
					label="Postal address"
					htmlFor={POSTAL_ADDRESS_ID}
					hint={
						defaultPostalAddress && postalAddress === defaultPostalAddress ? (
							"FlockStack's address is used by default. Replace it with yours anytime."
						) : postalAddress.trim() ? (
							"Shown in the footer of every email. Anti-spam laws require one."
						) : (
							<>
								Shown in the footer of every email. Anti-spam laws require one, so sending waits for it.
								{defaultPostalAddress && (
									<>
										{" "}
										<button
											type="button"
											onClick={() => set("postalAddress", defaultPostalAddress)}
											className="font-medium text-link underline decoration-link/30 underline-offset-2 transition-colors duration-150 hover:decoration-link"
										>
											Use FlockStack&apos;s address
										</button>
									</>
								)}
							</>
						)
					}
				>
					<Textarea
						ref={postalAddressRef}
						id={POSTAL_ADDRESS_ID}
						name="postalAddress"
						value={postalAddress}
						rows={2}
						placeholder="Company name, street, city, country"
						className="scroll-mt-28"
						onChange={update("postalAddress")}
					/>
				</Field>
				<Field label="Preferences link" hint="Readers change the fields marked Readers edit, and unsubscribe, on their own page. {{preferences_url}} puts the link in a body." as="div">
					<span className="flex items-center gap-2 text-sm">
						<Switch name="preferencesLink" checked={isPreferencesLinked} onCheckedChange={(isChecked) => set("isPreferencesLinked", isChecked)} aria-label="Link to the preference center in every email's footer" />
						In every email&apos;s footer
					</span>
				</Field>
			</Section>

			<Section
				title="Confirm new signups"
				stagger={3}
				action={
					<Switch
						name="requireConfirmation"
						checked={isConfirmationRequired}
						onCheckedChange={(isChecked) => set("isConfirmationRequired", isChecked)}
						aria-label="Confirm new signups"
					/>
				}
			>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					New subscribers get this email and only join once they click its button, so fake and mistyped
					addresses never reach the list. It&apos;s the only email they get: say what comes next.
				</p>
				{isConfirmationRequired && (
					<>
						<Field label="Subject">
							<Input
								name="confirmationSubject"
								value={confirmation.subject}
								required
								onChange={updateConfirmation("subject")}
							/>
						</Field>
						<Field label="Preview text">
							<Input
								name="confirmationPreviewText"
								value={confirmation.previewText}
								placeholder="Optional"
								onChange={updateConfirmation("previewText")}
							/>
						</Field>
						<Field
							label="Content"
							hint={`Markdown. Keep the button: its ${CONFIRM_URL_PLACEHOLDER} becomes each subscriber's link.`}
						>
							<Textarea
								name="confirmationMarkdown"
								value={confirmation.markdown}
								onChange={updateConfirmation("markdown")}
								className="min-h-48 font-mono text-[13px] leading-6"
							/>
						</Field>
						<Field label="Reminder" as="div" hint="Sent once, the same email with Reminder: in its subject, to signups that haven't confirmed by then.">
							<span className="flex items-center gap-3">
								<Switch
									name="confirmationReminderEnabled"
									checked={draft.isReminderEnabled}
									onCheckedChange={(isChecked) => set("isReminderEnabled", isChecked)}
									aria-label="Remind signups that haven't confirmed"
								/>
								<Input
									name="confirmationReminderHours"
									type="number"
									min={6}
									max={168}
									value={draft.reminderHours}
									onChange={update("reminderHours")}
									disabled={!draft.isReminderEnabled}
									aria-label="Hours after signing up"
									className="w-24 tabular-nums"
								/>
								<span className="text-sm text-muted-foreground">hours after signing up</span>
							</span>
						</Field>
						<Field label="After confirming" hint="Readers land on this page once they confirm. Empty: FlockStack's own page.">
							<Input
								name="confirmedRedirectUrl"
								type="url"
								value={draft.confirmedRedirectUrl}
								placeholder="https://"
								onChange={update("confirmedRedirectUrl")}
							/>
						</Field>
						<div className="p-3">
							<PreviewEmail
								html={confirmationHtml}
								sender={{ name, fromName, fromEmail, imageUrl: previewImageUrl }}
								subject={deferredConfirmation.subject}
								previewText={deferredConfirmation.previewText}
								fit="content"
							/>
						</div>
					</>
				)}
			</Section>

			<Section
				title="Welcome email"
				stagger={4}
				collapsedNote={
					isConfirmationRequired &&
					"Not sent while new signups confirm, since the confirmation email replaces it. Its content is kept."
				}
				action={
					<Switch
						name="welcomeEnabled"
						checked={isWelcomeEnabled}
						onCheckedChange={switchWelcome}
						aria-label="Welcome email"
					/>
				}
			>
				{welcomePause && isWelcomeEnabled && <NoticeWelcomePaused {...welcomePause} className="px-4 py-3" />}
				<Field label="Subject">
					<Input name="welcomeSubject" value={welcome.subject} onChange={updateWelcome("subject")} />
				</Field>
				<Field label="Preview text">
					<Input
						name="welcomePreviewText"
						value={welcome.previewText}
						placeholder="Optional"
						onChange={updateWelcome("previewText")}
					/>
				</Field>
				<Field label="Content" hint="Markdown">
					<Textarea
						name="welcomeMarkdown"
						value={welcome.markdown}
						onChange={updateWelcome("markdown")}
						className="min-h-48 font-mono text-[13px] leading-6"
					/>
				</Field>
				{deferredWelcome.markdown.trim() && (
					<div className="p-3">
						<PreviewEmail
							html={welcomeHtml}
							sender={{ name, fromName, fromEmail, imageUrl: previewImageUrl }}
							subject={deferredWelcome.subject}
							previewText={deferredWelcome.previewText}
							fit="content"
						/>
					</div>
				)}
				{newsletter && (
					<div className="flex items-center justify-between gap-3 px-4 py-3">
						<p className="text-xs wrap-anywhere text-muted-foreground">
							{isSendingEnabled || !hasPlan ? `Sends the saved version to ${testEmail}` : "Sending is off"}
						</p>
						<Button type="button" variant="outline" size="sm" onClick={sendTest} disabled={(hasPlan && !isSendingEnabled) || isTesting}>
							{isTesting ? <Loader2 className="animate-spin" /> : <FlaskConical />}
							Send test
						</Button>
					</div>
				)}
			</Section>

			<Section
				title="List cleanup"
				stagger={5}
				action={
					<Switch
						name="cleanupEnabled"
						checked={isCleanupEnabled}
						onCheckedChange={(isChecked) => set("isCleanupEnabled", isChecked)}
						aria-label="List cleanup"
					/>
				}
			>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Stops sending to contacts who stopped opening, unless they answer a last-chance email. Each time you send an
					issue, contacts who ignored the last {cleanup.issues || savedCleanup.issues} issues and showed no sign of life
					for {cleanup.days || savedCleanup.days} days get this email instead. A click
					on its button keeps them. Anyone who doesn&apos;t answer by a send{" "}
					{LAST_CHANCE_DAYS} days later becomes dormant: not unsubscribed, not deleted, and back if they sign up again.
				</p>
				<Field label="Ignored issues" hint="In a row, counting from the first issue FlockStack sent">
					<Input
						name="cleanupIssues"
						type="number"
						inputMode="numeric"
						min={CLEANUP_LIMITS.minIssues}
						max={CLEANUP_LIMITS.maxIssues}
						value={cleanup.issues}
						onChange={updateCleanup("issues")}
						className="w-28 tabular-nums"
					/>
				</Field>
				<Field label="Quiet for" hint="Days since the last open, click or signup">
					<span className="flex items-center gap-2">
						<Input
							name="cleanupDays"
							type="number"
							inputMode="numeric"
							min={CLEANUP_LIMITS.minDays}
							max={CLEANUP_LIMITS.maxDays}
							value={cleanup.days}
							onChange={updateCleanup("days")}
							className="w-28 tabular-nums"
						/>
						<span className="text-sm text-muted-foreground">days</span>
					</span>
				</Field>
				{cleanupTotals && <CleanupTotals totals={cleanupTotals} />}
				{isCleanupEnabled && (
					<div className="p-3">
						<PreviewEmail
							html={lastChance.html}
							sender={{ name, fromName, fromEmail, imageUrl: previewImageUrl }}
							subject={lastChance.subject}
							previewText={lastChance.previewText}
							fit="content"
						/>
					</div>
				)}
			</Section>

			<Section
				title="Website"
				stagger={6}
				action={
					<Switch
						name="archiveEnabled"
						checked={isArchiveEnabled}
						onCheckedChange={(isChecked) => set("isArchiveEnabled", isChecked)}
						aria-label="Website"
					/>
				}
			>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Every issue you send gets a page here, with a signup form.
					{hasArchiveHost && !archiveHost && " Add a domain on the Domains page to put it on your own subdomain."}
				</p>
				<Field
					label="Address"
					as="div"
					hint={
						!isArchiveEnabled ? (
							"Your website is off. Turn it on above to give every issue you send a page."
						) : !hasSentIssue ? (
							"Goes live after your first issue."
						) : !hasPlan ? (
							<>
								It goes online with a plan.{" "}
								<button
									type="button"
									onClick={() => paywall.open("website")}
									className="font-medium text-link underline decoration-link/30 underline-offset-2 transition-colors duration-150 hover:decoration-link"
								>
									Upgrade
								</button>
							</>
						) : !newsletter?.archiveEnabled ? (
							"It goes online when you save."
						) : null
					}
				>
					<span className="flex min-w-0 items-center gap-1.5 sm:min-h-9">
						{isArchiveEnabled && hasSentIssue && hasPlan && newsletter?.archiveEnabled ? (
							<a
								href={websiteAddress}
								target="_blank"
								rel="noreferrer"
								className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[13px] underline decoration-foreground/30 underline-offset-4 transition-colors duration-150 hover:decoration-foreground"
							>
								<span className="truncate">{websiteAddress}</span>
								<ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
							</a>
						) : (
							<span className="truncate font-mono text-[13px] text-muted-foreground/70">{websiteAddress}</span>
						)}
						<ButtonCopy value={websiteAddress} label="Copy address" />
					</span>
				</Field>
				<Field label="Description" hint="One sentence under the name and in the subscribe popup">
					<Textarea
						name="description"
						value={description}
						rows={2}
						maxLength={MAX_DESCRIPTION_LENGTH}
						placeholder="One idea about building things, every Sunday."
						onChange={update("description")}
					/>
				</Field>
				<Field label="Author bio" hint="Under your name on the author page">
					<Input
						name="authorBio"
						value={draft.authorBio}
						maxLength={MAX_AUTHOR_BIO_LENGTH}
						placeholder="I write about building small software companies."
						onChange={update("authorBio")}
					/>
				</Field>
				<Field label="Author photo" hint="Square photo on the author page. The newsletter image otherwise.">
					<InputImage
						key={discardCount}
						name="authorImageUrl"
						defaultValue={draft.authorImageUrl}
						label="author photo"
						onChange={(value) => set("authorImageUrl", value)}
					/>
				</Field>
				<Field label="Social links" hint="One link per line">
					<Textarea
						name="socialLinks"
						value={draft.socialLinks}
						rows={3}
						placeholder={"https://x.com/example\nhttps://youtube.com/@example"}
						className="font-mono text-[13px] leading-6"
						onChange={update("socialLinks")}
					/>
				</Field>
			</Section>

			<BarSave isDirty={isDirty} isSaving={isSaving} savedAt={savedAt} onDiscard={discard} label={newsletter ? "Save" : "Create"} />
		</form>
	);
}

// With a collapsedNote, the note stands in for the action and the fields, which aren't sent with the form.
function Section({ title, action, stagger, collapsedNote, children }) {
	return (
		<section style={{ "--stagger": stagger }} className="rounded-xl bg-card shadow-border animate-enter">
			<div className="flex h-12 items-center justify-between gap-3 px-4">
				<h2 className="text-sm font-medium">{title}</h2>
				{!collapsedNote && action}
			</div>
			{collapsedNote ? (
				<p className="border-t border-border/60 px-4 py-3 text-sm text-pretty text-muted-foreground">
					{collapsedNote}
				</p>
			) : (
				children && <div className="divide-y divide-border/60 border-t border-border/60">{children}</div>
			)}
		</section>
	);
}

// A choice among a few, as a radio: the theme and the font pair.
function ChoiceCard({ isSelected, onSelect, title, titleStyle, description }) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={isSelected}
			onClick={onSelect}
			className={cn(
				"flex flex-col gap-0.5 rounded-xl px-3.5 py-3 text-left outline-none transition-[box-shadow,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
				isSelected ? "bg-muted shadow-[0_0_0_2px_var(--foreground)]" : "shadow-border hover:shadow-border-hover"
			)}
		>
			<span style={titleStyle} className="text-sm font-semibold">
				{title}
			</span>
			<span className="text-xs text-pretty text-muted-foreground">{description}</span>
		</button>
	);
}

function CleanupTotals({ totals }) {
	const stats = [
		{ label: "Waiting for an answer", value: totals.waiting },
		{ label: "Kept after the email", value: totals.kept },
		{ label: "Made dormant", value: totals.dormant },
	];
	return (
		<dl className="grid grid-cols-3 divide-x divide-border/60">
			{stats.map(({ label, value }) => (
				<div key={label} className="flex flex-col gap-1 px-4 py-3">
					<dt className="text-xs text-pretty text-muted-foreground">{label}</dt>
					<dd className="text-lg font-semibold tabular-nums">{formatNumber(value)}</dd>
				</div>
			))}
		</dl>
	);
}

function getFromHint({ isShared, isDomainUnverified, fromDomain, hasDomains }) {
	if (isShared) return "The shared address follows the slug and needs no setup. Replies go to the reply-to, or to your account email.";
	if (isDomainUnverified) return `${fromDomain} isn't verified yet. Emails wait until its DNS records are in.`;
	if (!fromDomain && !hasDomains) return "Add a domain on the Domains page to send from it";
	return null;
}

// The whole row is the field's label, unless it holds more than the field (buttons, a list): then only its name is,
// for htmlFor, and as="div" has no field to name.
function Field({ label, hint, isWarning, htmlFor, as, children }) {
	const Row = htmlFor || as === "div" ? "div" : "label";
	const Name = htmlFor ? "label" : "span";
	return (
		<Row className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
			<Name htmlFor={htmlFor} className="text-sm text-muted-foreground sm:pt-2">
				{label}
			</Name>
			<span className="flex min-w-0 flex-col gap-1.5">
				{children}
				{hint && (
					<span
						className={cn(
							"text-xs",
							isWarning ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
						)}
					>
						{hint}
					</span>
				)}
			</span>
		</Row>
	);
}

// Inside the slug field, at its end: a spinner while it's checked, then whether it's free.
function IconSlugCheck({ status }) {
	if (status === "saved") return null;
	const Icon = status === "checking" ? Loader2 : status === "available" ? Check : X;
	return (
		<Icon
			key={status}
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2",
				status === "checking" ? "animate-spin text-muted-foreground" : "animate-icon-in",
				status === "available" && "text-emerald-600 dark:text-emerald-400",
				(status === "unavailable" || status === "error") && "text-red-600 dark:text-red-400"
			)}
		/>
	);
}

function ListSlugChanges({ changes }) {
	return (
		<span className="flex flex-col gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground animate-enter">
			<span className="font-medium text-foreground">Changing the slug</span>
			<ul className="flex list-disc flex-col gap-1 pl-4 text-pretty marker:text-muted-foreground/60">
				{changes.map((change) => (
					<li key={change}>{change}</li>
				))}
			</ul>
		</span>
	);
}

// While the slug isn't the saved one, it's checked once typing pauses: its format here, then on the server whether
// another newsletter has it. An answer counts for the slug it was asked for.
function useSlugCheck({ slug, savedSlug, newsletterId }) {
	const value = slug.trim().toLowerCase();
	const isChanged = Boolean(value) && value !== savedSlug;
	const [answer, setAnswer] = useState(null);

	useEffect(() => {
		if (!isChanged) return;
		let isCurrent = true;
		const timeout = setTimeout(async () => {
			const problem = getSlugFormatProblem(value);
			const result = problem
				? { available: false, ...problem }
				: await checkSlug(value, newsletterId).catch(() => ({ error: "Couldn't check the slug. Saving checks it again." }));
			if (isCurrent) setAnswer({ slug: value, ...result });
		}, SLUG_CHECK_DELAY_MS);
		return () => {
			isCurrent = false;
			clearTimeout(timeout);
		};
	}, [value, isChanged, newsletterId]);

	if (!isChanged) return { status: "saved" };
	if (answer?.slug !== value) return { status: "checking" };
	if (answer.error) return { status: "error", message: answer.error };
	return answer.available ? { status: "available" } : { status: "unavailable", message: answer.message };
}

const POSTAL_ADDRESS_ID = "postal-address";
const SLUG_CHECK_DELAY_MS = 350;
