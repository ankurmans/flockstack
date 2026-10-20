"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { FilePlus2, Loader2 } from "lucide-react";
import { createPage } from "@/app/(app)/website/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_PAGES_PER_NEWSLETTER, MAX_PAGE_TITLE } from "@/lib/site-page-rules";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// The newsletter's custom pages, and a field to start one. A new page opens in the editor as a draft.
export default function CardPages({ newsletterId, pages, isOn }) {
	const [title, setTitle] = useState("");
	const [isPending, startTransition] = useTransition();
	const isFull = pages.length >= MAX_PAGES_PER_NEWSLETTER;

	function add(event) {
		event.preventDefault();
		if (!title.trim() || isPending) return;
		startTransition(async () => {
			const result = await createPage(newsletterId, title);
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<section style={{ "--stagger": 0 }} className="rounded-xl bg-card shadow-border animate-enter">
			<div className="flex h-12 items-center justify-between gap-3 border-b border-border/60 px-4">
				<h2 className="text-sm font-medium">Pages</h2>
				<span className="text-xs text-muted-foreground tabular-nums">
					{pages.length} of {MAX_PAGES_PER_NEWSLETTER}
				</span>
			</div>
			{!isOn && <p className="border-b border-border/60 px-4 py-3 text-sm text-pretty text-muted-foreground">Your website is off, so pages have no address. Turn it on in Settings.</p>}
			{pages.length === 0 ? (
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Pages like About, Sponsor or Contact, written in the same editor as your issues and published at /p/ on your website.
				</p>
			) : (
				<ul className="divide-y divide-border/60">
					{pages.map((page) => (
						<li key={page.id}>
							<Link href={`/website/pages/${page.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors duration-150 hover:bg-muted/40">
								<span className="flex min-w-0 flex-col">
									<span className="truncate font-medium">{page.title}</span>
									<span className="truncate font-mono text-xs text-muted-foreground">/p/{page.slug}</span>
								</span>
								<span
									className={cn(
										"shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
										page.status === "published" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"
									)}
								>
									{page.status === "published" ? "Published" : "Draft"}
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
			<form onSubmit={add} className="flex items-center gap-2 border-t border-border/60 p-3">
				<Input
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					maxLength={MAX_PAGE_TITLE}
					placeholder="About"
					aria-label="New page title"
					disabled={isFull}
				/>
				<Button type="submit" variant="outline" disabled={!title.trim() || isPending || isFull}>
					{isPending ? <Loader2 className="animate-spin" /> : <FilePlus2 />}
					New page
				</Button>
			</form>
		</section>
	);
}
