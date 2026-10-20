"use client";

import { useActionState } from "react";
import { Check, Loader2 } from "lucide-react";
import { answerSurvey } from "@/app/survey/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// A survey's questions as a reader answers them. token: a subscriber's link, or null. source: page, signup or unsubscribe.
export default function FormSurveyResponse({ survey, token, source = "page", className }) {
	const [state, action, isPending] = useActionState(answerSurvey.bind(null, survey.id, token, source), null);

	if (state?.ok) {
		return (
			<p role="status" className={cn("flex items-center justify-center gap-2 text-sm font-medium text-foreground", className)}>
				<Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
				{state.thankYou}
			</p>
		);
	}

	return (
		<form action={action} className={cn("flex flex-col gap-5 text-left", className)}>
			{survey.questions.map((question) => (
				<Question key={question.id} question={question} />
			))}
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
			<Button type="submit" size="lg" disabled={isPending}>
				{isPending ? <Loader2 className="animate-spin" /> : "Send"}
			</Button>
		</form>
	);
}

const INPUT = "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring md:text-sm";

function Question({ question }) {
	const { id, type, label, options, required } = question;
	const title = (
		<legend className="mb-2 text-sm font-medium text-foreground">
			{label}
			{!required && <span className="font-normal text-muted-foreground"> (optional)</span>}
		</legend>
	);
	if (type === "short_text" || type === "long_text") {
		return (
			<label className="flex flex-col gap-2 text-sm font-medium text-foreground">
				<span>
					{label}
					{!required && <span className="font-normal text-muted-foreground"> (optional)</span>}
				</span>
				{type === "short_text" ? <input name={id} required={required} maxLength={200} className={INPUT} /> : <Textarea name={id} required={required} maxLength={2000} rows={4} />}
			</label>
		);
	}
	if (type === "rating" || type === "nps") {
		const scale = type === "rating" ? [1, 2, 3, 4, 5] : Array.from({ length: 11 }, (_, index) => index);
		return (
			<fieldset>
				{title}
				<div className="flex flex-wrap gap-1.5">
					{scale.map((value) => (
						<label key={value} className="relative">
							<input type="radio" name={id} value={value} required={required} className="peer sr-only" />
							<span className="grid size-9 cursor-pointer place-items-center rounded-lg text-sm tabular-nums shadow-border peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
								{value}
							</span>
						</label>
					))}
				</div>
				{type === "nps" && <p className="mt-1.5 flex justify-between text-xs text-muted-foreground"><span>Not likely</span><span>Very likely</span></p>}
			</fieldset>
		);
	}
	const choices = type === "yes_no" ? ["Yes", "No"] : options;
	const isMultiple = type === "multi_choice";
	return (
		<fieldset>
			{title}
			<div className="flex flex-col gap-1.5">
				{choices.map((option) => (
					<label key={option} className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm shadow-border has-checked:ring-2 has-checked:ring-ring">
						<input type={isMultiple ? "checkbox" : "radio"} name={id} value={option} required={required && !isMultiple} className="size-4 accent-foreground" />
						{option}
					</label>
				))}
			</div>
		</fieldset>
	);
}
