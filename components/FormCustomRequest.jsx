"use client";

import { useActionState, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { sendCustomRequest } from "@/app/(site)/custom/actions";
import { Button } from "@/components/ui/button";
import {
	CUSTOM_EMAIL_RANGES,
	CUSTOM_LIMITS,
	CUSTOM_NEEDS,
	CUSTOM_PLATFORMS,
	CUSTOM_REPLY_WITHIN,
	CUSTOM_SUBSCRIBER_RANGES,
	CUSTOM_TIMELINES,
} from "@/lib/custom-choices";

const FIELD =
	"h-11 w-full min-w-0 rounded-xl bg-background px-3.5 text-base shadow-border outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25";

// The Custom plan's request form (lib/custom-rules.js has the rules). Open to anyone, signed in or not.
export default function FormCustomRequest() {
	const [state, action, isPending] = useActionState(sendCustomRequest, null);
	const [hasOther, setHasOther] = useState(false);

	if (state?.ok) {
		return (
			<p role="status" className="flex items-start gap-3 rounded-2xl bg-card p-6 shadow-border animate-enter">
				<span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
					<Check className="size-3.5" />
				</span>
				<span>
					<span className="block font-medium">Thanks, we have it.</span>
					<span className="mt-1 block text-[15px] text-muted-foreground">
						A person on the FlockStack team will reply to you personally within {CUSTOM_REPLY_WITHIN}. We also sent you a short email.
					</span>
				</span>
			</p>
		);
	}

	return (
		<form action={action} className="flex flex-col gap-8">
			<div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
				<input type="text" name="fax" tabIndex={-1} autoComplete="off" />
			</div>

			<div className="grid gap-5 sm:grid-cols-2">
				<Field label="Your name" required>
					<input type="text" name="name" required maxLength={CUSTOM_LIMITS.name} autoComplete="name" className={FIELD} />
				</Field>
				<Field label="Work email" required>
					<input type="email" name="email" required maxLength={254} autoComplete="email" className={FIELD} />
				</Field>
				<Field label="Newsletter or company" required>
					<input type="text" name="company" required maxLength={CUSTOM_LIMITS.company} autoComplete="organization" className={FIELD} />
				</Field>
				<Field label="Website">
					<input type="text" name="website" inputMode="url" placeholder="example.com" maxLength={CUSTOM_LIMITS.website} autoComplete="url" className={FIELD} />
				</Field>
				<Field label="Where you send from now">
					<Select name="platform" choices={CUSTOM_PLATFORMS} />
				</Field>
				<Field label="When you want to move">
					<Select name="timeline" choices={CUSTOM_TIMELINES} />
				</Field>
				<Field label="Subscribers">
					<Select name="subscribers" choices={CUSTOM_SUBSCRIBER_RANGES} />
				</Field>
				<Field label="Emails a month">
					<Select name="emailsPerMonth" choices={CUSTOM_EMAIL_RANGES} />
				</Field>
			</div>

			<fieldset>
				<legend className="text-sm font-medium">What would you need?</legend>
				<p className="mt-1 text-sm text-muted-foreground">Tick everything that matters to you. It tells us what to build first, and it promises nothing.</p>
				<div className="mt-4 grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
					{CUSTOM_NEEDS.map(({ id, label }) => (
						<label key={id} className="flex items-center gap-2.5 text-[15px]">
							<input
								type="checkbox"
								name="needs"
								value={id}
								onChange={id === "other" ? (event) => setHasOther(event.target.checked) : undefined}
								className="size-4 shrink-0 rounded accent-primary"
							/>
							{label}
						</label>
					))}
				</div>
				{hasOther && (
					<input
						type="text"
						name="otherNeed"
						aria-label="What else would you need?"
						placeholder="What else would you need?"
						maxLength={CUSTOM_LIMITS.otherNeed}
						className={`${FIELD} mt-4`}
					/>
				)}
			</fieldset>

			<Field label="Anything else we should know?">
				<textarea name="message" rows={4} maxLength={CUSTOM_LIMITS.message} className={`${FIELD} h-auto min-h-28 py-3`} />
			</Field>

			<div>
				<Button type="submit" size="lg" disabled={isPending} className="h-11 min-w-48 text-[15px]">
					{isPending ? <Loader2 className="animate-spin" /> : "Send"}
				</Button>
				{state?.error && (
					<p role="alert" className="mt-3 text-sm text-destructive">
						{state.error}
					</p>
				)}
			</div>
		</form>
	);
}

function Field({ label, required, children }) {
	return (
		<label className="flex flex-col gap-1.5 text-sm">
			<span className="font-medium">
				{label}
				{!required && <span className="font-normal text-muted-foreground"> (optional)</span>}
			</span>
			{children}
		</label>
	);
}

function Select({ name, choices }) {
	return (
		<select name={name} defaultValue="" className={FIELD}>
			<option value="">Choose one</option>
			{choices.map(({ id, label }) => (
				<option key={id} value={id}>
					{label}
				</option>
			))}
		</select>
	);
}
