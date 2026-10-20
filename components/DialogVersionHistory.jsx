"use client";

import { useEffect, useState, useTransition } from "react";
import { History, Loader2 } from "lucide-react";
import { listCampaignVersions, readCampaignVersion, restoreCampaignVersion } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCount, formatRelative } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// The draft's earlier states (lib/campaign-versions.js): pick one to read it, and restore it. The draft as it is now is kept
// first, so a restore can be undone the same way. onSave saves what the editor holds, so the list is current; the page
// reloads after a restore.
export default function DialogVersionHistory({ campaignId, isOpen, onOpenChange, onSave }) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<PanelVersions campaignId={campaignId} onSave={onSave} onClose={() => onOpenChange(false)} />
			</DialogContent>
		</Dialog>
	);
}

// Mounted when the dialog opens, so every opening starts with a fresh list.
function PanelVersions({ campaignId, onSave, onClose }) {
	const [versions, setVersions] = useState(null);
	const [error, setError] = useState(null);
	const [selected, setSelected] = useState(null);
	const [detail, setDetail] = useState(null);
	const [isRestoring, startRestoring] = useTransition();

	useEffect(() => {
		let isCurrent = true;
		(async () => {
			const isSaved = await onSave();
			const result = isSaved ? await listCampaignVersions(campaignId) : { error: "Couldn't save the draft first" };
			if (!isCurrent) return;
			if (result.error) setError(result.error);
			else setVersions(result.versions);
		})();
		return () => {
			isCurrent = false;
		};
	}, [campaignId, onSave]);

	async function select(version) {
		setSelected(version.id);
		setDetail(null);
		const result = await readCampaignVersion(campaignId, version.id);
		setDetail(result.error ? { error: result.error } : result);
	}

	function restore() {
		startRestoring(async () => {
			const result = await restoreCampaignVersion(campaignId, selected);
			if (result?.error) return toast.error(result.error);
			window.location.reload();
		});
	}

	return (
		<>
			<DialogHeader>
				<DialogTitle>Version history</DialogTitle>
				<DialogDescription>Earlier states of this draft, kept as you write. Restoring one keeps the draft as it is now first.</DialogDescription>
			</DialogHeader>
			{error && (
				<p role="alert" className="rounded-lg bg-muted p-3 text-sm">
					{error}
				</p>
			)}
			{!error && versions === null && (
				<div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
					<Loader2 className="size-4 animate-spin" />
					Loading…
				</div>
			)}
			{versions?.length === 0 && <p className="py-6 text-sm text-muted-foreground">Nothing earlier yet. States are kept as you edit.</p>}
			{versions?.length > 0 && (
				<div className="grid max-h-[55dvh] gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
					<ul className="flex flex-col gap-1 overflow-y-auto" aria-label="Versions">
						{versions.map((version) => (
							<li key={version.id}>
								<button
									type="button"
									onClick={() => select(version)}
									aria-current={version.id === selected || undefined}
									className={cn(
										"w-full rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-muted",
										version.id === selected && "bg-muted"
									)}
								>
									<span className="block font-medium">{formatRelative(version.createdAt)}</span>
									<span className="block truncate text-xs text-muted-foreground">
										{version.subject || "No subject"} · {formatCount(version.words, "word")}
										{version.reason === "restore" ? " · before a restore" : ""}
									</span>
								</button>
							</li>
						))}
					</ul>
					<div className="min-w-0 overflow-y-auto rounded-lg border border-border p-3 text-sm">
						{!selected && <p className="text-muted-foreground">Pick a version to read it.</p>}
						{selected && !detail && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
						{detail?.error && <p>{detail.error}</p>}
						{detail && !detail.error && (
							<>
								<p className="font-medium">{detail.subject || "No subject"}</p>
								{detail.previewText && <p className="text-muted-foreground">{detail.previewText}</p>}
								<p className="mt-3 whitespace-pre-wrap">{detail.text || "No text"}</p>
							</>
						)}
					</div>
				</div>
			)}
			<DialogFooter>
				<Button variant="outline" onClick={onClose}>
					Close
				</Button>
				<Button onClick={restore} disabled={!selected || !detail || Boolean(detail.error) || isRestoring}>
					{isRestoring ? <Loader2 className="animate-spin" /> : <History data-icon="inline-start" />}
					Restore this version
				</Button>
			</DialogFooter>
		</>
	);
}
