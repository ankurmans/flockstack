"use client";

import { useEffect, useState, useTransition } from "react";
import { Download, Loader2 } from "lucide-react";
import { getExportStatus, startExport } from "@/app/(account)/account/export/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { formatDate, formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";

const POLL_MS = 4000;

// Everything the account has, in ZIP files: always available, whatever the account's plan or state. The export is made
// in the background, so while it is queued or running the card asks how it is doing, and the owner gets an email.
export default function CardExport({ initial }) {
	const [exportData, setExportData] = useState(initial);
	const [isStarting, startStarting] = useTransition();
	const isBusy = isStarting || exportData?.status === "queued" || exportData?.status === "running";
	const isWaiting = exportData?.status === "queued" || exportData?.status === "running";

	useEffect(() => {
		if (!isWaiting) return;
		const interval = setInterval(async () => {
			const result = await getExportStatus();
			if (result.export) setExportData(result.export);
		}, POLL_MS);
		return () => clearInterval(interval);
	}, [isWaiting]);

	function start() {
		startStarting(async () => {
			const result = await startExport();
			if (result.error) return void toast.error(result.error);
			setExportData(result.export);
		});
	}

	return (
		<CardSettings
			title="Export your data"
			stagger={3}
			action={
				<Button variant="outline" size="sm" onClick={start} disabled={isBusy}>
					{isBusy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Download data-icon="inline-start" />}
					{isBusy ? "Preparing" : "Export everything"}
				</Button>
			}
		>
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				Your contacts, every issue and draft as Markdown and HTML, your pictures and your settings, in ZIP files you can take anywhere. It
				works whatever your plan, and if your account is blocked. We email you the links when it&apos;s ready.
			</p>
			{exportData && <RowExport exportData={exportData} />}
		</CardSettings>
	);
}

function RowExport({ exportData }) {
	const { status, counts, downloadUrls, expiresAt, error } = exportData;
	if (status === "queued" || status === "running") {
		return (
			<RowSettings label="Status">
				<span className="flex min-h-9 items-center text-sm" role="status">
					Preparing your export. This can take a few minutes for a large list.
				</span>
			</RowSettings>
		);
	}
	if (status === "failed") {
		return (
			<RowSettings label="Status" hint="Nothing was lost. Try again.">
				<span className="flex min-h-9 items-center text-sm text-destructive">The last export stopped{error ? `: ${error}` : ""}</span>
			</RowSettings>
		);
	}
	if (status === "expired" || downloadUrls.length === 0) {
		return (
			<RowSettings label="Status">
				<span className="flex min-h-9 items-center text-sm text-muted-foreground">The last export&apos;s links ran out. Export again for new ones.</span>
			</RowSettings>
		);
	}
	return (
		<RowSettings
			label="Ready"
			hint={`${formatNumber(counts.contacts)} contacts, ${formatNumber(counts.campaigns)} issues and ${formatNumber(counts.images)} pictures. The links work until ${formatDate(expiresAt)}.`}
		>
			<span className="flex flex-wrap gap-2">
				{downloadUrls.map((url, index) => (
					<Button key={url} asChild variant="outline" size="sm">
						<a href={url}>
							<Download data-icon="inline-start" />
							{downloadUrls.length > 1 ? `Part ${index + 1} of ${downloadUrls.length}` : "Download ZIP"}
						</a>
					</Button>
				))}
			</span>
		</RowSettings>
	);
}
