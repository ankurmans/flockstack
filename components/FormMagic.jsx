"use client";

import { useActionState, useEffect, useRef } from "react";
import { Link2Off, Loader2, MailCheck, MailOpen } from "lucide-react";
import { subscribeWithMagic } from "@/app/subscribe/magic/actions";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The page a Magic Link opens: the address the other platform filled in subscribes by itself, as the confirm page does,
// since a link scanner opens the page without running it. An address that didn't come through (the merge tag was left
// as it was) or that was refused is asked for here.
export default function FormMagic({ newsletterName, slug, keyId, signature, email, utm = {}, from = "", isAutomatic }) {
	const [state, action, isPending] = useActionState(subscribeWithMagic, null);
	const formRef = useRef(null);

	useEffect(() => {
		if (isAutomatic && email) formRef.current?.requestSubmit();
	}, [isAutomatic, email]);

	if (state?.ok) {
		return state.pending ? (
			<CardNotice icon={MailOpen} tone="success" title="Check your inbox">
				We sent a link to <span className="font-medium break-words text-foreground">{state.email}</span>. Click it to confirm, and the next issue of {newsletterName} is yours. If it isn&apos;t there, check Promotions or Spam.
				{state.inbox && (
					<Button asChild size="lg" className="mt-6 w-full">
						<a href={state.inbox.url} target="_blank" rel="noopener noreferrer">
							Open {state.inbox.name}
						</a>
					</Button>
				)}
			</CardNotice>
		) : (
			<CardNotice icon={MailCheck} tone="success" title="Done">
				If this address isn&apos;t on the list of {newsletterName} already, its next issue is on the way.
			</CardNotice>
		);
	}

	const isAsking = !email || Boolean(state?.error);
	return (
		<form ref={formRef} action={action} className="w-full max-w-sm">
			<input type="hidden" name="newsletter" value={slug} />
			<input type="hidden" name="k" value={keyId} />
			<input type="hidden" name="sig" value={signature} />
			<input type="hidden" name="from" value={from} />
			{Object.entries(utm).map(([name, value]) => (
				<input key={name} type="hidden" name={name} value={value} />
			))}
			<div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
				<input type="text" name="website" tabIndex={-1} autoComplete="off" />
			</div>
			{isAsking ? (
				<CardNotice icon={state?.error ? Link2Off : MailCheck} title={`Subscribe to ${newsletterName}`}>
					<div className="mt-4 flex flex-col gap-3 text-left">
						<Input type="email" name="email" defaultValue={email} required autoComplete="email" placeholder="you@example.com" aria-label="Email" className="h-11" />
						{state?.error && (
							<p role="alert" className="text-sm text-destructive">
								{state.error}
							</p>
						)}
						<Button type="submit" size="lg" disabled={isPending}>
							{isPending && <Loader2 className="animate-spin" />}
							Subscribe
						</Button>
					</div>
				</CardNotice>
			) : (
				<>
					<input type="hidden" name="email" value={email} />
					<CardNotice icon={isPending ? Loader2 : MailCheck} spin={isPending} title={`Subscribing to ${newsletterName}`}>
						{isPending ? "One moment." : "Press the button to subscribe."}
						<Button type="submit" size="lg" className="mt-6 w-full" disabled={isPending}>
							Subscribe
						</Button>
					</CardNotice>
				</>
			)}
		</form>
	);
}
