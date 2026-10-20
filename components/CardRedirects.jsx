"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight, FileUp, Loader2, Plus, X } from "lucide-react";
import { addRedirect, deleteRedirect, importRedirects, listRedirects } from "@/app/(app)/newsletters/actions";
import CardSettings from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// CSVs past this are split by the owner; the action takes 1,000 rows a call.
const MAX_CSV_BYTES = 300_000;

// The website's redirects: those a post import added from the old addresses, and the owner's own. Old links keep working
// once the old address points at FlockStack.
export default function CardRedirects({ newsletterId, initial, stagger = 0, className }) {
	const [redirects, setRedirects] = useState(initial?.redirects ?? []);
	const [nextCursor, setNextCursor] = useState(initial?.nextCursor ?? null);
	const [total, setTotal] = useState(initial?.total ?? 0);
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [isPending, startTransition] = useTransition();

	function reload() {
		return listRedirects(newsletterId).then((result) => {
			if (result.error) return void toast.error(result.error);
			setRedirects(result.redirects);
			setNextCursor(result.nextCursor);
			setTotal(result.total);
		});
	}

	function add(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await addRedirect(newsletterId, from, to);
			if (result.error) return void toast.error(result.error);
			setRedirects((list) => [result.redirect, ...list]);
			setTotal((count) => count + 1);
			setFrom("");
			setTo("");
		});
	}

	function remove(id) {
		startTransition(async () => {
			const result = await deleteRedirect(id);
			if (result.error) return void toast.error(result.error);
			setRedirects((list) => list.filter((item) => item.id !== id));
			setTotal((count) => Math.max(0, count - 1));
		});
	}

	function loadMore() {
		startTransition(async () => {
			const result = await listRedirects(newsletterId, nextCursor);
			if (result.error) return void toast.error(result.error);
			setRedirects((list) => [...list, ...result.redirects]);
			setNextCursor(result.nextCursor);
		});
	}

	function upload(event) {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		if (file.size > MAX_CSV_BYTES) return void toast.error("Upload 1,000 rows at most at a time");
		startTransition(async () => {
			const result = await importRedirects(newsletterId, await file.text());
			if (result.error) return void toast.error(result.error);
			const first = result.problems[0];
			const message = `${formatNumber(result.added)} added, ${formatNumber(result.updated)} updated`;
			if (result.invalid > 0) toast.error(`${message}, ${formatNumber(result.invalid)} left out`, { description: first && `Line ${first.line}: ${first.problem}` });
			else toast.success(message);
			await reload();
		});
	}

	return (
		<CardSettings
			id="redirects"
			title="Redirects"
			stagger={stagger}
			className={cn("scroll-mt-20", className)}
			action={
				<Button asChild size="sm" variant="outline" disabled={isPending}>
					<label className="cursor-pointer">
						{isPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <FileUp data-icon="inline-start" />}
						Upload CSV
						<input type="file" accept=".csv,text/csv" className="sr-only" onChange={upload} disabled={isPending} />
					</label>
				</Button>
			}
		>
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				Old links to your posts land on their new page once the old address points at FlockStack. Imports add them; add your own here, or upload
				a CSV of from,to rows.{" "}
				<Link href="/newsletters/import" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
					Import posts
				</Link>
			</p>
			<form onSubmit={add} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
				<Input aria-label="Old path" placeholder="/p/old-post" value={from} onChange={(event) => setFrom(event.target.value)} required />
				<ArrowRight className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
				<Input aria-label="New path or address" placeholder="/p/new-post" value={to} onChange={(event) => setTo(event.target.value)} required />
				<Button type="submit" size="sm" variant="outline" disabled={isPending} className="shrink-0">
					<Plus data-icon="inline-start" />
					Add
				</Button>
			</form>
			{redirects.length > 0 && (
				<ul aria-label="Redirects" className="divide-y divide-border/60">
					{redirects.map((redirect) => (
						<li key={redirect.id} className="flex items-center gap-2 px-4 py-2 text-sm">
							<span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={redirect.from}>
								{redirect.from}
							</span>
							<ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={redirect.to}>
								{redirect.to}
							</span>
							{redirect.source === "import" && <span className="hidden text-xs text-muted-foreground sm:inline">Import</span>}
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="size-8 shrink-0"
								aria-label={`Remove the redirect from ${redirect.from}`}
								onClick={() => remove(redirect.id)}
								disabled={isPending}
							>
								<X />
							</Button>
						</li>
					))}
				</ul>
			)}
			{(nextCursor || total > 0) && (
				<div className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-muted-foreground">
					<span className="tabular-nums">
						{formatNumber(total)} {total === 1 ? "redirect" : "redirects"}
					</span>
					{nextCursor && (
						<Button type="button" size="sm" variant="ghost" onClick={loadMore} disabled={isPending}>
							Show more
						</Button>
					)}
				</div>
			)}
		</CardSettings>
	);
}
