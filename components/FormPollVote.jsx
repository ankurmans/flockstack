"use client";

import { useActionState, useEffect, useRef } from "react";
import { Link2Off, Loader2, Vote } from "lucide-react";
import { vote } from "@/app/poll/actions";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";

// Link scanners open the page without submitting forms, so only a person's browser casts the vote.
export default function FormPollVote({ pollId, option, token, question, answer }) {
	const [state, action, isPending] = useActionState(vote.bind(null, pollId, option, token), null);
	const formRef = useRef(null);

	useEffect(() => {
		formRef.current?.requestSubmit();
	}, []);

	if (state?.error === "invalid") {
		return (
			<CardNotice icon={Link2Off} title="This link doesn't work">
				The poll may be gone, or the link is from another newsletter&apos;s email.
			</CardNotice>
		);
	}

	return (
		<CardNotice icon={isPending ? Loader2 : Vote} spin={isPending} title={question}>
			{state?.error === "busy" ? "Too many votes from your network. Try again in a few minutes." : `Your answer: ${answer}`}
			<form ref={formRef} action={action} className="mt-6">
				<Button type="submit" size="lg" disabled={isPending} className="w-full">
					{isPending ? "Voting…" : "Vote"}
				</Button>
			</form>
		</CardNotice>
	);
}
