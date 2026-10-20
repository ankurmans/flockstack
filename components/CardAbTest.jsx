"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { setCampaignAbTest } from "@/app/(app)/campaigns/actions";
import CardSettings from "@/components/CardSettings";
import RowCampaign from "@/components/RowCampaign";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AB_TEST, VARIANT_LABELS } from "@/lib/ab-test-rules";
import { formatCount, formatNumber } from "@/lib/format";
import { useToastError } from "@/lib/use-toast-error";

const SAVE_DELAY_MS = 700;
const PERCENTS = [10, 20, 30, 50];
const WAITS = [
	{ value: 30, label: "30 minutes" },
	{ value: 60, label: "1 hour" },
	{ value: 120, label: "2 hours" },
	{ value: 240, label: "4 hours" },
	{ value: 480, label: "8 hours" },
	{ value: 1440, label: "24 hours" },
];

function fromCampaign(campaign) {
	const { abTest } = campaign;
	const others = (abTest?.variants ?? []).slice(1);
	return {
		enabled: others.length > 0,
		subjects: others.length > 0 ? others.map(({ subject, previewText }) => ({ subject: subject ?? "", previewText: previewText ?? "" })) : [{ subject: "", previewText: "" }],
		testPercent: abTest?.testPercent ?? AB_TEST.percent.default,
		waitMinutes: abTest?.waitMinutes ?? AB_TEST.waitMinutes.default,
		metric: abTest?.metric ?? "clicks",
	};
}

// The send step's subject line test: more subjects tried on a slice of the audience, and the winner sent to the rest.
// It saves as it's edited, once every subject has words.
export default function CardAbTest({ campaign, subject, audienceCount, stagger = 0 }) {
	const router = useRouter();
	const toastError = useToastError();
	const [draft, setDraft] = useState(() => fromCampaign(campaign));
	const lastSaved = useRef(JSON.stringify(draft));

	useEffect(() => {
		const snapshot = JSON.stringify(draft);
		if (snapshot === lastSaved.current) return;
		if (draft.enabled && draft.subjects.some(({ subject: text }) => !text.trim())) return;
		const timeout = setTimeout(async () => {
			const { enabled, ...test } = draft;
			const result = await setCampaignAbTest(campaign._id, enabled ? test : null);
			if (result?.error) return toastError(result);
			lastSaved.current = snapshot;
			router.refresh();
		}, SAVE_DELAY_MS);
		return () => clearTimeout(timeout);
	}, [draft, campaign._id, router, toastError]);

	const set = (changes) => setDraft((current) => ({ ...current, ...changes }));
	const setSubject = (index, changes) =>
		set({ subjects: draft.subjects.map((variant, at) => (at === index ? { ...variant, ...changes } : variant)) });
	const testSize = Math.min(audienceCount, Math.max(draft.subjects.length + 1, Math.ceil((audienceCount * draft.testPercent) / 100)));

	return (
		<CardSettings
			title="Subject line test"
			stagger={stagger}
			action={<Switch checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Subject line test" />}
		>
			{draft.enabled && (
				<>
					<RowCampaign label="A">
						<span className="truncate text-sm">{subject || "The subject you wrote"}</span>
					</RowCampaign>
					{draft.subjects.map((variant, index) => (
						<div key={index} className="flex flex-col">
							<RowCampaign label={VARIANT_LABELS[index + 1]}>
								<span className="flex min-w-0 items-center gap-2">
									<input
										value={variant.subject}
										onChange={(event) => setSubject(index, { subject: event.target.value })}
										placeholder="Another subject"
										aria-label={`Subject ${VARIANT_LABELS[index + 1]}`}
										maxLength={200}
										className="h-11 w-full min-w-0 bg-transparent text-sm font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground"
									/>
									{draft.subjects.length > 1 && (
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Remove subject ${VARIANT_LABELS[index + 1]}`}
											onClick={() => set({ subjects: draft.subjects.filter((_, at) => at !== index) })}
										>
											<X />
										</Button>
									)}
								</span>
							</RowCampaign>
							<RowCampaign label="Preview text" className="border-t border-border/60">
								<input
									value={variant.previewText}
									onChange={(event) => setSubject(index, { previewText: event.target.value })}
									placeholder="The campaign's own"
									aria-label={`Preview text ${VARIANT_LABELS[index + 1]}`}
									maxLength={300}
									className="h-11 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
								/>
							</RowCampaign>
						</div>
					))}
					{draft.subjects.length < AB_TEST.maxVariants - 1 && (
						<div className="px-2 py-1.5">
							<Button variant="ghost" size="sm" onClick={() => set({ subjects: [...draft.subjects, { subject: "", previewText: "" }] })}>
								<Plus data-icon="inline-start" />
								Add a subject
							</Button>
						</div>
					)}
					<RowCampaign label="Test on">
						<SelectNumber value={draft.testPercent} onChange={(testPercent) => set({ testPercent })} label="Test on" options={PERCENTS.map((value) => ({ value, label: `${value}% of the audience` }))} />
					</RowCampaign>
					<RowCampaign label="Wait">
						<SelectNumber value={draft.waitMinutes} onChange={(waitMinutes) => set({ waitMinutes })} label="Wait" options={WAITS} />
					</RowCampaign>
					<RowCampaign label="Winner by">
						<Select value={draft.metric} onValueChange={(metric) => set({ metric })}>
							<SelectTrigger className="my-1.5 h-9 w-full sm:w-64" aria-label="Winner by">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="clicks">Unique clicks</SelectItem>
								<SelectItem value="opens">Opens</SelectItem>
							</SelectContent>
						</Select>
					</RowCampaign>
					<p className="px-4 py-3 text-sm text-pretty text-muted-foreground tabular-nums">
						{formatCount(testSize, "contact")}, the most engaged first, get one subject each in turn. After the wait, the winner goes to
						the other {formatNumber(Math.max(0, audienceCount - testSize))}.
						{draft.metric === "opens" && " Apple Mail opens every email it receives, so clicks say more."}
					</p>
				</>
			)}
		</CardSettings>
	);
}

function SelectNumber({ value, onChange, label, options }) {
	const known = options.some((option) => option.value === value) ? options : [...options, { value, label: String(value) }];
	return (
		<Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
			<SelectTrigger className="my-1.5 h-9 w-full sm:w-64" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{known.map((option) => (
					<SelectItem key={option.value} value={String(option.value)}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
