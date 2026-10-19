"use client";

import { useActionState } from "react";
import { Check, Loader2 } from "lucide-react";
import { answerFollowUp } from "@/app/poll/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// The poll's follow-up question, answered in a few words on the reader's own vote.
export default function FormPollFollowUp({ pollId, token, question, defaultValue = "" }) {
	const [state, action, isPending] = useActionState(answerFollowUp.bind(null, pollId, token), null);

	if (state?.ok) {
		return (
			<p role="status" className="mt-6 flex items-center justify-center gap-2 text-sm font-medium text-foreground">
				<Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
				Thanks, that&apos;s sent.
			</p>
		);
	}

	return (
		<form action={action} className="mt-6 flex flex-col gap-2 text-left">
			<label htmlFor="follow-up" className="text-sm font-medium text-foreground">
				{question}
			</label>
			<Textarea id="follow-up" name="comment" defaultValue={defaultValue} maxLength={1000} rows={3} required />
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
			<Button type="submit" disabled={isPending} className="mt-1">
				{isPending ? <Loader2 className="animate-spin" /> : "Send"}
			</Button>
		</form>
	);
}
