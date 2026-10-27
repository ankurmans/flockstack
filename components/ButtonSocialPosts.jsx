"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import { savePostToPlan } from "@/app/(app)/campaigns/calendar/actions";
import { draftSocialPosts } from "@/app/(app)/campaigns/actions";
import DialogSocialPosts from "@/components/DialogSocialPosts";
import { Button } from "@/components/ui/button";
import { DEFAULT_SOCIAL_PLATFORMS } from "@/lib/ai-writing";
import { useAiRun } from "@/lib/use-ai-run";

// A sent issue's report: drafts for it on LinkedIn, X, Facebook, Threads or Bluesky, with the issue's page link at the end of each.
export default function ButtonSocialPosts({ campaignId, newsletterId, subject }) {
	const [isOpen, setIsOpen] = useState(false);
	const run = useAiRun();
	const ask = (platforms) => run.run(() => draftSocialPosts(campaignId, subject, platforms));

	return (
		<>
			<Button
				variant="outline"
				onClick={() => {
					setIsOpen(true);
					ask(DEFAULT_SOCIAL_PLATFORMS);
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
				onSave={async (text) => {
					const result = await savePostToPlan(newsletterId, campaignId, `LinkedIn: ${subject}`, text);
					return result?.error ? result : { ...result, href: `/campaigns/calendar/items/${result.id}` };
				}}
			/>
		</>
	);
}
