"use client";

import { useActionState, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Loader2, Lock, MailCheck } from "lucide-react";
import { unlockIssue } from "@/app/archive/reader-actions";
import { requestGateSignIn } from "@/app/archive/gate-actions";
import BodyIssue from "@/components/BodyIssue";
import FormSubscribe from "@/components/FormSubscribe";
import { Button } from "@/components/ui/button";
import { readerMarkerName } from "@/lib/reader-cookies";
import { gateReturnKey, storeValue } from "@/lib/storage";

function noop() {
	return () => {};
}

// An issue the newsletter gates (lib/popup-rules.js): its beginning, then the signup form. A browser with a reader session for
// the newsletter (an emailed link, or a confirmation) asks for the rest like a paid reader's does (lib/reader-access.js), and the
// server gives it only to a subscriber who is still active. Anyone else subscribes, or asks for a sign-in link if they already do.
export default function GateIssue({ preview, newsletter, post, subscribeHref }) {
	// The marker cookie says this browser has a session for the newsletter; the page is cached, so only the browser can tell.
	const hasSession = useSyncExternalStore(
		noop,
		() => document.cookie.split("; ").includes(`${readerMarkerName(newsletter.slug)}=1`),
		() => false
	);
	const [full, setFull] = useState(null);
	const [isRefused, setIsRefused] = useState(false);
	const [joined, setJoined] = useState(null);

	useEffect(() => {
		if (!hasSession) return;
		let isCurrent = true;
		unlockIssue(newsletter.slug, post)
			.then((answer) => isCurrent && (answer?.unlocked ? setFull(answer) : setIsRefused(true)))
			.catch(() => isCurrent && setIsRefused(true));
		return () => {
			isCurrent = false;
		};
	}, [hasSession, newsletter.slug, post]);
	const status = full ? "open" : hasSession && !isRefused ? "checking" : "locked";

	// The confirmation page leads back here, in this browser.
	const onJoined = useCallback(
		(state) => {
			storeValue(gateReturnKey(newsletter.slug), window.location.pathname);
			setJoined(state.pending ? "pending" : "active");
		},
		[newsletter.slug]
	);

	if (status === "open") {
		return <BodyIssue slug={newsletter.slug} post={post} initial={full} newsletterName={newsletter.name} subscribeHref={subscribeHref} />;
	}

	return (
		<>
			<div className="prose-issue mt-10" dangerouslySetInnerHTML={{ __html: preview }} />
			<div className="relative mt-2">
				<div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-24 h-24 bg-gradient-to-t from-background to-transparent" />
				<section id="subscribe" aria-labelledby="gate-title" className="flex scroll-mt-24 flex-col items-center gap-3 rounded-2xl bg-card px-6 py-10 text-center shadow-border">
					<span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
						{status === "checking" ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : <Lock className="size-5" aria-hidden="true" />}
					</span>
					{status === "checking" ? (
						<p role="status" className="text-sm text-muted-foreground">
							Opening the full issue.
						</p>
					) : (
						<>
							<h2 id="gate-title" className="text-xl font-semibold tracking-tight text-balance">
								Subscribe to read the rest
							</h2>
							<p className="max-w-sm text-muted-foreground text-pretty">
								{newsletter.name} is free. Enter your email to keep reading, and get every issue in your inbox.
							</p>
							<FormSubscribe newsletterSlug={newsletter.slug} fields={newsletter.signupFields} via="gate" onResult={onJoined} className="mt-3 max-w-sm" />
							{joined && (
								<p role="status" className="max-w-sm text-sm text-pretty text-muted-foreground">
									{joined === "pending"
										? "Click the link in the email we sent, in this browser: it signs you in here and opens the full issue."
										: "You're subscribed. To read the rest here, ask for a sign-in link below."}
								</p>
							)}
							<FormSignIn slug={newsletter.slug} post={post} />
						</>
					)}
				</section>
			</div>
		</>
	);
}

// "Already subscribed?": a link by email, no password. The answer is the same for every address.
function FormSignIn({ slug, post }) {
	const [isAsking, setIsAsking] = useState(false);
	const [state, action, isPending] = useActionState(requestGateSignIn, null);

	if (state?.ok) {
		return (
			<p role="status" className="flex max-w-sm items-start gap-2.5 rounded-xl bg-muted/60 p-4 text-left text-sm text-pretty animate-enter">
				<MailCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				{state.message}
			</p>
		);
	}
	if (!isAsking) {
		return (
			<Button type="button" variant="link" onClick={() => setIsAsking(true)} className="text-muted-foreground">
				Already subscribed? Email me a link
			</Button>
		);
	}
	return (
		<form action={action} className="flex w-full max-w-sm flex-col gap-2 text-left">
			<input type="hidden" name="newsletter" value={slug} />
			<input type="hidden" name="p" value={post} />
			<div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
				<input type="text" name="website" tabIndex={-1} autoComplete="off" />
			</div>
			<label htmlFor={`gate-signin-${post}`} className="text-sm font-medium">
				Your email
			</label>
			<div className="flex gap-2">
				<input
					id={`gate-signin-${post}`}
					type="email"
					name="email"
					required
					autoFocus
					autoComplete="email"
					placeholder="you@example.com"
					className="h-11 min-w-0 flex-1 rounded-xl bg-background px-3.5 text-base shadow-border outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25"
				/>
				<Button type="submit" disabled={isPending} className="h-11 rounded-xl px-4">
					{isPending ? <Loader2 className="animate-spin" /> : "Send link"}
				</Button>
			</div>
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
		</form>
	);
}
