import { useState, useTransition } from "react";
import { previewCleanup } from "@/app/(app)/campaigns/actions";

// Counted each time a send dialog opens rather than with the page: it reads the whole list.
export function useCleanupPreview(campaignId) {
	const [preview, setPreview] = useState(null);
	const [isCounting, startCounting] = useTransition();

	// audienceOrder: engaged or random, the order the count walks the list in.
	function loadPreview(audienceOrder) {
		startCounting(async () => setPreview(await previewCleanup(campaignId, audienceOrder)));
	}

	return { preview, isCounting, loadPreview };
}
