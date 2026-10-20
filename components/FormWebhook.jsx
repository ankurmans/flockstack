"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { deleteWebhookEndpoint, rotateWebhookSecret, sendTestWebhook, updateWebhookEndpoint } from "@/app/(app)/webhooks/actions";
import BarSave from "@/components/BarSave";
import ButtonCopy from "@/components/ButtonCopy";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import ListEventChoices from "@/components/ListEventChoices";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

const ALL_NEWSLETTERS = "all";

function toDraft({ url, description, events, newsletterId, enabled }) {
	return { url, description, events, newsletterId: newsletterId ?? ALL_NEWSLETTERS, enabled };
}

// An endpoint's settings, its secret and the buttons that act on it at once: send a test event, rotate, delete.
export default function FormWebhook({ endpoint, events, newsletters }) {
	const router = useRouter();
	const toastError = useToastError();
	const [draft, setDraft] = useState(() => toDraft(endpoint));
	const [saved, setSaved] = useState(() => JSON.stringify(toDraft(endpoint)));
	const [savedAt, setSavedAt] = useState(null);
	const [secret, setSecret] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const [pending, setPending] = useState(null);
	const [, startAction] = useTransition();
	const isDirty = JSON.stringify(draft) !== saved;
	const isEveryEvent = draft.events.length === 0;

	function set(patch) {
		setDraft((current) => ({ ...current, ...patch }));
	}

	function save(event) {
		event.preventDefault();
		startSaving(async () => {
			const result = await updateWebhookEndpoint(endpoint.id, { ...draft, newsletterId: draft.newsletterId === ALL_NEWSLETTERS ? null : draft.newsletterId });
			if (result?.error) return void toastError(result);
			const next = toDraft(result.endpoint);
			setDraft(next);
			setSaved(JSON.stringify(next));
			setSavedAt(result.savedAt);
		});
	}

	function discard() {
		setDraft(JSON.parse(saved));
		setSavedAt(null);
	}

	function run(name, work) {
		setPending(name);
		startAction(async () => {
			await work();
			setPending(null);
		});
	}

	function sendTest() {
		run("test", async () => {
			const result = await sendTestWebhook(endpoint.id);
			if (result?.error) return void toastError(result);
			toast.success("Test event sent. Its result shows in the log below in a few seconds.");
			setTimeout(() => router.refresh(), 4000);
		});
	}

	function rotate() {
		if (!window.confirm("Make a new signing secret? For 24 hours events are signed with both, so you can switch your server over.")) return;
		run("rotate", async () => {
			const result = await rotateWebhookSecret(endpoint.id);
			if (result?.error) return void toastError(result);
			setSecret(result.secret);
		});
	}

	function remove() {
		if (!window.confirm(`Delete the webhook to ${endpoint.url}? Nothing is sent to it from now on, retries included.`)) return;
		run("delete", async () => {
			const result = await deleteWebhookEndpoint(endpoint.id);
			if (result?.error) return void toastError(result);
			toast.success("Webhook deleted");
			router.push("/webhooks");
		});
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			{endpoint.disabledReason && !endpoint.enabled && (
				<p role="status" className="rounded-xl bg-card px-4 py-3 text-sm text-pretty text-amber-700 shadow-border dark:text-amber-400">
					FlockStack turned this endpoint off: {endpoint.disabledReason}. Fix it, send a test event, then turn it back on. Resend the events you
					need from the log below.
				</p>
			)}
			<CardSettings title="Endpoint" stagger={1} action={<Switch checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Send events to this endpoint" />}>
				<RowSettings label="Address" isLabel>
					<Input type="url" value={draft.url} onChange={(event) => set({ url: event.target.value })} required maxLength={2000} className="font-mono text-[13px]" />
				</RowSettings>
				<RowSettings label="Description" isLabel>
					<Input value={draft.description} onChange={(event) => set({ description: event.target.value })} maxLength={200} placeholder="What it's for" />
				</RowSettings>
				{newsletters.length > 1 && (
					<RowSettings label="Newsletter">
						<Select value={draft.newsletterId} onValueChange={(newsletterId) => set({ newsletterId })}>
							<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Newsletter">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL_NEWSLETTERS}>Every newsletter</SelectItem>
								{newsletters.map(({ id, name }) => (
									<SelectItem key={id} value={id}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</RowSettings>
				)}
				<RowSettings label="Events">
					<span className="flex items-center gap-2 pt-1.5 text-sm">
						<Switch
							checked={isEveryEvent}
							onCheckedChange={(on) => set({ events: on ? [] : events.map(({ type }) => type) })}
							aria-label="Every event"
						/>
						Every event, new ones included
					</span>
					{!isEveryEvent && <ListEventChoices events={events} selected={draft.events} onChange={(chosen) => set({ events: chosen })} />}
				</RowSettings>
			</CardSettings>

			<CardSettings title="Signing secret" stagger={2}>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Each event carries webhook-id, webhook-timestamp and webhook-signature headers, as in Standard Webhooks. Check them with the secret
					before you trust an event.
				</p>
				{secret && (
					<div className="flex flex-col gap-2 px-4 py-3">
						<span className="text-sm">The new secret, shown once:</span>
						<div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3">
							<code className="min-w-0 flex-1 truncate font-mono text-[13px]">{secret}</code>
							<ButtonCopy value={secret} label="Copy secret" />
						</div>
					</div>
				)}
				<div className="flex flex-wrap gap-2 px-4 py-3">
					<Button type="button" variant="outline" onClick={sendTest} disabled={pending !== null}>
						{pending === "test" ? <Loader2 className="animate-spin" /> : "Send a test event"}
					</Button>
					<Button type="button" variant="outline" onClick={rotate} disabled={pending !== null}>
						{pending === "rotate" ? <Loader2 className="animate-spin" /> : "Rotate secret"}
					</Button>
					<Button type="button" variant="ghost" onClick={remove} disabled={pending !== null} className="text-muted-foreground hover:text-destructive sm:ml-auto">
						{pending === "delete" ? <Loader2 className="animate-spin" /> : "Delete"}
					</Button>
				</div>
			</CardSettings>
			<BarSave isDirty={isDirty} isSaving={isSaving} savedAt={savedAt} onDiscard={discard} />
		</form>
	);
}
