"use client";

import { useState, useTransition } from "react";
import { Loader2, Users } from "lucide-react";
import { listPollVoters } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";

// A poll of a sent issue: votes per answer, from emails and the website, and who picked each answer.
// poll: get_poll's output.
export default function CardPollResults({ poll }) {
	const [voters, setVoters] = useState(null);
	const [isPending, startTransition] = useTransition();
	const total = poll.votes.total;

	function showVoters(option) {
		startTransition(async () => {
			const result = await listPollVoters(poll.id, option);
			if (result?.error) return void toast.error(result.error);
			setVoters({ option, list: result.voters, hasMore: Boolean(result.nextCursor) });
		});
	}

	return (
		<section className="rounded-xl bg-card p-4 shadow-border">
			<div className="flex items-baseline justify-between gap-3">
				<h2 className="text-sm font-medium">{poll.question}</h2>
				<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
					{formatNumber(total)} {total === 1 ? "vote" : "votes"}
					{poll.votes.web > 0 && ` · ${formatNumber(poll.votes.web)} on the website`}
				</span>
			</div>
			<ol className="mt-3 flex flex-col gap-2">
				{poll.options.map((option, index) => {
					const share = total > 0 ? Math.round((option.votes.total / total) * 100) : 0;
					return (
						<li key={option.label} className="flex items-center gap-3 text-sm">
							<span className="relative min-w-0 flex-1 overflow-hidden rounded-lg px-3 py-1.5 shadow-border">
								<span aria-hidden="true" className="absolute inset-y-0 left-0 bg-muted" style={{ width: `${share}%` }} />
								<span className="relative flex justify-between gap-3">
									<span className="truncate">{option.label}</span>
									<span className="shrink-0 tabular-nums text-muted-foreground">
										{formatNumber(option.votes.email)}
										{option.votes.web > 0 && ` + ${formatNumber(option.votes.web)} web`} · {share}%
									</span>
								</span>
							</span>
							<Button variant="ghost" size="sm" disabled={isPending || option.votes.email === 0} onClick={() => showVoters(index)} aria-label={`Who picked ${option.label}`}>
								{isPending && voters?.option === index ? <Loader2 className="animate-spin" /> : <Users />}
							</Button>
						</li>
					);
				})}
			</ol>
			{voters && (
				<div className="mt-4 border-t border-border/60 pt-3">
					<h3 className="text-xs font-medium text-muted-foreground">Who picked {poll.options[voters.option]?.label}</h3>
					<ul className="mt-2 flex flex-col gap-1.5 text-sm">
						{voters.list.map((voter) => (
							<li key={voter.contactId} className="min-w-0">
								<span className="block truncate">{voter.email}</span>
								{voter.comment && <span className="block text-muted-foreground text-pretty">“{voter.comment}”</span>}
							</li>
						))}
					</ul>
					{voters.hasMore && <p className="mt-2 text-xs text-muted-foreground">The first 100. The API&apos;s list_poll_voters has the rest.</p>}
				</div>
			)}
		</section>
	);
}
