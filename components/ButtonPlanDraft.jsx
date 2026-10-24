"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { planCampaignDraft } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// Puts a draft campaign in the plan as a newsletter item. The draft is only linked: it stays a draft and nothing is scheduled.
export default function ButtonPlanDraft({ newsletterId, campaignId, subject }) {
	const router = useRouter();
	const [isAdding, startAdding] = useTransition();

	return (
		<Button
			type="button"
			size="sm"
			variant="outline"
			disabled={isAdding}
			aria-label={`Add ${subject || "this draft"} to the plan`}
			onClick={() =>
				startAdding(async () => {
					const result = await planCampaignDraft(newsletterId, campaignId);
					if (result?.error) return void toast.error(result.error);
					router.push(`/campaigns/calendar/items/${result.id}`);
				})
			}
		>
			Add to plan
		</Button>
	);
}
