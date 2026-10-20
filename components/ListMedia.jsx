"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Check, Copy, FileText, FolderInput, Loader2 } from "lucide-react";
import { moveMedia } from "@/app/(app)/media/actions";
import { CHECKERBOARD } from "@/components/DialogImagePicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatBytes, formatDate } from "@/lib/format";
import { FOLDER_RULE } from "@/lib/media-rules";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// The library's uploads as a grid: pick some and move them to a folder; copy a link to any.
export default function ListMedia({ media, folders }) {
	const router = useRouter();
	const [selected, setSelected] = useState(() => new Set());
	const [isMoving, setIsMoving] = useState(false);
	const [copied, setCopied] = useState(null);

	function toggle(id) {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	async function copy(item) {
		try {
			await navigator.clipboard.writeText(item.url);
			setCopied(item.id);
			setTimeout(() => setCopied((current) => (current === item.id ? null : current)), 1500);
		} catch {
			toast.error("Couldn't copy the link");
		}
	}

	return (
		<>
			<div className="mb-3 flex min-h-9 items-center gap-3">
				{selected.size > 0 ? (
					<>
						<span className="text-sm tabular-nums">{selected.size} selected</span>
						<Button variant="outline" size="sm" onClick={() => setIsMoving(true)}>
							<FolderInput data-icon="inline-start" />
							Move to folder
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
							Clear
						</Button>
					</>
				) : (
					<span className="text-sm text-muted-foreground">Select uploads to move them to a folder.</span>
				)}
			</div>
			<ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
				{media.map((item) => {
					const isSelected = selected.has(item.id);
					return (
						<li key={item.id} className={cn("group relative flex flex-col overflow-hidden rounded-xl shadow-border", isSelected && "ring-2 ring-foreground")}>
							<label className="absolute top-2 left-2 z-10 grid size-6 cursor-pointer place-items-center rounded-md bg-background/90 shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-ring">
								<input type="checkbox" checked={isSelected} onChange={() => toggle(item.id)} aria-label={`Select ${item.name}`} className="size-4 accent-foreground" />
							</label>
							<a href={item.url} target="_blank" rel="noreferrer" aria-label={`Open ${item.name}`} className="block aspect-square" style={item.kind === "image" ? CHECKERBOARD : undefined}>
								{item.kind === "image" ? (
									<Image src={item.url} alt="" width={240} height={240} unoptimized loading="lazy" className="size-full object-cover" />
								) : (
									<span className="grid size-full place-items-center bg-muted text-muted-foreground">
										<FileText className="size-8" aria-hidden="true" />
									</span>
								)}
							</a>
							<div className="flex items-center gap-1 p-2">
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium" title={item.name}>
										{item.name}
									</p>
									<p className="truncate text-xs text-muted-foreground">
										{formatBytes(item.bytes)} · {formatDate(item.createdAt)}
										{item.folder ? ` · ${item.folder}` : ""}
									</p>
								</div>
								<Button variant="ghost" size="icon-sm" aria-label={`Copy link to ${item.name}`} onClick={() => copy(item)}>
									{copied === item.id ? <Check /> : <Copy />}
								</Button>
							</div>
						</li>
					);
				})}
			</ul>
			<DialogMove
				isOpen={isMoving}
				onOpenChange={setIsMoving}
				ids={[...selected]}
				folders={folders}
				onMoved={() => {
					setIsMoving(false);
					setSelected(new Set());
					router.refresh();
				}}
			/>
		</>
	);
}

function DialogMove({ isOpen, onOpenChange, ids, folders, onMoved }) {
	const [name, setName] = useState("");
	const [isPending, startTransition] = useTransition();

	function move(folder) {
		startTransition(async () => {
			const result = await moveMedia(ids, folder);
			if (result?.error) return toast.error(result.error);
			toast.success(folder ? `Moved to ${folder}` : "Taken out of its folder");
			onMoved();
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Move {ids.length === 1 ? "1 upload" : `${ids.length} uploads`}</DialogTitle>
					<DialogDescription>Nothing is deleted and no link changes: emails already sent keep their pictures.</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-1">
					{folders.map((folder) => (
						<Button key={folder} variant="ghost" className="justify-start" disabled={isPending} onClick={() => move(folder)}>
							{folder}
						</Button>
					))}
					<Button variant="ghost" className="justify-start text-muted-foreground" disabled={isPending} onClick={() => move("")}>
						No folder
					</Button>
				</div>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (name.trim()) move(name);
					}}
					className="flex flex-col gap-2"
				>
					<label htmlFor="new-folder" className="text-sm font-medium">
						New folder
					</label>
					<div className="flex gap-2">
						<Input id="new-folder" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="Folder name" />
						<Button type="submit" disabled={isPending || !name.trim()}>
							{isPending ? <Loader2 className="animate-spin" /> : "Move"}
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">{FOLDER_RULE}.</p>
				</form>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
