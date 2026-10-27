"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { FileUp, Loader2, Play } from "lucide-react";
import { getImport, startImport } from "@/app/(app)/newsletters/import/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes, formatDate, formatNumber } from "@/lib/format";
import { SOURCE_NAMES, describeImportCounts } from "@/lib/post-import-report";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;
const ACCEPT = ".zip,.csv,.xml,.json,application/zip,text/csv,application/xml,text/xml,application/json";

function isActive(postImport) {
	return postImport?.status === "queued" || postImport?.status === "running";
}

// A Substack, beehiiv, WordPress, Ghost or Mailchimp export, in three steps: upload it and read the preview, start it, follow it to
// its report. The import runs in the background, so the page can close; the owner gets the report by email too.
export default function CardPostImport({ newsletter, initialImports, limits, maxFileBytes }) {
	const [imports, setImports] = useState(initialImports);
	const [file, setFile] = useState(null);
	const [siteUrl, setSiteUrl] = useState("");
	const [isUploading, setIsUploading] = useState(false);
	const [isStarting, startStarting] = useTransition();
	const latest = imports[0] ?? null;
	const wasActive = useRef(isActive(latest));

	useEffect(() => {
		if (!isActive(latest)) return;
		const interval = setInterval(async () => {
			const result = await getImport(latest.id);
			if (result.import) setImports((list) => [result.import, ...list.slice(1)]);
		}, POLL_MS);
		return () => clearInterval(interval);
	}, [latest]);

	useEffect(() => {
		const active = isActive(latest);
		if (wasActive.current && !active && latest?.status === "done") toast.success("Import done", { description: describeImportCounts(latest.counts) });
		if (wasActive.current && !active && latest?.status === "failed") toast.error("The import stopped", { description: latest.error ?? undefined });
		wasActive.current = active;
	}, [latest]);

	async function upload(event) {
		event.preventDefault();
		if (!file) return;
		if (file.size > maxFileBytes) return void toast.error(`Exports must be under ${formatBytes(maxFileBytes)}`);
		setIsUploading(true);
		try {
			const response = await fetch("/api/post-imports", {
				method: "POST",
				headers: {
					"x-newsletter": newsletter.id,
					"x-file-name": encodeURIComponent(file.name),
					...(siteUrl.trim() && { "x-site-url": encodeURIComponent(siteUrl.trim()) }),
				},
				body: file,
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok || !result.import) return void toast.error(result.error || "Upload failed, try again");
			setImports((list) => [result.import, ...list]);
			setFile(null);
		} finally {
			setIsUploading(false);
		}
	}

	function start(id) {
		startStarting(async () => {
			const result = await startImport(id);
			if (result.error) return void toast.error(result.error);
			wasActive.current = true;
			setImports((list) => list.map((item) => (item.id === id ? result.import : item)));
		});
	}

	const canUpload = !isUploading && !isActive(latest);

	return (
		<div className="flex flex-col gap-4">
			<CardSettings
				title="Bring your archive"
				action={
					<Button size="sm" form="post-import-upload" type="submit" disabled={!file || !canUpload}>
						{isUploading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <FileUp data-icon="inline-start" />}
						{isUploading ? "Reading" : "Read the file"}
					</Button>
				}
			>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Your Substack, beehiiv, WordPress, Ghost or Mailchimp posts become issues of {newsletter.name}, sent on their original dates and listed on your
					website. No email goes out. Each post&apos;s old address redirects to its new page once it points at FlockStack.{" "}
					<Link href="/docs/moving" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
						How to export
					</Link>
				</p>
				<form id="post-import-upload" onSubmit={upload}>
					<RowSettings
						label="Export"
						hint={`Substack's ZIP, beehiiv's posts CSV, WordPress's XML, Ghost's JSON or a Mailchimp ZIP of the campaigns CSV and each campaign's HTML, under ${formatBytes(maxFileBytes)}.${limits ? ` Your plan imports ${formatNumber(limits.posts)} posts at a time and ${formatBytes(limits.imageBytes)} of pictures in all.` : ""}`}
					>
						<label
							className={cn(
								"flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm shadow-border transition-[box-shadow,background-color] duration-150 hover:bg-muted/40 hover:shadow-border-hover",
								!canUpload && "pointer-events-none opacity-60"
							)}
						>
							<FileUp className="size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 truncate">{file ? `${file.name}, ${formatBytes(file.size)}` : "Choose the export file"}</span>
							<input type="file" accept={ACCEPT} className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
						</label>
					</RowSettings>
					<RowSettings label="Old address" hint="Optional. Ghost exports need it to bring their pictures, like https://news.example.com." isLabel>
						<Input value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} placeholder="https://news.example.com" inputMode="url" disabled={!canUpload} />
					</RowSettings>
				</form>
			</CardSettings>

			{latest && <CardImport postImport={latest} newsletter={newsletter} planLimits={limits} onStart={start} isStarting={isStarting} />}

			{imports.length > 1 && (
				<CardSettings title="Earlier imports">
					{imports.slice(1).map((item) => (
						<RowSettings key={item.id} label={formatDate(item.createdAt)}>
							<span className="flex min-h-9 items-center text-sm text-pretty">
								{SOURCE_NAMES[item.source]}
								{item.fileName ? `, ${item.fileName}` : ""}: {item.status === "done" ? describeImportCounts(item.counts) : item.status}
							</span>
						</RowSettings>
					))}
				</CardSettings>
			)}
		</div>
	);
}

function CardImport({ postImport, newsletter, planLimits, onStart, isStarting }) {
	const { status, preview, progress, counts, problems, error } = postImport;
	const limits = postImport.limits ?? planLimits;
	const source = SOURCE_NAMES[postImport.source];
	const range = preview.oldest && preview.newest ? `, ${formatDate(preview.oldest)} to ${formatDate(preview.newest)}` : "";
	const skipped = preview.skipped.drafts + preview.skipped.other + preview.skipped.missingContent;

	if (status === "ready" || status === "failed") {
		const willImport = limits ? Math.min(preview.posts, limits.posts) : preview.posts;
		return (
			<CardSettings
				title={status === "failed" ? "The import stopped" : "Preview"}
				action={
					<Button size="sm" onClick={() => onStart(postImport.id)} disabled={isStarting}>
						{isStarting ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Play data-icon="inline-start" />}
						{status === "failed" ? "Start again" : `Import ${formatNumber(willImport)} ${willImport === 1 ? "post" : "posts"}`}
					</Button>
				}
			>
				{status === "failed" && (
					<p className="px-4 py-3 text-sm text-pretty text-destructive">
						{error ?? "It stopped."} The posts it imported stay; starting again skips them and brings the rest.
					</p>
				)}
				<RowSettings label="Found" hint={skipped > 0 ? `${formatNumber(skipped)} drafts, pages and podcasts are left out.` : undefined}>
					<span className="flex min-h-9 items-center text-sm text-pretty">
						{formatNumber(preview.posts)} published {preview.posts === 1 ? "post" : "posts"} from {source}
						{range}
						{preview.paid > 0 ? `. ${formatNumber(preview.paid)} for paid subscribers become issues for your paid readers.` : "."}
					</span>
				</RowSettings>
				<RowSettings label="Newest">
					<ul className="flex flex-col gap-1 py-2 text-sm">
						{preview.titles.map((title, index) => (
							<li key={`${index}-${title}`} className="truncate">
								{title}
							</li>
						))}
					</ul>
				</RowSettings>
				{(limits?.posts ?? Infinity) < preview.posts && (
					<RowSettings label="Plan">
						<span className="flex min-h-9 items-center text-sm text-pretty">
							Your plan imports {formatNumber(willImport)} new posts at a time: the newest come first.
						</span>
					</RowSettings>
				)}
				{!newsletter.archiveEnabled && (
					<RowSettings label="Website">
						<span className="flex min-h-9 items-center text-sm text-pretty">
							Your website is off: the posts are imported, but only show once you turn it on in Settings.
						</span>
					</RowSettings>
				)}
			</CardSettings>
		);
	}

	if (status === "queued" || status === "running") {
		const share = progress.total > 0 ? progress.done / progress.total : 0;
		return (
			<CardSettings title="Importing">
				<div className="flex flex-col gap-3 px-4 py-4" role="status">
					<span className="text-sm tabular-nums">
						{formatNumber(progress.done)} of {formatNumber(progress.total)} posts from {source}
					</span>
					<div
						role="progressbar"
						aria-label="Import progress"
						aria-valuemin={0}
						aria-valuemax={progress.total}
						aria-valuenow={progress.done}
						className="h-1.5 overflow-hidden rounded-full bg-muted"
					>
						<div className="h-full rounded-full bg-foreground transition-[width] duration-300" style={{ width: `${Math.max(share * 100, 2)}%` }} />
					</div>
					<span className="text-xs text-pretty text-muted-foreground">
						You can leave this page: it goes on in the background, and we email you the report.
					</span>
				</div>
			</CardSettings>
		);
	}

	return (
		<CardSettings
			title="Imported"
			action={
				<Button asChild size="sm" variant="outline">
					<Link href="/campaigns">See the issues</Link>
				</Button>
			}
		>
			<RowSettings label="Report" hint={postImport.finishedAt ? `Finished ${formatDate(postImport.finishedAt)}.` : undefined}>
				<span className="flex min-h-9 items-center text-sm text-pretty">{describeImportCounts(counts)}.</span>
			</RowSettings>
			{counts.redirects > 0 && (
				<RowSettings label="Redirects">
					<span className="flex min-h-9 items-center text-sm text-pretty">
						<span>
							They work once your old address points at FlockStack.{" "}
							<Link href="/docs/moving#redirects" className="font-medium underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
								How
							</Link>
						</span>
					</span>
				</RowSettings>
			)}
			{problems.length > 0 && (
				<RowSettings label="Not imported">
					<ul className="flex flex-col gap-1 py-2 text-sm">
						{problems.map(({ title, problem }, index) => (
							<li key={`${index}-${title}`} className="text-pretty">
								<span className="font-medium">{title}</span>: {problem}
							</li>
						))}
					</ul>
				</RowSettings>
			)}
		</CardSettings>
	);
}
