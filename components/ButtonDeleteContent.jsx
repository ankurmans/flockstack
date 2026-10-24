"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { deleteContentItem, deleteEditorialBatch } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// Deleting an item or a batch asks twice. An item's campaign, the media library's files and a batch's items are not touched.
export default function ButtonDeleteContent({ id, kind = "item" }) {
	const [isAsking, setIsAsking] = useState(false);
	const [isDeleting, startDeleting] = useTransition();

	if (!isAsking) {
		return (
			<Button type="button" variant="ghost" size="sm" onClick={() => setIsAsking(true)}>
				<Trash2 data-icon="inline-start" />
				Delete
			</Button>
		);
	}

	return (
		<span className="flex items-center gap-1" role="group" aria-label={`Delete this ${kind}?`}>
			<Button
				type="button"
				variant="destructive"
				size="sm"
				disabled={isDeleting}
				onClick={() =>
					startDeleting(async () => {
						const result = await (kind === "batch" ? deleteEditorialBatch(id) : deleteContentItem(id));
						if (result?.error) toast.error(result.error);
					})
				}
			>
				Delete this {kind}
			</Button>
			<Button type="button" variant="ghost" size="sm" onClick={() => setIsAsking(false)}>
				Keep it
			</Button>
		</span>
	);
}
