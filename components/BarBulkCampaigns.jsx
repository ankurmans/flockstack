"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, FolderInput, Loader2, Trash2 } from "lucide-react";
import { bulkUpdateCampaigns } from "@/app/(app)/campaigns/actions";
import { useCampaignSelection } from "@/components/ProviderCampaignSelection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatCount } from "@/lib/format";
import { toast } from "@/lib/toast";

const EDITABLE = ["draft", "scheduled"];

// What several ticked campaigns can do together: delete drafts, take issues off the website's list, or move drafts to another
// newsletter. What can't be done to one of them is skipped, with the reason in the message.
export default function BarBulkCampaigns({ newsletters = [], currentNewsletterId }) {
	const router = useRouter();
	const selection = useCampaignSelection();
	const [isConfirming, setIsConfirming] = useState(false);
	const [isPending, startTransition] = useTransition();
	if (!selection || selection.selected.size === 0) return null;

	const ids = [...selection.selected.keys()];
	const statuses = [...selection.selected.values()];
	const editable = statuses.filter((status) => EDITABLE.includes(status)).length;
	const drafts = statuses.filter((status) => status === "draft").length;
	const others = newsletters.filter(({ id }) => id !== currentNewsletterId);

	function run(operation, newsletter) {
		startTransition(async () => {
			const result = await bulkUpdateCampaigns(ids, operation, newsletter);
			setIsConfirming(false);
			if (result?.error) return toast.error(result.error);
			const message = `${formatCount(result.done, "campaign")} ${{ delete: "deleted", unlist: "taken off the list", list: "put on the list", move: "moved" }[operation]}`;
			if (result.skipped > 0) toast.message(`${message}. ${result.skipped} skipped: ${result.reasons.join("; ")}.`);
			else toast.success(message);
			selection.clear();
			router.refresh();
		});
	}

	return (
		<div role="region" aria-label="Selected campaigns" className="fixed right-(--dock-right) bottom-(--dock-bottom) left-4 z-30 flex flex-wrap items-center gap-2 rounded-xl bg-card p-2 pl-4 shadow-float md:left-64">
			<span className="mr-auto text-sm tabular-nums">{ids.length} selected</span>
			<Button variant="outline" size="sm" disabled={isPending || editable === 0} onClick={() => setIsConfirming(true)}>
				<Trash2 data-icon="inline-start" />
				Delete drafts
			</Button>
			<Button variant="outline" size="sm" disabled={isPending} onClick={() => run("unlist")}>
				<EyeOff data-icon="inline-start" />
				Unlist
			</Button>
			<Button variant="outline" size="sm" disabled={isPending} onClick={() => run("list")}>
				List
			</Button>
			{others.length > 0 && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline" size="sm" disabled={isPending || drafts === 0}>
							<FolderInput data-icon="inline-start" />
							Move drafts
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{others.map(({ id, name }) => (
							<DropdownMenuItem key={id} onSelect={() => run("move", id)}>
								{name}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			<Button variant="ghost" size="sm" onClick={selection.clear} disabled={isPending}>
				Clear
			</Button>
			<Dialog open={isConfirming} onOpenChange={setIsConfirming}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete {formatCount(editable, "draft")}?</DialogTitle>
						<DialogDescription>
							They leave every list, and a scheduled send never goes out. Sent issues in your selection stay as they are.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setIsConfirming(false)}>
							Cancel
						</Button>
						<Button variant="destructive" onClick={() => run("delete")} disabled={isPending}>
							{isPending ? <Loader2 className="animate-spin" /> : "Delete"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
