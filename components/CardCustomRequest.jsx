"use client";

import { useActionState, useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { removeCustomRequest, saveCustomRequest } from "@/app/admin/actions";
import BadgeStatus from "@/components/BadgeStatus";
import StatusSaved from "@/components/StatusSaved";
import TimeLocal from "@/components/TimeLocal";
import { Button } from "@/components/ui/button";
import {
	CUSTOM_EMAIL_RANGES,
	CUSTOM_LIMITS,
	CUSTOM_NEEDS,
	CUSTOM_PLATFORMS,
	CUSTOM_STATUSES,
	CUSTOM_SUBSCRIBER_RANGES,
	CUSTOM_TIMELINES,
	choiceLabel,
} from "@/lib/custom-choices";
import { REGION_NAMES } from "@/lib/region";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { toast } from "@/lib/toast";

// One Custom plan request for the admins: who and what they asked, and its status and notes to change.
export default function CardCustomRequest({ request }) {
	const [state, action, isSaving] = useActionState(saveCustomRequest, null);
	const [isRemoving, startRemoving] = useTransition();
	const facts = [
		["Sends from", choiceLabel(CUSTOM_PLATFORMS, request.platform)],
		["Subscribers", choiceLabel(CUSTOM_SUBSCRIBER_RANGES, request.subscribers)],
		["Emails a month", choiceLabel(CUSTOM_EMAIL_RANGES, request.emailsPerMonth)],
		["Timeline", choiceLabel(CUSTOM_TIMELINES, request.timeline)],
	];

	function remove() {
		if (!window.confirm(`Delete the request from ${request.company}? This can't be undone.`)) return;
		startRemoving(async () => {
			const answer = await removeCustomRequest(request._id);
			if (answer?.error) toast.error(answer.error);
		});
	}

	return (
		<article data-request={request._id} className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-border sm:p-5">
			<header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
				<div className="min-w-0">
					<h3 className="truncate font-semibold">{request.company}</h3>
					<p className="truncate text-sm text-muted-foreground">
						{request.name} ·{" "}
						<a href={`mailto:${request.email}`} className="text-link underline underline-offset-4">
							{request.email}
						</a>
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<BadgeStatus status={request.status} />
					<span>{REGION_NAMES[request.region] ?? request.region}</span>
					<TimeLocal value={request.createdAt} options={{ dateStyle: "medium", timeStyle: "short" }} />
				</div>
			</header>

			<dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
				{facts.map(([label, value]) => (
					<div key={label} className="flex gap-2">
						<dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
						<dd>{value ?? <span className="text-muted-foreground">Not said</span>}</dd>
					</div>
				))}
				{request.website && (
					<div className="flex gap-2 sm:col-span-2">
						<dt className="w-28 shrink-0 text-muted-foreground">Website</dt>
						<dd className="min-w-0 truncate">
							<a href={request.website} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline underline-offset-4">
								{request.website}
							</a>
						</dd>
					</div>
				)}
			</dl>

			<div>
				<p className="text-sm text-muted-foreground">Would need</p>
				{request.needs.length > 0 ? (
					<ul className="mt-1.5 flex flex-wrap gap-1.5">
						{request.needs.map((id) => (
							<li key={id} className="rounded-full bg-muted px-2.5 py-0.5 text-xs">
								{choiceLabel(CUSTOM_NEEDS, id)}
							</li>
						))}
					</ul>
				) : (
					<p className="mt-1 text-sm">Nothing ticked</p>
				)}
				{request.otherNeed && <p className="mt-2 text-sm whitespace-pre-wrap">Other: {request.otherNeed}</p>}
			</div>

			{request.message && <p className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">{request.message}</p>}

			<form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-3 border-t border-border/60 pt-4">
				<input type="hidden" name="id" value={request._id} />
				<div className="flex flex-wrap items-center gap-3">
					<label className="flex items-center gap-2 text-sm">
						Status
						<select
							name="status"
							defaultValue={request.status}
							className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
						>
							{CUSTOM_STATUSES.map(({ id, label }) => (
								<option key={id} value={id}>
									{label}
								</option>
							))}
						</select>
					</label>
				</div>
				<textarea
					name="notes"
					defaultValue={request.notes ?? ""}
					rows={3}
					maxLength={CUSTOM_LIMITS.notes}
					aria-label="Notes"
					placeholder="Notes: what you said, what they need, what's next"
					className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
				/>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-3">
						<Button type="submit" size="sm" disabled={isSaving}>
							{isSaving && <Loader2 className="animate-spin" data-icon="inline-start" />}
							Save
						</Button>
						<StatusSaved savedAt={state?.savedAt} />
						{state?.error && (
							<span role="alert" className="text-sm text-destructive">
								{state.error}
							</span>
						)}
					</div>
					<Button type="button" variant="ghost" size="sm" onClick={remove} disabled={isRemoving} className="text-muted-foreground">
						{isRemoving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
						Delete
					</Button>
				</div>
			</form>
		</article>
	);
}
