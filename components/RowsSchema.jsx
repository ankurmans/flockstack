"use client";

import { RowSettings } from "@/components/CardSettings";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_SCHEMA_TYPE, SEO_LIMITS } from "@/lib/seo-rules";

const TYPE_LABELS = { BlogPosting: "Blog post (default)", Article: "Article", NewsArticle: "News article" };

// The structured data of an issue's page: the schema.org type of its own block, and extra blocks of the writer's own.
export default function RowsSchema({ schemaType, jsonLd, onChange }) {
	return (
		<>
			<RowSettings label="Schema type" hint="The type search engines read the page as. News article is for reported news.">
				<Select value={schemaType || DEFAULT_SCHEMA_TYPE} onValueChange={(next) => onChange({ schemaType: next })}>
					<SelectTrigger className="my-1.5 h-9 w-full sm:w-64" aria-label="Schema type">
						<SelectValue>{(value) => TYPE_LABELS[value] ?? value}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{Object.entries(TYPE_LABELS).map(([value, label]) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</RowSettings>
			<RowSettings label="Structured data" hint={`Your own JSON-LD for this page: an FAQ, a recipe, an event. One block or a list of up to ${SEO_LIMITS.jsonLdBlocks}, each with an @type. It sits next to the newsletter's.`} isLabel>
				<Textarea value={jsonLd} onChange={(event) => onChange({ jsonLd: event.target.value })} rows={5} maxLength={SEO_LIMITS.jsonLd} spellCheck={false} className="font-mono text-xs" placeholder='{"@type": "FAQPage", "mainEntity": []}' />
			</RowSettings>
		</>
	);
}
