"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Link2, Plus, Trash2 } from "lucide-react";
import { saveLinkPage } from "@/app/(app)/link-page/actions";
import BarSave from "@/components/BarSave";
import ButtonCopy from "@/components/ButtonCopy";
import CardSettings from "@/components/CardSettings";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { LINK_PAGE_LIMITS } from "@/lib/link-page";
import { toast } from "@/lib/toast";

let nextKey = 0;

function toDraft(page) {
	return { enabled: page.enabled, title: page.title, bio: page.bio, links: page.links.map((link) => ({ key: nextKey++, ...link })) };
}

function toSnapshot({ enabled, title, bio, links }) {
	return JSON.stringify([enabled, title, bio, links.map(({ label, url }) => [label, url])]);
}

// The link-in-bio page: a switch, a title and bio, and the links in order. Its address is /links on the website.
export default function FormLinkPage({ newsletterId, page }) {
	const [draft, setDraft] = useState(() => toDraft(page));
	const [saved, setSaved] = useState(() => toSnapshot(toDraft(page)));
	const [savedAt, setSavedAt] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const isDirty = toSnapshot(draft) !== saved;

	function set(patch) {
		setDraft((current) => ({ ...current, ...patch }));
	}

	function setLink(key, patch) {
		setDraft((current) => ({ ...current, links: current.links.map((link) => (link.key === key ? { ...link, ...patch } : link)) }));
	}

	function move(index, direction) {
		setDraft((current) => {
			const links = [...current.links];
			[links[index], links[index + direction]] = [links[index + direction], links[index]];
			return { ...current, links };
		});
	}

	function save(event) {
		event.preventDefault();
		startSaving(async () => {
			const result = await saveLinkPage({ newsletterId, ...draft });
			if (result?.error) return void toast.error(result.error);
			setSaved(toSnapshot(draft));
			setSavedAt(result.savedAt);
		});
	}

	function discard() {
		const fresh = toDraft(page);
		setDraft(fresh);
		setSaved(toSnapshot(fresh));
		setSavedAt(null);
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<CardSettings title="Link page" stagger={1} action={<Switch checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Link page" />}>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					A page of links for a profile that allows only one: your newsletter&apos;s signup first, then the links you list. It lives on your newsletter&apos;s
					website, which goes online with your first sent issue.
				</p>
				<div className="flex flex-wrap items-center gap-2 px-4 py-3">
					<code className="min-w-0 flex-1 truncate font-mono text-sm">{page.url}</code>
					<ButtonCopy value={page.url} label="Copy the page's address" />
					{page.isLive && (
						<Button asChild variant="outline" size="sm">
							<a href={page.url} target="_blank" rel="noreferrer">
								<ExternalLink data-icon="inline-start" />
								Open
							</a>
						</Button>
					)}
				</div>
				{draft.enabled && !page.enabled && <p className="px-4 pb-3 text-sm text-muted-foreground">Save to put it online.</p>}
			</CardSettings>

			<CardSettings title="Heading" stagger={2}>
				<div className="flex flex-col gap-2 px-4 py-3">
					<Input value={draft.title} maxLength={LINK_PAGE_LIMITS.title} onChange={(event) => set({ title: event.target.value })} placeholder="Title (your newsletter's name)" aria-label="Title" />
					<Textarea value={draft.bio} maxLength={LINK_PAGE_LIMITS.bio} rows={2} onChange={(event) => set({ bio: event.target.value })} placeholder="A line or two about you" aria-label="Bio" />
				</div>
			</CardSettings>

			<CardSettings
				title="Links"
				stagger={3}
				action={
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={draft.links.length >= LINK_PAGE_LIMITS.links}
						onClick={() => set({ links: [...draft.links, { key: nextKey++, label: "", url: "" }] })}
					>
						<Plus data-icon="inline-start" />
						Add link
					</Button>
				}
			>
				{draft.links.length === 0 && (
					<StateEmpty isCompact icon={Link2} title="No links yet">
						<span className="text-pretty text-muted-foreground">Add your shop, a podcast, your latest issue.</span>
					</StateEmpty>
				)}
				{draft.links.map((link, index) => (
					<div key={link.key} className="flex items-start gap-2 px-4 py-3">
						<div className="flex min-w-0 flex-1 flex-col gap-2">
							<Input value={link.label} maxLength={LINK_PAGE_LIMITS.label} onChange={(event) => setLink(link.key, { label: event.target.value })} placeholder="Button text" aria-label={`Text of link ${index + 1}`} />
							<Input value={link.url} onChange={(event) => setLink(link.key, { url: event.target.value })} placeholder="https://" inputMode="url" aria-label={`Address of link ${index + 1}`} />
						</div>
						<div className="flex shrink-0 flex-col">
							<Button type="button" variant="ghost" size="icon-xs" aria-label={`Move link ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>
								<ArrowUp />
							</Button>
							<Button type="button" variant="ghost" size="icon-xs" aria-label={`Move link ${index + 1} down`} disabled={index === draft.links.length - 1} onClick={() => move(index, 1)}>
								<ArrowDown />
							</Button>
							<Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove link ${index + 1}`} onClick={() => set({ links: draft.links.filter(({ key }) => key !== link.key) })}>
								<Trash2 />
							</Button>
						</div>
					</div>
				))}
			</CardSettings>

			<BarSave isDirty={isDirty} isSaving={isSaving} savedAt={savedAt} onDiscard={discard} />
		</form>
	);
}
