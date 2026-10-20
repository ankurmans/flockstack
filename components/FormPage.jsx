"use client";

import { useState, useTransition } from "react";
import { ExternalLink, Trash2 } from "lucide-react";
import { deletePage, savePage } from "@/app/(app)/website/actions";
import BarSave from "@/components/BarSave";
import EditorRich from "@/components/EditorRich";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MAX_PAGE_DESCRIPTION, MAX_PAGE_TITLE } from "@/lib/site-page-rules";
import { toSlugInput } from "@/lib/slug";
import { toast } from "@/lib/toast";

// A custom page: title, address, description and the body in the issue editor. The body and the rest save together; a
// published page is live as soon as it saves. urlBase: the website's /p/ address, to show where the page will be.
export default function FormPage({ page, urlBase, isWebsiteOn }) {
	const [values, setValues] = useState(() => toValues(page));
	const [saved, setSaved] = useState(() => JSON.stringify(toValues(page)));
	const [savedSlug, setSavedSlug] = useState(page.slug);
	const [savedAt, setSavedAt] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const [isDeleting, startDeleting] = useTransition();
	const [discardCount, setDiscardCount] = useState(0);
	const isDirty = JSON.stringify(values) !== saved;
	const { host, pathname } = new URL(urlBase);

	function set(key, value) {
		setValues((current) => ({ ...current, [key]: value }));
	}

	function save(event) {
		event.preventDefault();
		startSaving(async () => {
			const result = await savePage(page.id, values);
			if (result?.error) return void toast.error(result.error);
			const next = toValues(result.page);
			setValues(next);
			setSaved(JSON.stringify(next));
			setSavedSlug(result.page.slug);
			setSavedAt(result.savedAt);
		});
	}

	function discard() {
		setValues(JSON.parse(saved));
		setDiscardCount((count) => count + 1);
		setSavedAt(null);
	}

	function remove() {
		if (!window.confirm(`Delete "${page.title}"? Its address stops working and the navigation drops it.`)) return;
		startDeleting(async () => {
			const result = await deletePage(page.id);
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<section className="rounded-xl bg-card shadow-border animate-enter">
				<div className="divide-y divide-border/60">
					<Row label="Title">
						<Input value={values.title} onChange={(event) => set("title", event.target.value)} maxLength={MAX_PAGE_TITLE} required placeholder="About" aria-label="Title" />
					</Row>
					<Row label="Address">
						<span className="flex min-w-0 items-center text-sm">
							<span className="hidden shrink-0 text-muted-foreground sm:inline">{host}</span>
							<span className="shrink-0 text-muted-foreground">{pathname}</span>
							<input
								value={values.slug}
								onChange={(event) => set("slug", toSlugInput(event.target.value))}
								aria-label="Address"
								spellCheck={false}
								autoCapitalize="none"
								maxLength={120}
								required
								className="h-6 w-full min-w-[8ch] bg-transparent font-medium outline-none"
							/>
						</span>
					</Row>
					<Row label="Description">
						<Textarea
							value={values.description}
							onChange={(event) => set("description", event.target.value)}
							maxLength={MAX_PAGE_DESCRIPTION}
							rows={2}
							placeholder="For search results and link previews. Empty: the page's first words."
							aria-label="Description"
						/>
					</Row>
					<Row label="Published">
						<span className="flex items-center gap-3 text-sm">
							<Switch checked={values.status === "published"} onCheckedChange={(isOn) => set("status", isOn ? "published" : "draft")} aria-label="Published" />
							{values.status === "published" ? (isWebsiteOn ? "On your website" : "Your website is off, so it has no address yet") : "A draft: only you see it"}
							{values.status === "published" && isWebsiteOn && !isDirty && (
								<a href={`${urlBase}${savedSlug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground underline underline-offset-4 hover:text-foreground">
									View <ExternalLink className="size-3.5" aria-hidden="true" />
								</a>
							)}
						</span>
					</Row>
				</div>
			</section>

			<section style={{ "--stagger": 1 }} className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
				<EditorRich key={discardCount} content={values.content} onChange={(html) => set("content", html)} />
			</section>

			<div className="flex justify-end">
				<Button type="button" variant="destructive" onClick={remove} disabled={isDeleting}>
					<Trash2 />
					Delete page
				</Button>
			</div>
			<BarSave isDirty={isDirty} isSaving={isSaving} savedAt={savedAt} onDiscard={discard} />
		</form>
	);
}

function toValues(page) {
	return { title: page.title, slug: page.slug, description: page.description ?? "", status: page.status, content: page.content ?? "" };
}

function Row({ label, children }) {
	return (
		<div className="grid gap-2 px-4 py-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
			<span className="text-sm text-muted-foreground sm:pt-2">{label}</span>
			<div className="min-w-0">{children}</div>
		</div>
	);
}
