"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { linkContentCampaign } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

const SELECT_CLASS = "h-9 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25";

// The campaign an item points at: a newsletter item's own issue, or the issue a post is derived from. Linking reads the
// campaign and changes nothing on it. Sending and scheduling stay in the campaign, with its own review and approval.
export default function PanelContentCampaign({ item, drafts }) {
	const router = useRouter();
	const [campaignId, setCampaignId] = useState("");
	const [isLinking, startLinking] = useTransition();
	const isIssue = item.channel === "newsletter";

	function link(next) {
		startLinking(async () => {
			const result = await linkContentCampaign(item.id, next);
			if (result?.error) return void toast.error(result.error);
			if (result.approvalWithdrawn) toast.message("This change took the approval back. Ask for a review again.");
			setCampaignId("");
			router.refresh();
		});
	}

	return (
		<section className="rounded-xl bg-card shadow-border animate-enter" aria-label="Issue">
			<h2 className="flex h-12 items-center px-4 text-sm font-medium">{isIssue ? "Newsletter issue" : "Source issue"}</h2>
			<div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3 text-sm">
				{item.campaign ? (
					<>
						<p>
							<Link href={`/campaigns/${item.campaign.id}`} className="font-medium text-link hover:underline">
								{item.campaign.subject || "Untitled"}
							</Link>
							<span className="block text-xs text-muted-foreground">
								{item.campaign.status === "draft" ? "Draft: not scheduled" : item.campaign.status}
								{item.campaign.scheduledAt && item.campaign.status === "scheduled" && ` for ${item.campaign.scheduledAt.slice(0, 16).replace("T", " ")} UTC`}
							</span>
						</p>
						<p className="text-xs text-muted-foreground">Edit, test, schedule and send the issue in the campaign. This page only plans it.</p>
						<div>
							<Button type="button" variant="ghost" size="sm" disabled={isLinking} onClick={() => link(null)}>
								Unlink
							</Button>
						</div>
					</>
				) : (
					<p className="text-muted-foreground">{item.delivery.status === "issue_missing" ? "The linked issue was deleted." : isIssue ? "No issue linked." : "Not derived from an issue."}</p>
				)}
				{drafts.length > 0 && (
					<div className="flex gap-2">
						<label className="sr-only" htmlFor="link-draft">
							Draft to link
						</label>
						<select id="link-draft" value={campaignId} onChange={(event) => setCampaignId(event.target.value)} className={SELECT_CLASS}>
							<option value="">{item.campaign ? "Link another draft" : "Link a draft"}</option>
							{drafts.map((draft) => (
								<option key={draft.id} value={draft.id}>
									{draft.subject || "Untitled"}
								</option>
							))}
						</select>
						<Button type="button" variant="outline" disabled={!campaignId || isLinking} onClick={() => link(campaignId)}>
							Link
						</Button>
					</div>
				)}
			</div>
		</section>
	);
}
