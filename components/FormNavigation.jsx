"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { saveNavigation } from "@/app/(app)/website/actions";
import BarSave from "@/components/BarSave";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_NAV_ITEMS, MAX_NAV_LABEL } from "@/lib/site-navigation";
import { toast } from "@/lib/toast";

const KINDS = [
	["page", "Page"],
	["archive", "All issues"],
	["tag", "Tag"],
	["link", "Link"],
];
const SELECT_CLASS =
	"h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25";

function toDraft(items) {
	return items.map((item) => ({ id: item.id, kind: item.kind, label: item.label ?? "", page: item.page ?? "", tag: item.tag ?? "", url: item.url ?? "" }));
}

// The navigation bar, in order: pages, a tag, the list of issues, or any https:// link. A label left empty shows the
// page's title. Saving replaces the bar.
export default function FormNavigation({ newsletterId, items, pages }) {
	const [draft, setDraft] = useState(() => toDraft(items));
	const [savedKey, setSavedKey] = useState(() => JSON.stringify(toDraft(items)));
	const [savedAt, setSavedAt] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const isDirty = JSON.stringify(draft) !== savedKey;

	function change(index, changes) {
		setDraft((current) => current.map((item, position) => (position === index ? { ...item, ...changes } : item)));
	}

	function move(index, offset) {
		setDraft((current) => {
			const next = [...current];
			[next[index], next[index + offset]] = [next[index + offset], next[index]];
			return next;
		});
	}

	function save(event) {
		event.preventDefault();
		startSaving(async () => {
			const result = await saveNavigation(newsletterId, draft);
			if (result?.error) return void toast.error(result.error);
			const saved = toDraft(result.items);
			setDraft(saved);
			setSavedKey(JSON.stringify(saved));
			setSavedAt(result.savedAt);
		});
	}

	return (
		<form onSubmit={save}>
			<div style={{ "--stagger": 1 }} className="rounded-xl bg-card shadow-border animate-enter">
				<div className="flex h-12 items-center justify-between gap-3 border-b border-border/60 px-4">
					<h2 className="text-sm font-medium">Navigation</h2>
					<span className="text-xs text-muted-foreground tabular-nums">
						{draft.length} of {MAX_NAV_ITEMS}
					</span>
				</div>
				{draft.length === 0 && <p className="px-4 py-3 text-sm text-pretty text-muted-foreground">The bar at the top of your website has your name and Subscribe. Add links to pages, tags or anywhere else.</p>}
				<ul className="divide-y divide-border/60">
					{draft.map((item, index) => (
						<li key={item.id ?? `new-${index}`} className="flex flex-wrap items-center gap-2 px-4 py-3">
							<select aria-label={`Link ${index + 1} type`} value={item.kind} onChange={(event) => change(index, { kind: event.target.value })} className={SELECT_CLASS}>
								{KINDS.map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
							{item.kind === "page" && (
								<select aria-label={`Link ${index + 1} page`} value={item.page} onChange={(event) => change(index, { page: event.target.value })} className={`${SELECT_CLASS} min-w-0 flex-1`}>
									<option value="">Choose a page</option>
									{pages.map((page) => (
										<option key={page.id} value={page.id}>
											{page.title}
											{page.status === "draft" ? " (draft)" : ""}
										</option>
									))}
								</select>
							)}
							{item.kind === "tag" && <Input aria-label={`Link ${index + 1} tag`} value={item.tag} onChange={(event) => change(index, { tag: event.target.value })} placeholder="interviews" className="min-w-0 flex-1" />}
							{item.kind === "link" && <Input aria-label={`Link ${index + 1} address`} type="url" value={item.url} onChange={(event) => change(index, { url: event.target.value })} placeholder="https://" className="min-w-0 flex-1" />}
							<Input
								aria-label={`Link ${index + 1} label`}
								value={item.label}
								onChange={(event) => change(index, { label: event.target.value })}
								maxLength={MAX_NAV_LABEL}
								placeholder={item.kind === "link" ? "Label" : "Label (optional)"}
								className="w-40"
							/>
							<span className="ml-auto flex items-center">
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
									<ArrowUp />
								</Button>
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Move down" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>
									<ArrowDown />
								</Button>
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => setDraft((current) => current.filter((_, position) => position !== index))}>
									<X />
								</Button>
							</span>
						</li>
					))}
				</ul>
				<div className="border-t border-border/60 p-3">
					<Button
						type="button"
						variant="outline"
						disabled={draft.length >= MAX_NAV_ITEMS}
						onClick={() => setDraft((current) => [...current, { kind: pages.length > 0 ? "page" : "archive", label: "", page: "", tag: "", url: "" }])}
					>
						<Plus />
						Add a link
					</Button>
				</div>
			</div>
			<BarSave isDirty={isDirty} isSaving={isSaving} savedAt={savedAt} onDiscard={() => { setDraft(JSON.parse(savedKey)); setSavedAt(null); }} />
		</form>
	);
}
