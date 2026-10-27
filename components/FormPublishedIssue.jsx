"use client";

import { getNewsletterTiers } from "@/lib/tier-rules";
import { useCallback, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft, ExternalLink, History, Info } from "lucide-react";
import { savePublishedIssue } from "@/app/(app)/campaigns/actions";
import BadgeStatus from "@/components/BadgeStatus";
import BarSave from "@/components/BarSave";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import DialogVersionHistory from "@/components/DialogVersionHistory";
import EditorRich from "@/components/EditorRich";
import RowCampaign from "@/components/RowCampaign";
import RowsSchema from "@/components/RowsSchema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_ISSUE_TAGS } from "@/lib/issue-tags";
import { markdownToHtml } from "@/lib/markdown";
import { DEFAULT_SCHEMA_TYPE, SEO_LIMITS, formatJsonLd } from "@/lib/seo-rules";
import { toast } from "@/lib/toast";

// A sent issue's page on the website: its title, subtitle, body, tags and search settings, edited on their own. What readers
// got in their inbox is not touched (lib/actions/published-issues.js). Saved by hand, since the page is live, and the page
// as it was is kept in the history before each save.
export default function FormPublishedIssue({ campaign, newsletter, pageUrl, fields = [], snippets = [], isAiEnabled = false, hasStockPhotos = false, hasGifs = false }) {
	const isHtml = campaign.format === "html";
	const [initialBody] = useState(() => (campaign.format === "markdown" ? markdownToHtml(campaign.markdown) : campaign.html));
	const [initial] = useState(() => ({
		title: campaign.subject,
		subtitle: campaign.previewText ?? "",
		body: initialBody,
		tags: (campaign.tags ?? []).join(", "),
		seoTitle: campaign.seo?.title ?? "",
		seoDescription: campaign.seo?.description ?? "",
		seoImage: campaign.seo?.imageUrl ?? "",
		noindex: Boolean(campaign.seo?.noindex),
		schemaType: campaign.seo?.schemaType ?? DEFAULT_SCHEMA_TYPE,
		jsonLd: formatJsonLd(campaign.seo?.jsonLd),
	}));
	const [saved, setSaved] = useState(initial);
	const [values, setValues] = useState(initial);
	// A new key starts the editor over from what was saved.
	const [editorKey, setEditorKey] = useState(0);
	const [savedAt, setSavedAt] = useState(null);
	const [isHistoryOpen, setIsHistoryOpen] = useState(false);
	const [isSaving, startSaving] = useTransition();
	const isDirty = Object.keys(values).some((key) => values[key] !== saved[key]);
	const set = (key) => (event) => setValues((current) => ({ ...current, [key]: event.target.value }));
	const updateBody = useCallback((body) => setValues((current) => ({ ...current, body })), []);
	const keepAsIs = useCallback(async () => true, []);

	function save(event) {
		event.preventDefault();
		if (!isDirty || isSaving) return;
		startSaving(async () => {
			const result = await savePublishedIssue(campaign._id, {
				title: values.title,
				subtitle: values.subtitle,
				body: values.body,
				format: isHtml ? "html" : "rich",
				tags: values.tags,
				seo: { title: values.seoTitle, description: values.seoDescription, image: values.seoImage, noindex: values.noindex, schemaType: values.schemaType, jsonLd: values.jsonLd },
			});
			if (result?.error) return void toast.error(result.error);
			setSaved(values);
			setSavedAt(Date.now());
		});
	}

	function discard() {
		setValues(saved);
		setEditorKey((current) => current + 1);
		setSavedAt(null);
	}

	return (
		<form onSubmit={save} className="mx-auto w-full max-w-2xl">
			<header className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 animate-enter">
				<div className="flex min-w-0 items-center gap-2">
					<Link href={`/campaigns/${campaign._id}`} aria-label="Back to the report" className="-ml-2 grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground">
						<ChevronLeft className="size-5" />
					</Link>
					<h1 className="truncate text-2xl font-semibold tracking-tight">Edit web version</h1>
					<BadgeStatus status="sent" />
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button type="button" variant="outline" onClick={() => setIsHistoryOpen(true)}>
						<History data-icon="inline-start" />
						History
					</Button>
					{pageUrl && (
						<Button asChild variant="outline">
							<a href={pageUrl} target="_blank" rel="noreferrer">
								<ExternalLink data-icon="inline-start" />
								View page
							</a>
						</Button>
					)}
				</div>
			</header>

			<p role="note" className="mb-6 flex items-start gap-2.5 rounded-xl bg-muted/60 px-4 py-3 text-sm text-pretty animate-enter">
				<Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<span>
					<span className="font-medium">Emails already sent are not changed.</span> This edits the issue&apos;s page on your website and its entry in the RSS feed. It keeps its address and its date, and the
					page as it was is kept in History.
				</span>
			</p>

			<div className="flex flex-col gap-6">
				<div className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
					<div className="divide-y divide-border/60 border-b border-border/60">
						<RowCampaign label="Title">
							<input value={values.title} onChange={set("title")} placeholder="Title" aria-label="Title" maxLength={200} required className="h-11 w-full min-w-0 bg-transparent text-sm font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground" />
						</RowCampaign>
						<RowCampaign label="Subtitle">
							<input value={values.subtitle} onChange={set("subtitle")} placeholder="A line under the title" aria-label="Subtitle" maxLength={300} className="h-11 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
						</RowCampaign>
					</div>
					{isHtml ? (
						<textarea
							value={values.body}
							onChange={set("body")}
							spellCheck={false}
							aria-label="Content"
							className="block min-h-[560px] w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground"
						/>
					) : (
						<EditorRich
							key={editorKey}
							content={saved.body}
							onChange={updateBody}
							fields={fields}
							snippets={snippets}
							newsletterId={newsletter._id} tiers={getNewsletterTiers(newsletter).map(({ id, name }) => ({ id, name }))}
							campaignId={campaign._id}
							isAiEnabled={isAiEnabled}
							hasStockPhotos={hasStockPhotos}
							hasGifs={hasGifs}
						/>
					)}
				</div>

				<CardSettings title="Tags and search" stagger={1}>
					<RowSettings label="Tags" hint={`Separate with commas, ${MAX_ISSUE_TAGS} at most. Each tag gets a page on your website.`} isLabel>
						<Input value={values.tags} onChange={set("tags")} placeholder="interviews, tools" spellCheck={false} />
					</RowSettings>
					<RowSettings label="Search title" hint={`${values.seoTitle.length || values.title.length} characters. About 60 show in search results.`} isLabel>
						<Input value={values.seoTitle} onChange={set("seoTitle")} placeholder={values.title || "The title"} maxLength={SEO_LIMITS.title} />
					</RowSettings>
					<RowSettings label="Description" hint={`${values.seoDescription.length || values.subtitle.length} characters. About 155 show in search results.`} isLabel>
						<Textarea value={values.seoDescription} onChange={set("seoDescription")} placeholder={values.subtitle || "The subtitle"} rows={2} maxLength={SEO_LIMITS.description} />
					</RowSettings>
					<RowSettings label="Social image" hint="An https:// link, 1200×630 works best. Empty uses the first picture of the body." isLabel>
						<Input value={values.seoImage} onChange={set("seoImage")} placeholder="https://" maxLength={SEO_LIMITS.image} inputMode="url" />
					</RowSettings>
					<RowSettings label="Search engines">
						<label className="flex items-start gap-2 text-sm">
							<input type="checkbox" checked={values.noindex} onChange={(event) => setValues((current) => ({ ...current, noindex: event.target.checked }))} className="mt-0.5 size-4 accent-foreground" />
							<span>
								Ask search engines not to list this page
								<span className="block text-xs text-muted-foreground">It stays out of the sitemap and llms.txt too. The page still works at its link.</span>
							</span>
						</label>
					</RowSettings>
					<RowsSchema schemaType={values.schemaType} jsonLd={values.jsonLd} onChange={(change) => setValues((current) => ({ ...current, ...change }))} />
				</CardSettings>
			</div>

			<BarSave isDirty={isDirty} isSaving={isSaving} savedAt={savedAt} onDiscard={discard} />
			<DialogVersionHistory campaignId={campaign._id} isOpen={isHistoryOpen} onOpenChange={setIsHistoryOpen} onSave={keepAsIs} isPublished />
		</form>
	);
}
