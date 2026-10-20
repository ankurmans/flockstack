"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import { draftSocialPosts } from "@/app/(app)/campaigns/actions";
import DialogSocialPosts from "@/components/DialogSocialPosts";
import { Button } from "@/components/ui/button";
import { useAiRun } from "@/lib/use-ai-run";

// A sent issue's report: LinkedIn and X drafts for it, with the issue's page link at the end of each.
export default function ButtonSocialPosts({ campaignId, subject }) {
	const [isOpen, setIsOpen] = useState(false);
	const run = useAiRun();
	const ask = () => run.run(() => draftSocialPosts(campaignId, subject));

	return (
		<>
			<Button
				variant="outline"
				onClick={() => {
					setIsOpen(true);
					ask();
				}}
			>
				<Share2 data-icon="inline-start" />
				Social posts
			</Button>
			<DialogSocialPosts
				isOpen={isOpen}
				onOpenChange={(open) => {
					setIsOpen(open);
					if (!open) run.reset();
				}}
				run={run}
				onRetry={ask}
			/>
		</>
	);
}
