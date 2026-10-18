"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCampaignSegment } from "@/app/(app)/campaigns/actions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";

const EVERYONE = "__everyone__";

// Who a campaign goes to: all the newsletter's active contacts, or one of its saved segments.
export default function SelectSegment({ campaignId, segmentId, segments }) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();

	function choose(value) {
		startTransition(async () => {
			const result = await setCampaignSegment(campaignId, value === EVERYONE ? null : value);
			if (result?.error) return void toast.error(result.error);
			router.refresh();
		});
	}

	return (
		<Select value={segmentId ?? EVERYONE} onValueChange={choose} disabled={isPending}>
			<SelectTrigger className="h-9 w-full sm:w-64" aria-label="Audience">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={EVERYONE}>Everyone</SelectItem>
				{segments.map((segment) => (
					<SelectItem key={segment.id} value={segment.id}>
						{segment.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
