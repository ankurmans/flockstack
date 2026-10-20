"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { removeRecommendation } from "@/app/(app)/recommending/actions";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";

// Opened from a recommendation's row, so the row owns the open state. The record stays, removed, with its pitch: the row
// can recommend it again.
export default function DialogRemoveRecommendation({ newsletterId, item, isOpen, onOpenChange }) {
	const [isRemoving, startRemoving] = useTransition();
	const name = item.newsletter?.name ?? "this newsletter";

	function remove() {
		startRemoving(async () => {
			const result = await removeRecommendation({ newsletterId, id: item.id });
			if (result?.error) return void toast.error(result.error);
			onOpenChange(false);
			toast.success(`You no longer recommend ${name}`);
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Stop recommending {name}?</DialogTitle>
					<DialogDescription>
						Your readers stop seeing it right away. Your pitch and its numbers stay here, so you can recommend it again later.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={isRemoving} className="min-w-20">
						{isRemoving ? <Loader2 className="animate-spin" /> : "Stop recommending"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
