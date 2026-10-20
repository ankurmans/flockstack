"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { saveJsonLd } from "@/app/(app)/newsletters/actions";
import ButtonCopy from "@/components/ButtonCopy";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SEO_LIMITS, formatJsonLd, getJsonLdProblem } from "@/lib/seo-rules";
import { toast } from "@/lib/toast";

const FILES = [
	["sitemap", "Sitemap", "Every issue with the date it last changed"],
	["robots", "robots.txt", "Points search engines at the sitemap"],
	["llms", "llms.txt", "The newsletter and its latest issues as plain text for AI assistants"],
	["feed", "RSS feed", "The full text of each issue"],
];

// The website's files for search engines and AI assistants, which FlockStack makes and keeps up to date, and the
// newsletter's own structured data. urls: where the website serves them (null while it is off). Per issue, the title,
// description, social image and noindex are in the issue's Review step and report.
export default function CardSearch({ newsletterId, urls, jsonLd, stagger = 0, className }) {
	const [saved, setSaved] = useState(jsonLd);
	const [text, setText] = useState(jsonLd);
	const [isPending, startTransition] = useTransition();
	const problem = text.trim() ? getJsonLdProblem(text) : null;

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await saveJsonLd(newsletterId, text);
			if (result?.error) return void toast.error(result.error);
			setSaved(formatJsonLd(result.jsonLd));
			setText(formatJsonLd(result.jsonLd));
			toast.success("Structured data saved");
		});
	}

	return (
		<CardSettings title="Search engines and AI assistants" stagger={stagger} className={className}>
			{urls ? (
				<RowSettings label="Files">
					<ul className="flex flex-col gap-1.5">
						{FILES.map(([key, label, hint]) => (
							<li key={key} className="flex min-w-0 items-center gap-2 text-sm">
								<a href={urls[key]} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate">
									<span className="font-medium hover:underline">{label}</span>
									<span className="block truncate text-xs text-muted-foreground">{hint}</span>
								</a>
								<ButtonCopy value={urls[key]} label={`Copy the ${label} address`} />
							</li>
						))}
					</ul>
				</RowSettings>
			) : (
				<RowSettings label="Files" hint="Turn on the website, under Archive, and it serves a sitemap, robots.txt and llms.txt." />
			)}
			<RowSettings label="Old addresses" hint="A post that moved, or one imported from another platform, keeps its old link with a redirect.">
				<Link href="#redirects" className="text-sm font-medium hover:underline">
					Go to redirects
				</Link>
			</RowSettings>
			<form onSubmit={save}>
				<RowSettings
					label="Structured data"
					hint={`Your own JSON-LD for the home page and every issue's page: an organization, an FAQ, an event. One block or a list of up to ${SEO_LIMITS.jsonLdBlocks}, each with an "@type". Issues already carry their own article data.`}
					isLabel
				>
					<Textarea
						value={text}
						onChange={(event) => setText(event.target.value)}
						rows={7}
						maxLength={SEO_LIMITS.jsonLd}
						spellCheck={false}
						placeholder={'{ "@type": "Organization", "name": "…", "url": "https://…" }'}
						aria-invalid={Boolean(problem)}
						className="font-mono text-xs"
					/>
					{problem && (
						<span role="alert" className="text-xs text-destructive">
							{problem}
						</span>
					)}
					<span>
						<Button type="submit" size="sm" disabled={isPending || Boolean(problem) || text.trim() === saved.trim()}>
							{isPending && <Loader2 className="animate-spin" />}
							Save
						</Button>
					</span>
				</RowSettings>
			</form>
		</CardSettings>
	);
}
