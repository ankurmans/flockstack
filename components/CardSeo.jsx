"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { setCampaignSeo } from "@/app/(app)/campaigns/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import RowsSchema from "@/components/RowsSchema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_SCHEMA_TYPE, SEO_LIMITS, formatJsonLd } from "@/lib/seo-rules";
import { toast } from "@/lib/toast";

// What search engines and social cards show for an issue's page. Empty fields use the subject, the preview text and the
// issue's first picture. seo: the campaign's stored settings. The page is /p/<slug> once the issue goes out, so a draft
// can be set up before it does.
export default function CardSeo({ campaignId, seo, subject, previewText, stagger = 0 }) {
	const initial = { title: seo?.title ?? "", description: seo?.description ?? "", image: seo?.imageUrl ?? "", noindex: Boolean(seo?.noindex), schemaType: seo?.schemaType ?? DEFAULT_SCHEMA_TYPE, jsonLd: formatJsonLd(seo?.jsonLd) };
	const [saved, setSaved] = useState(initial);
	const [draft, setDraft] = useState(initial);
	const [isPending, startTransition] = useTransition();
	const isDirty = Object.keys(draft).some((key) => draft[key] !== saved[key]);
	const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await setCampaignSeo(campaignId, draft);
			if (result?.error) return void toast.error(result.error);
			setSaved(draft);
			toast.success("Search settings saved");
		});
	}

	return (
		<form onSubmit={save}>
			<CardSettings title="Search and sharing" stagger={stagger}>
				<RowSettings label="Title" hint={`${draft.title.length || (subject ?? "").length} characters. About 60 show in search results.`} isLabel>
					<Input value={draft.title} onChange={set("title")} placeholder={subject || "The subject"} maxLength={SEO_LIMITS.title} />
				</RowSettings>
				<RowSettings label="Description" hint={`${draft.description.length || (previewText ?? "").length} characters. About 155 show in search results.`} isLabel>
					<Textarea value={draft.description} onChange={set("description")} placeholder={previewText || "The preview text"} rows={2} maxLength={SEO_LIMITS.description} />
				</RowSettings>
				<RowSettings label="Social image" hint="An https:// link, 1200×630 works best. Empty uses the issue's first picture." isLabel>
					<Input value={draft.image} onChange={set("image")} placeholder="https://" maxLength={SEO_LIMITS.image} inputMode="url" />
				</RowSettings>
				<RowSettings label="Search engines">
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" checked={draft.noindex} onChange={(event) => setDraft((current) => ({ ...current, noindex: event.target.checked }))} className="mt-0.5 size-4 accent-foreground" />
						<span>
							Ask search engines not to list this page
							<span className="block text-xs text-muted-foreground">It stays out of the sitemap and llms.txt too. The page still works at its link.</span>
						</span>
					</label>
				</RowSettings>
				<RowsSchema schemaType={draft.schemaType} jsonLd={draft.jsonLd} onChange={(change) => setDraft((current) => ({ ...current, ...change }))} />
				<div className="flex items-center gap-3 px-4 py-3">
					<Button type="submit" size="sm" disabled={!isDirty || isPending}>
						{isPending && <Loader2 className="animate-spin" />}
						Save
					</Button>
				</div>
			</CardSettings>
		</form>
	);
}
