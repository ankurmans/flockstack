"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Download, FileText, Plus, X } from "lucide-react";
import { saveContentAssets } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LIMITS } from "@/lib/content-rules";
import { toast } from "@/lib/toast";

function toRows(assets) {
	return assets.map(({ mediaId, altText, url, name, kind, bytes }) => ({ mediaId, altText, url, name, kind, bytes }));
}

// The post's visuals from the media library, in the order they are posted, each with alt text; pictures or one PDF carousel.
// Nothing is uploaded again: an asset is a pointer to the library's file. Copy the post and download the files to post by hand.
export default function PanelContentAssets({ item, library }) {
	const router = useRouter();
	const [rows, setRows] = useState(() => toRows(item.assets));
	const [savedKey, setSavedKey] = useState(() => JSON.stringify(toRows(item.assets)));
	const [isSaving, startSaving] = useTransition();
	const [isCopied, setIsCopied] = useState(false);
	const isDirty = JSON.stringify(rows) !== savedKey;
	const attached = new Set(rows.map((row) => row.mediaId));

	function move(index, offset) {
		setRows((current) => {
			const next = [...current];
			[next[index], next[index + offset]] = [next[index + offset], next[index]];
			return next;
		});
	}

	function save() {
		startSaving(async () => {
			const result = await saveContentAssets(item.id, rows);
			if (result?.error) return void toast.error(result.error);
			setSavedKey(JSON.stringify(rows));
			if (result.approvalWithdrawn) toast.message("This change took the approval back. Ask for a review again.");
			router.refresh();
		});
	}

	async function copy() {
		await navigator.clipboard.writeText(item.postText);
		setIsCopied(true);
		setTimeout(() => setIsCopied(false), 1500);
	}

	function downloadAll() {
		rows.forEach((row, index) => {
			setTimeout(() => {
				const link = document.createElement("a");
				link.href = `/campaigns/calendar/items/${item.id}/download/${index + 1}`;
				link.download = row.name ?? "";
				link.click();
			}, index * 400);
		});
	}

	return (
		<section className="rounded-xl bg-card shadow-border animate-enter" aria-label="Visuals">
			<h2 className="flex h-12 items-center justify-between gap-3 px-4 text-sm font-medium">
				Visuals
				<span className="text-xs font-normal text-muted-foreground tabular-nums">
					{rows.length} of {LIMITS.assets}
				</span>
			</h2>
			<div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3">
				{rows.length === 0 && <p className="text-sm text-muted-foreground">No visuals yet. Pick from the media library below.</p>}
				<ol className="flex flex-col gap-3">
					{rows.map((row, index) => (
						<li key={row.mediaId} className="flex gap-3">
							{row.kind === "pdf" ? (
								<span className="grid size-16 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
									<FileText className="size-6" aria-hidden="true" />
								</span>
							) : (
								// The library's own CDN address, shown as it is.
								// eslint-disable-next-line @next/next/no-img-element
								<img src={row.url ?? undefined} alt="" className="size-16 shrink-0 rounded-lg bg-muted object-cover" loading="lazy" />
							)}
							<div className="flex min-w-0 flex-1 flex-col gap-1.5">
								<p className="truncate text-sm font-medium">
									{index + 1}. {row.name ?? "Missing file"} {row.kind === "pdf" && <span className="text-xs font-normal text-muted-foreground">PDF carousel</span>}
								</p>
								<label className="sr-only" htmlFor={`alt-${row.mediaId}`}>
									Alt text for {row.name}
								</label>
								<Input id={`alt-${row.mediaId}`} value={row.altText} onChange={(event) => setRows((current) => current.map((one, position) => (position === index ? { ...one, altText: event.target.value } : one)))} placeholder={row.kind === "pdf" ? "Description (optional)" : "Alt text"} maxLength={LIMITS.altText} className="h-8" />
								<div className="flex items-center gap-1">
									<Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${row.name} up`} disabled={index === 0} onClick={() => move(index, -1)}>
										<ArrowUp />
									</Button>
									<Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${row.name} down`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
										<ArrowDown />
									</Button>
									<Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${row.name}`} onClick={() => setRows((current) => current.filter((_, position) => position !== index))}>
										<X />
									</Button>
									{!isDirty && item.assets[index]?.url && (
										<Button asChild variant="ghost" size="sm">
											<a href={`/campaigns/calendar/items/${item.id}/download/${index + 1}`} download>
												<Download data-icon="inline-start" />
												Download
											</a>
										</Button>
									)}
								</div>
							</div>
						</li>
					))}
				</ol>
				<div className="flex flex-wrap gap-2">
					<Button type="button" disabled={!isDirty || isSaving} onClick={save}>
						Save visuals
					</Button>
					<Button type="button" variant="outline" onClick={copy}>
						{isCopied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
						{isCopied ? "Copied" : "Copy the post"}
					</Button>
					<Button type="button" variant="outline" disabled={isDirty || rows.length === 0} onClick={downloadAll}>
						<Download data-icon="inline-start" />
						Download all
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">To post by hand: copy the post, download the visuals, and record the address of the post once it is up.</p>
				<details className="rounded-lg border border-border/60">
					<summary className="cursor-pointer px-3 py-2 text-sm font-medium">Add from the media library</summary>
					<div className="border-t border-border/60 p-3">
						{library.length === 0 ? (
							<p className="text-sm text-muted-foreground">The library has no pictures or PDFs yet. Upload them in the media library.</p>
						) : (
							<ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
								{library.map((file) => (
									<li key={file.id}>
										<button
											type="button"
											disabled={attached.has(file.id) || rows.length >= LIMITS.assets}
											onClick={() => setRows((current) => [...current, { mediaId: file.id, altText: "", url: file.url, name: file.name, kind: file.contentType === "application/pdf" ? "pdf" : "image", bytes: file.bytes }])}
											className="flex w-full flex-col items-center gap-1 rounded-lg p-1.5 text-xs shadow-border transition-colors hover:bg-muted disabled:opacity-40"
											aria-label={`Add ${file.name}`}
										>
											{file.contentType === "application/pdf" ? (
												<span className="grid aspect-square w-full place-items-center rounded bg-muted">
													<FileText className="size-6" aria-hidden="true" />
												</span>
											) : (
												// eslint-disable-next-line @next/next/no-img-element
												<img src={file.url} alt="" className="aspect-square w-full rounded bg-muted object-cover" loading="lazy" />
											)}
											<span className="w-full truncate">{file.name}</span>
										</button>
									</li>
								))}
							</ul>
						)}
						<p className="mt-2 text-xs text-muted-foreground">
							<Plus className="mr-1 inline size-3" aria-hidden="true" />
							Upload new files in the <a href="/media" className="text-link hover:underline">media library</a>.
						</p>
					</div>
				</details>
			</div>
		</section>
	);
}
