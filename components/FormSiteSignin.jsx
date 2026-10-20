"use client";

import { useActionState } from "react";
import { Loader2, MailCheck } from "lucide-react";
import { requestSiteSignIn } from "@/app/archive/reader-actions";
import { Button } from "@/components/ui/button";

// "Email me a sign-in link": a link by email, no password. The answer is the same for every address.
export default function FormSiteSignin({ slug }) {
	const [state, action, isPending] = useActionState(requestSiteSignIn, null);

	if (state?.ok) {
		return (
			<p role="status" className="flex items-start gap-2.5 rounded-xl bg-muted/60 p-4 text-sm text-pretty animate-enter">
				<MailCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				{state.message}
			</p>
		);
	}

	return (
		<form action={action} className="flex flex-col gap-2">
			<input type="hidden" name="newsletter" value={slug} />
			<div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
				<input type="text" name="website" tabIndex={-1} autoComplete="off" />
			</div>
			<label htmlFor="site-signin-email" className="text-sm font-medium">
				Your email
			</label>
			<div className="flex flex-col gap-2 sm:flex-row">
				<input
					id="site-signin-email"
					type="email"
					name="email"
					required
					autoComplete="email"
					placeholder="you@example.com"
					aria-describedby={state?.error ? "site-signin-error" : undefined}
					className="h-11 min-w-0 flex-1 rounded-xl bg-background px-3.5 text-base shadow-border outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25"
				/>
				<Button type="submit" disabled={isPending} className="h-11 rounded-xl px-5">
					{isPending ? <Loader2 className="animate-spin" /> : "Email me a sign-in link"}
				</Button>
			</div>
			{state?.error && (
				<p id="site-signin-error" role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
		</form>
	);
}
