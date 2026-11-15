"use client";

import { useState, useTransition } from "react";
import { setApprovalStepUp, setTeamApprover } from "@/app/(app)/approvals/actions";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/toast";

// Who decides what agents ask, and how: the owner's code by email for sends and deletes, and the team members who may approve
// for chosen newsletters. Owner only; no key or app can change either.
export default function CardApprovalPeople({ stepUp, seats, newsletters }) {
	const [isStepUp, setIsStepUp] = useState(stepUp);
	const [approverFor, setApproverFor] = useState(() => Object.fromEntries(seats.map(({ id, approverFor }) => [id, approverFor])));
	const [, startTransition] = useTransition();

	function changeStepUp(required) {
		setIsStepUp(required);
		startTransition(async () => {
			const result = await setApprovalStepUp(required);
			if (result?.error) {
				setIsStepUp(!required);
				toast.error(result.error);
			} else toast.success(required ? "Approving a send or a delete takes a code" : "Approving takes your session only");
		});
	}

	function toggle(seatId, newsletterId, isOn) {
		const before = approverFor[seatId] ?? [];
		const next = isOn ? [...before, newsletterId] : before.filter((id) => id !== newsletterId);
		setApproverFor((current) => ({ ...current, [seatId]: next }));
		startTransition(async () => {
			const result = await setTeamApprover(seatId, next);
			if (result?.error) {
				setApproverFor((current) => ({ ...current, [seatId]: before }));
				toast.error(result.error);
			}
		});
	}

	return (
		<section className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-border animate-enter sm:p-5">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 className="font-semibold tracking-tight">Code by email to approve</h2>
					<p className="mt-1 max-w-xl text-sm text-pretty text-muted-foreground">
						Approving a send or a delete also takes a code we email to whoever approves. Rejecting never does.
					</p>
				</div>
				<Switch aria-label="Code by email to approve" checked={isStepUp} onCheckedChange={changeStepUp} />
			</div>

			{seats.length > 0 && (
				<div className="flex flex-col gap-2 border-t border-border/60 pt-4">
					<h2 className="font-semibold tracking-tight">Team approvers</h2>
					<p className="max-w-xl text-sm text-pretty text-muted-foreground">
						A team member you tick here can approve or reject what agents ask for that newsletter, whatever their role. Billing changes and these settings stay
						yours.
					</p>
					<ul className="divide-y divide-border/60">
						{seats.map(({ id, email, role }) => (
							<li key={id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
								<span className="min-w-0 truncate text-sm">
									{email} <span className="text-muted-foreground">· {role}</span>
								</span>
								<span className="flex flex-wrap gap-x-4 gap-y-1.5">
									{newsletters.map(({ id: newsletterId, name }) => (
										<label key={newsletterId} className="flex items-center gap-2 text-sm">
											<input
												type="checkbox"
												checked={(approverFor[id] ?? []).includes(newsletterId)}
												onChange={(event) => toggle(id, newsletterId, event.target.checked)}
												className="size-4 accent-foreground"
											/>
											{name}
										</label>
									))}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
