"use client";

import { useEffect, useId, useRef, useState } from "react";
import { LifeBuoy, SendHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { reportGoal } from "@/lib/goals";
import { clearChat, readStoredChat, saveChat, stripCitationMarks, toMailtoHref, toRequestMessages } from "@/lib/marketing/support-transcript";
import { SIGN_OUT_EVENT } from "@/lib/sign-out";
import { cn } from "@/lib/utils";

const MAX_QUESTION_CHARS = 1000;
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FAILED = "The assistant couldn't answer just now. Try again, or email a human.";

// The help chat's button and panel (SupportChat renders it where Workers AI is bound). The conversation is kept in
// this tab's sessionStorage only and sent with each question; "Email a human" sends it to support only when clicked.
// ph-no-capture keeps PostHog's autocapture out of it, and analytics hears only that it opened and answered.
export default function PanelSupportChat({ isSignedIn: isSignedInAtRender = false, supportEmail, openPath = null }) {
	const id = useId();
	const [isOpen, setIsOpen] = useState(false);
	const [messages, setMessages] = useState(null);
	const [question, setQuestion] = useState("");
	const [isAsking, setIsAsking] = useState(false);
	const [error, setError] = useState(null);
	const [isSignedIn, setIsSignedIn] = useState(isSignedInAtRender);
	const [handoff, setHandoff] = useState({ status: "idle", message: null });
	const launcherRef = useRef(null);
	const panelRef = useRef(null);
	const inputRef = useRef(null);
	const logRef = useRef(null);
	const hasReportedOpen = useRef(false);

	const conversation = messages ?? [];
	const hasQuestion = conversation.some(({ role }) => role === "user");

	function update(next) {
		setMessages(next);
		saveChat(window.sessionStorage, next);
	}

	function open() {
		setMessages((current) => current ?? readStoredChat(window.sessionStorage));
		setIsOpen(true);
		if (!hasReportedOpen.current) {
			hasReportedOpen.current = true;
			reportGoal("support_opened");
		}
	}

	function close() {
		setIsOpen(false);
		launcherRef.current?.focus();
	}

	// Links to the support chat's address ("Chat with us") open it in place, and so does arriving at that address.
	useEffect(() => {
		const onClick = (event) => {
			const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
			if (!openPath || !link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
			const url = new URL(link.href, location.href);
			if (url.origin !== location.origin || `${url.pathname}${url.search}` !== openPath) return;
			event.preventDefault();
			open();
		};
		const onSignOut = () => {
			clearChat(window.sessionStorage);
			setMessages([]);
		};
		document.addEventListener("click", onClick);
		window.addEventListener(SIGN_OUT_EVENT, onSignOut);
		const timer = openPath && `${location.pathname}${location.search}` === openPath ? setTimeout(open, 0) : null;
		return () => {
			document.removeEventListener("click", onClick);
			window.removeEventListener(SIGN_OUT_EVENT, onSignOut);
			if (timer) clearTimeout(timer);
		};
	}, [openPath]);

	useEffect(() => {
		if (isOpen) inputRef.current?.focus();
	}, [isOpen]);

	useEffect(() => {
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}, [messages, isAsking]);

	// A modal dialog: Tab stays inside it, and Escape closes it.
	function onPanelKeyDown(event) {
		if (event.key === "Escape") {
			event.stopPropagation();
			close();
			return;
		}
		if (event.key !== "Tab") return;
		const focusable = [...panelRef.current.querySelectorAll(FOCUSABLE)];
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable.at(-1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	async function ask(event) {
		event.preventDefault();
		const text = question.trim();
		if (!text || isAsking) return;
		const before = conversation;
		const next = [...before, { role: "user", content: text, sources: [], handoff: false }];
		update(next);
		setQuestion("");
		setError(null);
		setHandoff({ status: "idle", message: null });
		setIsAsking(true);
		try {
			const response = await fetch("/api/support/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: toRequestMessages(next) }),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok || typeof body?.answer !== "string") throw new Error(body?.error?.message ?? FAILED);
			update([...next, { role: "assistant", content: stripCitationMarks(body.answer), sources: body.sources ?? [], handoff: body.handoff === true }]);
			if (typeof body.signedIn === "boolean") setIsSignedIn(body.signedIn);
			reportGoal("support_answered");
		} catch (failure) {
			update(before);
			setQuestion(text);
			setError(failure instanceof TypeError ? FAILED : failure.message || FAILED);
		} finally {
			setIsAsking(false);
		}
	}

	async function sendToHuman() {
		setHandoff({ status: "sending", message: null });
		try {
			const response = await fetch("/api/support/email", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: toRequestMessages(conversation) }),
			});
			const body = await response.json().catch(() => null);
			if (response.status === 401) setIsSignedIn(false);
			if (!response.ok) throw new Error(body?.error?.message ?? `It didn't send. Email ${supportEmail} instead.`);
			setHandoff({ status: "sent", message: "Sent. FlockStack support will reply to your account email." });
		} catch (failure) {
			setHandoff({ status: "failed", message: failure instanceof TypeError ? `It didn't send. Email ${supportEmail} instead.` : failure.message });
		}
	}

	function onQuestionKeyDown(event) {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			event.currentTarget.form?.requestSubmit();
		}
	}

	return (
		<div data-support-chat className="ph-no-capture">
			<button
				ref={launcherRef}
				type="button"
				onClick={() => (isOpen ? close() : open())}
				aria-expanded={isOpen}
				aria-controls={`${id}-panel`}
				aria-haspopup="dialog"
				className="fixed right-(--chat-right) bottom-(--chat-bottom) z-40 flex size-[54px] flex-col items-center justify-center gap-0.5 rounded-full bg-primary text-[11px] font-medium text-primary-foreground shadow-lg transition-[scale,background-color] duration-150 outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.96]"
			>
				<LifeBuoy aria-hidden="true" className="size-5" />
				Help
			</button>

			{isOpen && (
				<section
					ref={panelRef}
					id={`${id}-panel`}
					role="dialog"
					aria-modal="true"
					aria-labelledby={`${id}-title`}
					aria-describedby={`${id}-note`}
					onKeyDown={onPanelKeyDown}
					className="ph-no-capture fixed inset-x-3 top-3 bottom-3 z-[60] flex flex-col overflow-hidden rounded-xl bg-background text-foreground shadow-border drop-shadow-xl sm:inset-x-auto sm:top-auto sm:right-(--chat-right) sm:bottom-[calc(var(--chat-bottom)+66px)] sm:h-[min(36rem,calc(100dvh-8rem))] sm:w-[24rem]"
				>
					<header className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
						<div className="min-w-0">
							<h2 id={`${id}-title`} className="text-sm font-semibold">
								Help
							</h2>
							<p id={`${id}-note`} className="text-xs text-pretty text-muted-foreground">
								AI answers from FlockStack&apos;s docs. Never share passwords or keys here.
							</p>
						</div>
						<div className="flex shrink-0 items-center gap-1">
							{conversation.length > 0 && (
								<Button type="button" variant="ghost" size="sm" onClick={() => update([])}>
									New chat
								</Button>
							)}
							<Button type="button" variant="ghost" size="icon-sm" onClick={close} aria-label="Close help">
								<X aria-hidden="true" />
							</Button>
						</div>
					</header>

					<div ref={logRef} role="log" aria-live="polite" aria-label="Conversation" className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 text-sm">
						{conversation.length === 0 && (
							<p className="text-pretty text-muted-foreground">Ask how something in FlockStack works: sending, domains, plans, imports, exports or the API.</p>
						)}
						{conversation.map((message, index) =>
							message.role === "user" ? (
								<p key={index} className="max-w-[85%] self-end rounded-lg bg-muted px-3 py-2 break-words whitespace-pre-wrap">
									<span className="sr-only">You: </span>
									{message.content}
								</p>
							) : (
								<div key={index} className="flex flex-col gap-2">
									<p className="text-[11px] font-medium text-muted-foreground">AI answer from FlockStack&apos;s docs</p>
									<p className="break-words whitespace-pre-wrap">{message.content}</p>
									{message.sources.length > 0 && (
										<div>
											<p className="text-[11px] font-medium text-muted-foreground">Sources</p>
											<ul className="mt-1 flex flex-col gap-1">
												{message.sources.map((source) => (
													<li key={source.href}>
														<a href={source.href} className="text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
															{source.title}
														</a>
													</li>
												))}
											</ul>
										</div>
									)}
								</div>
							)
						)}
						{isAsking && <p className="text-muted-foreground">Looking in the docs…</p>}
					</div>

					<div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3">
						{error && (
							<p role="alert" className="text-sm text-pretty text-destructive">
								{error}
							</p>
						)}
						<form onSubmit={ask} className="flex items-end gap-2">
							<label htmlFor={`${id}-question`} className="sr-only">
								Your question
							</label>
							<Textarea
								ref={inputRef}
								id={`${id}-question`}
								value={question}
								onChange={(event) => setQuestion(event.target.value)}
								onKeyDown={onQuestionKeyDown}
								maxLength={MAX_QUESTION_CHARS}
								rows={1}
								placeholder="Ask a question"
								className="max-h-32 min-h-10 resize-none"
							/>
							<Button type="submit" size="icon" disabled={isAsking || !question.trim()} aria-label="Send">
								<SendHorizontal aria-hidden="true" />
							</Button>
						</form>
						<div className="flex flex-col gap-1">
							{isSignedIn ? (
								<Button type="button" variant="outline" size="sm" className="self-start" disabled={!hasQuestion || handoff.status === "sending" || handoff.status === "sent"} onClick={sendToHuman}>
									Email a human
								</Button>
							) : (
								<Button asChild variant="outline" size="sm" className={cn("self-start", !hasQuestion && "pointer-events-none opacity-50")}>
									<a href={toMailtoHref({ address: supportEmail, messages: conversation })} aria-disabled={!hasQuestion || undefined} tabIndex={hasQuestion ? undefined : -1}>
										Email a human
									</a>
								</Button>
							)}
							<p className="text-xs text-pretty text-muted-foreground">
								{isSignedIn
									? "Sends this conversation and your account email to FlockStack support."
									: `Opens your email app with this conversation, to send to ${supportEmail}.`}
							</p>
							{handoff.message && (
								<p role={handoff.status === "failed" ? "alert" : "status"} className={cn("text-xs text-pretty", handoff.status === "failed" ? "text-destructive" : "text-foreground")}>
									{handoff.message}
								</p>
							)}
						</div>
					</div>
				</section>
			)}
		</div>
	);
}
