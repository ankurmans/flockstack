"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Download, Loader2, Plus, Trash2 } from "lucide-react";
import { createSurvey, deleteSurvey, exportSurveyResponses, updateSurvey } from "@/app/(app)/surveys/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FIELD_TYPES_FOR_QUESTION, QUESTION_TYPES, QUESTION_TYPE_LABELS, isChoice } from "@/lib/survey-rules";
import { toast } from "@/lib/toast";

const SELECT = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm";

function newQuestion() {
	return { type: "single_choice", label: "", options: "", required: false, fieldKey: "" };
}

function fromSurvey(survey) {
	return {
		title: survey?.title ?? "",
		intro: survey?.intro ?? "",
		thankYou: survey?.thankYou ?? "",
		afterSignup: Boolean(survey?.afterSignup),
		onUnsubscribe: Boolean(survey?.onUnsubscribe),
		closed: Boolean(survey?.closed),
		questions: survey?.questions?.length
			? survey.questions.map((question) => ({ ...question, options: (question.options ?? []).join("\n"), fieldKey: question.fieldKey ?? "" }))
			: [newQuestion()],
	};
}

// A survey's questions and where it's shown. fields: the newsletter's custom fields an answer can be saved to.
export default function FormSurvey({ newsletterId, survey, fields }) {
	const router = useRouter();
	const [draft, setDraft] = useState(() => fromSurvey(survey));
	const [isPending, startTransition] = useTransition();
	const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
	const setQuestion = (index, changes) => set("questions", draft.questions.map((question, at) => (at === index ? { ...question, ...changes } : question)));
	const move = (index, step) => {
		const questions = [...draft.questions];
		[questions[index], questions[index + step]] = [questions[index + step], questions[index]];
		set("questions", questions);
	};

	function save(event) {
		event.preventDefault();
		const values = {
			...draft,
			questions: draft.questions.map((question) => ({
				...question,
				options: isChoice(question.type) ? question.options.split("\n").map((option) => option.trim()).filter(Boolean) : [],
			})),
		};
		startTransition(async () => {
			const result = survey ? await updateSurvey(survey.id, values) : await createSurvey(newsletterId, values);
			if (result?.error) return void toast.error(result.error);
			toast.success("Survey saved");
			if (!survey) router.push(`/surveys/${result.id}`);
			else router.refresh();
		});
	}

	function download() {
		startTransition(async () => {
			const result = await exportSurveyResponses(survey.id);
			if (result?.error) return void toast.error(result.error);
			const link = document.createElement("a");
			link.href = URL.createObjectURL(new Blob([result.csv], { type: "text/csv" }));
			link.download = `survey-${survey.id}.csv`;
			link.click();
			URL.revokeObjectURL(link.href);
		});
	}

	function remove() {
		if (!window.confirm("Delete this survey and all its responses? It can't be undone.")) return;
		startTransition(async () => {
			const result = await deleteSurvey(survey.id);
			if (result?.error) return void toast.error(result.error);
			router.push("/surveys");
		});
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<CardSettings title="Survey">
				<RowSettings label="Title" isLabel>
					<Input value={draft.title} onChange={(event) => set("title", event.target.value)} maxLength={100} required />
				</RowSettings>
				<RowSettings label="Intro" isLabel>
					<Textarea value={draft.intro} onChange={(event) => set("intro", event.target.value)} maxLength={500} rows={2} />
				</RowSettings>
				<RowSettings label="Thank-you words" isLabel>
					<Input value={draft.thankYou} onChange={(event) => set("thankYou", event.target.value)} maxLength={300} placeholder="Thanks, your answers are in." />
				</RowSettings>
				<RowSettings label="Show it">
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={draft.afterSignup} onChange={(event) => set("afterSignup", event.target.checked)} className="size-4 accent-foreground" />
						Right after someone signs up on the website
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={draft.onUnsubscribe} onChange={(event) => set("onUnsubscribe", event.target.checked)} className="size-4 accent-foreground" />
						On the unsubscribe page, to ask why
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={draft.closed} onChange={(event) => set("closed", event.target.checked)} className="size-4 accent-foreground" />
						Closed: take no more answers
					</label>
				</RowSettings>
			</CardSettings>

			{draft.questions.map((question, index) => {
				const choices = fields.filter(({ type }) => FIELD_TYPES_FOR_QUESTION[question.type].includes(type));
				return (
					<CardSettings
						key={question.id ?? `new-${index}`}
						title={`Question ${index + 1}`}
						action={
							<span className="flex gap-1">
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
									<ArrowUp />
								</Button>
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Move down" disabled={index === draft.questions.length - 1} onClick={() => move(index, 1)}>
									<ArrowDown />
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={`Remove question ${index + 1}`}
									disabled={draft.questions.length === 1}
									onClick={() => set("questions", draft.questions.filter((_, at) => at !== index))}
									className="text-muted-foreground hover:text-destructive"
								>
									<Trash2 />
								</Button>
							</span>
						}
					>
						<RowSettings label="Question" isLabel>
							<Input value={question.label} onChange={(event) => setQuestion(index, { label: event.target.value })} maxLength={200} required />
						</RowSettings>
						<RowSettings label="Answer" isLabel>
							<select value={question.type} onChange={(event) => setQuestion(index, { type: event.target.value, fieldKey: "" })} className={SELECT}>
								{QUESTION_TYPES.map((type) => (
									<option key={type} value={type}>
										{QUESTION_TYPE_LABELS[type]}
									</option>
								))}
							</select>
						</RowSettings>
						{isChoice(question.type) && (
							<RowSettings label="Options" hint="One a line, 2 to 10" isLabel>
								<Textarea value={question.options} onChange={(event) => setQuestion(index, { options: event.target.value })} rows={3} />
							</RowSettings>
						)}
						<RowSettings label="Save to field" hint={choices.length === 0 ? "No custom field of the newsletter takes this kind of answer" : "Subscribers who answer from their own link"} isLabel>
							<select value={question.fieldKey} onChange={(event) => setQuestion(index, { fieldKey: event.target.value })} className={SELECT} disabled={choices.length === 0}>
								<option value="">No field</option>
								{choices.map(({ key, label }) => (
									<option key={key} value={key}>
										{label}
									</option>
								))}
							</select>
						</RowSettings>
						<RowSettings label="Required">
							<label className="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={question.required} onChange={(event) => setQuestion(index, { required: event.target.checked })} className="size-4 accent-foreground" />
								Readers have to answer it
							</label>
						</RowSettings>
					</CardSettings>
				);
			})}

			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" variant="outline" onClick={() => set("questions", [...draft.questions, newQuestion()])} disabled={draft.questions.length >= 20}>
					<Plus data-icon="inline-start" />
					Add a question
				</Button>
				<Button type="submit" disabled={isPending}>
					{isPending && <Loader2 className="animate-spin" />}
					Save
				</Button>
				{survey && (
					<>
						<Button type="button" variant="outline" onClick={download} disabled={isPending || survey.responses === 0}>
							<Download data-icon="inline-start" />
							Export CSV
						</Button>
						<Button type="button" variant="ghost" onClick={remove} disabled={isPending} className="ml-auto text-muted-foreground hover:text-destructive">
							Delete
						</Button>
					</>
				)}
			</div>
		</form>
	);
}
