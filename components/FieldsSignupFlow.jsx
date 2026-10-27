"use client";

import { Button } from "@/components/ui/button";
import { SIGNUP_FLOW_TYPES } from "@/lib/signup-flow-rules";

const LABELS = { survey: "Survey", upsell: "Paid-subscription offer", recommendations: "Recommendations" };

export default function FieldsSignupFlow({ value = [], onChange, surveys = [] }) {
	function move(index, offset) {
		const next = [...value];
		[next[index], next[index + offset]] = [next[index + offset], next[index]];
		onChange(next);
	}
	return <div className="flex flex-col gap-3 p-4">
		<p className="text-sm text-muted-foreground">Optional steps after this form’s signup, in order. Your redirect opens after the final step. A paid offer opens the plan picker; it never charges a reader itself. Recommendations need an active subscriber and their own choice.</p>
		{value.map((step, index) => <div key={step.type} className="flex flex-col gap-2 rounded-lg border p-3">
			<div className="flex flex-wrap items-center gap-2"><span className="mr-auto text-sm font-medium">{index + 1}. {LABELS[step.type]}</span>
				<Button type="button" size="sm" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${LABELS[step.type]} up`}>Up</Button>
				<Button type="button" size="sm" variant="ghost" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${LABELS[step.type]} down`}>Down</Button>
				<Button type="button" size="sm" variant="ghost" onClick={() => onChange(value.filter((_, i) => i !== index))} aria-label={`Remove ${LABELS[step.type]}`}>Remove</Button>
			</div>
			{step.type === "survey" && <label className="flex flex-col gap-1 text-sm">Survey
				<select value={step.surveyId ?? ""} onChange={(event) => onChange(value.map((s, i) => i === index ? { ...s, surveyId: event.target.value } : s))} className="rounded border bg-background p-2">
					<option value="">Choose an open survey</option>
					{step.surveyId && !surveys.some((s) => s.id === step.surveyId) && <option value={step.surveyId}>Saved survey (unavailable)</option>}
					{surveys.map((survey) => <option key={survey.id} value={survey.id}>{survey.title}</option>)}
				</select>
			</label>}
		</div>)}
		<div className="flex flex-wrap gap-2">{SIGNUP_FLOW_TYPES.filter((type) => !value.some((s) => s.type === type)).map((type) => <Button key={type} type="button" size="sm" variant="outline" onClick={() => onChange([...value, { type, ...(type === "survey" && { surveyId: "" }) }])}>Add {LABELS[type].toLowerCase()}</Button>)}</div>
	</div>;
}
