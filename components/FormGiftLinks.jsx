"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { makeGiftLink, revokeGiftLink, saveGiftLinkSettings } from "@/app/(app)/gift-links/actions";
import BadgeStatus from "@/components/BadgeStatus";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatDate } from "@/lib/format";
import { GIFT_LINK_LIMITS } from "@/lib/gift-link-rules";
import { toast } from "@/lib/toast";

// Gift links to single paid issues (lib/gift-links.js): what paid subscribers may share, a link of your own, and every link with
// how many browsers opened it and a way to take it back.
export default function FormGiftLinks({ newsletter, settings, links, issues }) {
	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-pretty text-muted-foreground">
				A gift link opens one paid issue&apos;s page for whoever holds it, with no subscription. The rest of your archive, the email, the comments and the audio stay closed. Each link opens in a
				limited number of browsers, ends on its date, and you can take it back at once.
			</p>
			<FormSettings newsletter={newsletter} settings={settings} />
			<FormMake newsletter={newsletter} settings={settings} issues={issues} />
			<ListLinks links={links} />
		</div>
	);
}

function FormSettings({ newsletter, settings }) {
	const [state, action, isPending] = useActionState(saveGiftLinkSettings, null);
	const { opens, days, perReaderPerMonth } = GIFT_LINK_LIMITS;
	return (
		<form action={action}>
			<input type="hidden" name="newsletter" value={newsletter} />
			<CardSettings
				title="Paid subscribers"
				action={
					<Button type="submit" size="sm" disabled={isPending}>
						{isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
						Save
					</Button>
				}
			>
				<RowSettings label="Sharing" hint="A paid subscriber who reads a paid issue on your website can make a link to it.">
					<span className="flex items-center gap-2 text-sm">
						<Switch name="enabled" defaultChecked={settings.enabled} aria-label="Paid subscribers can make gift links" />
						Let them make links
					</span>
				</RowSettings>
				<RowSettings label="Links a month" hint="Each subscriber, counted from the first of the month (UTC)." isLabel>
					<Input name="perReaderPerMonth" type="number" min={perReaderPerMonth.min} max={perReaderPerMonth.max} defaultValue={settings.perReaderPerMonth} className="w-28 tabular-nums" />
				</RowSettings>
				<RowSettings label="Browsers" hint="A browser counts once, however often it reads the issue." isLabel>
					<Input name="opensPerLink" type="number" min={opens.min} max={opens.max} defaultValue={settings.opensPerLink} className="w-28 tabular-nums" />
				</RowSettings>
				<RowSettings label="Days" hint="How long a link works." isLabel>
					<Input name="days" type="number" min={days.min} max={days.max} defaultValue={settings.days} className="w-28 tabular-nums" />
				</RowSettings>
				{state?.error && (
					<p role="alert" className="px-4 py-3 text-sm text-destructive">
						{state.error}
					</p>
				)}
				{state?.ok && (
					<p role="status" className="px-4 py-3 text-sm text-muted-foreground">
						Saved
					</p>
				)}
			</CardSettings>
		</form>
	);
}

function FormMake({ newsletter, settings, issues }) {
	const [state, action, isPending] = useActionState(makeGiftLink, null);
	const { opens, days } = GIFT_LINK_LIMITS;
	return (
		<form action={action}>
			<input type="hidden" name="newsletter" value={newsletter} />
			<CardSettings
				title="Make a link"
				action={
					<Button type="submit" size="sm" disabled={isPending || issues.length === 0}>
						{isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
						Make link
					</Button>
				}
			>
				{issues.length === 0 ? (
					<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">No sent paid issue has a page on your website yet.</p>
				) : (
					<>
						<RowSettings label="Issue" isLabel>
							<select name="campaign" required className="h-9 w-full rounded-lg bg-transparent px-2.5 text-sm shadow-border">
								{issues.map(({ id, subject }) => (
									<option key={id} value={id}>
										{subject}
									</option>
								))}
							</select>
						</RowSettings>
						<RowSettings label="Browsers" isLabel>
							<Input name="opens" type="number" min={opens.min} max={opens.max} placeholder={String(settings.opensPerLink)} className="w-28 tabular-nums" />
						</RowSettings>
						<RowSettings label="Days" isLabel>
							<Input name="days" type="number" min={days.min} max={days.max} placeholder={String(settings.days)} className="w-28 tabular-nums" />
						</RowSettings>
						<RowSettings label="Note" hint="Only you see it." isLabel>
							<Input name="note" maxLength={GIFT_LINK_LIMITS.note} placeholder="For the reviewer" />
						</RowSettings>
					</>
				)}
				{state?.error && (
					<p role="alert" className="px-4 py-3 text-sm text-destructive">
						{state.error}
					</p>
				)}
				{state?.url && <CopyRow url={state.url} />}
			</CardSettings>
		</form>
	);
}

function CopyRow({ url }) {
	const [isCopied, setIsCopied] = useState(false);
	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 1500);
		} catch {
			toast.error("Couldn't copy. Select the link and copy it.");
		}
	}
	return (
		<div className="flex items-center gap-2 px-4 py-3">
			<input readOnly value={url} aria-label="Gift link" onFocus={(event) => event.target.select()} className="h-9 min-w-0 flex-1 rounded-lg bg-background px-3 text-sm shadow-border" />
			<Button type="button" variant="outline" size="sm" onClick={copy}>
				{isCopied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
				{isCopied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}

function ListLinks({ links }) {
	const [isPending, startTransition] = useTransition();
	function revoke(id) {
		startTransition(async () => {
			const result = await revokeGiftLink(id);
			if (result?.error) toast.error(result.error);
			else toast.success("Link taken back");
		});
	}
	return (
		<CardSettings title="Links">
			{links.length === 0 ? (
				<p className="px-4 py-3 text-sm text-muted-foreground">No gift links yet.</p>
			) : (
				links.map((link) => (
					<div key={link.id} className="flex flex-col gap-2 px-4 py-3 text-sm">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<span className="min-w-0 truncate font-medium">{link.issue.subject}</span>
							<span className="flex items-center gap-2">
								<BadgeStatus status={link.status} label={link.status === "used_up" ? "Used up" : undefined} />
								{(link.status === "active" || link.status === "used_up") && (
									<Button type="button" variant="outline" size="sm" onClick={() => revoke(link.id)} disabled={isPending}>
										Take back
									</Button>
								)}
							</span>
						</div>
						<p className="text-xs text-pretty text-muted-foreground tabular-nums">
							{link.createdBy === "reader" ? `Made by ${link.reader ?? "a subscriber"}` : "Made by you"}
							{link.note ? `, ${link.note}` : ""}. Opened in {link.opens} of {link.maxOpens} browsers. {link.status === "revoked" ? "Taken back." : `Ends ${formatDate(link.expiresAt)}.`}
						</p>
						{(link.status === "active" || link.status === "used_up") && <CopyRow url={link.url} />}
					</div>
				))
			)}
		</CardSettings>
	);
}
