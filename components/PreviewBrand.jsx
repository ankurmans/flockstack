"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Image from "next/image";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import PreviewEmail from "@/components/PreviewEmail";
import { getBrand, isImageUrl } from "@/lib/brand";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail, withPreviewLinks } from "@/lib/render-email";
import { getThemeCss } from "@/lib/site-themes";
import { cn } from "@/lib/utils";

const SAMPLE_ISSUE = {
	subject: "What I learned this week",
	previewText: "Three notes, one link worth your time",
	html: '<h2>A heading</h2><p>Three notes from the week, and <a href="https://example.com">one link worth your time</a>.</p><div data-button=""><a href="https://example.com">Read more</a></div>',
};
const SAMPLE_ISSUES = [
	{ title: "What I learned this week", date: "Oct 12", tag: "notes" },
	{ title: "Pricing a small product", date: "Oct 5", tag: "pricing" },
	{ title: "Ten tools I kept using", date: "Sep 28", tag: "tools" },
];

// The look the settings describe, as the website and the email will show it, redrawn as each choice changes. The mock
// site uses the website's own stylesheet (lib/site-themes.js) and layout classes (app/globals.css), scoped to itself.
export default function PreviewBrand({ newsletter }) {
	const [view, setView] = useState("website");
	const deferred = useDeferredValue(newsletter);
	const brand = useMemo(() => getBrand(deferred), [deferred]);

	return (
		<div className="flex flex-col gap-3 p-3">
			<div role="tablist" aria-label="Preview" className="flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5">
				{[
					["website", "Website"],
					["email", "Email"],
				].map(([id, label]) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={view === id}
						onClick={() => setView(id)}
						className={cn("h-7 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors duration-150", view === id && "bg-background text-foreground shadow-border")}
					>
						{label}
					</button>
				))}
			</div>
			{view === "website" ? <PreviewSite newsletter={deferred} brand={brand} /> : <PreviewEmailBrand newsletter={deferred} />}
		</div>
	);
}

function PreviewSite({ newsletter, brand }) {
	const css = `.brand-preview{--primary:oklch(0.205 0 0);--primary-foreground:oklch(0.985 0 0)}.dark .brand-preview{--primary:oklch(0.922 0 0);--primary-foreground:oklch(0.205 0 0)}\n${getThemeCss(brand, brand.theme)}`;
	const isList = brand.theme === "minimal";
	return (
		<div data-site-theme={brand.theme} className="brand-preview overflow-hidden rounded-xl border border-border bg-background text-foreground">
			<style dangerouslySetInnerHTML={{ __html: css }} />
			<div className="flex h-11 items-center justify-between gap-3 border-b border-border/60 px-4 text-xs">
				<span className="flex min-w-0 items-center gap-2 font-medium">
					<AvatarNewsletter newsletter={newsletter} size={20} />
					<span className="truncate">{newsletter.name || "Your newsletter"}</span>
				</span>
				<span className="flex items-center gap-3 text-muted-foreground">
					<span>Archive</span>
					<span>About</span>
					<span className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground">Subscribe</span>
				</span>
			</div>
			{isImageUrl(brand.headerUrl) && (
				<div className="px-4 pt-4">
					<div className="relative aspect-[3/1] overflow-hidden rounded-lg bg-muted">
						<Image src={brand.headerUrl} alt="" fill sizes="480px" unoptimized className="object-cover" />
					</div>
				</div>
			)}
			<div className="site-hero">
				<div className="site-hero-inner flex flex-col items-center gap-3 px-5 py-8 text-center">
					<h3 className="site-title text-2xl font-semibold tracking-tight">{newsletter.name || "Your newsletter"}</h3>
					<p className="max-w-xs text-sm text-muted-foreground">{newsletter.description || "One idea about building things, every Sunday."}</p>
					<span className="flex w-full max-w-xs items-center gap-2">
						<input readOnly tabIndex={-1} aria-hidden="true" placeholder="you@example.com" className="h-9 min-w-0 flex-1 rounded-lg bg-background px-3 text-left text-xs text-foreground shadow-border outline-none placeholder:text-muted-foreground" />
						<button type="button" tabIndex={-1} aria-hidden="true" className="h-9 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground">
							Subscribe
						</button>
					</span>
				</div>
			</div>
			<ol className={cn("px-5 pb-5", isList ? "divide-y divide-border/60" : "grid grid-cols-3 gap-3")}>
				{SAMPLE_ISSUES.map(({ title, date, tag }) =>
					isList ? (
						<li key={title} className="flex items-baseline gap-4 py-3 text-sm">
							<span className="w-14 shrink-0 text-xs text-muted-foreground">{date}</span>
							<span className="font-medium">{title}</span>
						</li>
					) : (
						<li key={title} className="flex flex-col gap-1.5">
							<span className="aspect-[1200/630] rounded-lg bg-muted" />
							<span className="text-[11px] text-muted-foreground">{date}</span>
							<span className="text-xs leading-snug font-semibold">{title}</span>
							<span className="w-fit rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{tag}</span>
						</li>
					)
				)}
			</ol>
			<p className="border-t border-border/60 px-5 py-3 text-xs">
				An issue&apos;s <a className="font-medium underline underline-offset-2" style={{ color: brand.hasAccent ? brand.linkOnLight : undefined }}>links</a> and buttons wear the accent color.
			</p>
		</div>
	);
}

function PreviewEmailBrand({ newsletter }) {
	const html = useMemo(
		() => withPreviewLinks(renderEmail({ format: "rich", ...SAMPLE_ISSUE, newsletter, webUrl: "https://example.com/p/issue" }).html).replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#"),
		[newsletter]
	);
	return (
		<PreviewEmail
			html={html}
			sender={{ name: newsletter.name, fromName: newsletter.fromName, fromEmail: newsletter.fromEmail, imageUrl: newsletter.imageUrl }}
			subject={SAMPLE_ISSUE.subject}
			previewText={SAMPLE_ISSUE.previewText}
			fit="content"
		/>
	);
}
