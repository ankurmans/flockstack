"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Play, Plus, X } from "lucide-react";
import { createBriefing, deleteBriefing, runBriefingNow, updateBriefing } from "@/app/(app)/briefings/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { useIsClient } from "@/lib/use-is-client";

const SELECT = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STEPS = [
	["triage", "Triage", "Scores each story for your audience"],
	["extract", "Extract", "Reads each picked page into facts and quotes"],
	["write", "Write", "Writes the issue from those facts"],
	["check", "Check", "Checks each claim against its source: another model than Write"],
];
const KINDS = [
	["feed", "Feed"],
	["page", "Listing page"],
	["url", "Single page"],
];

function fromBriefing(briefing, defaultTimeZone, defaultEmail) {
	return {
		name: briefing?.name ?? "",
		sources: briefing?.sources?.length ? briefing.sources : [{ kind: "feed", url: "", label: "" }],
		days: briefing?.schedule.days ?? [1, 2, 3, 4, 5],
		time: briefing?.schedule.time ?? "06:00",
		timeZone: briefing?.schedule.timeZone ?? defaultTimeZone,
		audience: briefing?.audience ?? "",
		styleGuide: briefing?.styleGuide ?? "",
		languages: briefing?.languages ?? ["en"],
		maxStories: briefing?.maxStories ?? 6,
		minScore: briefing?.minScore ?? 60,
		budgetUsd: briefing?.budgetUsd ?? 0.25,
		steps: Object.fromEntries(STEPS.map(([step]) => [step, { keyId: briefing?.steps[step]?.keyId ?? "", model: briefing?.steps[step]?.model ?? "" }])),
		testEmail: briefing?.testEmail ?? defaultEmail ?? "",
		active: briefing?.status === "active",
	};
}

// A briefing's sources, schedule, audience, style and steps. briefing null: a new one for newsletterId. keys: the account's AI keys
// (list_ai_keys), never the keys themselves. languages: the codes readers can read in.
export default function FormBriefing({ newsletterId, briefing, keys, languages, defaultTimeZone = "UTC", defaultEmail = "" }) {
	const router = useRouter();
	const [draft, setDraft] = useState(() => fromBriefing(briefing, defaultTimeZone, defaultEmail));
	const [isPending, startTransition] = useTransition();
	const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
	const setSource = (index, change) => set("sources", draft.sources.map((source, at) => (at === index ? { ...source, ...change } : source)));
	const setStep = (step, change) => set("steps", { ...draft.steps, [step]: { ...draft.steps[step], ...change } });
	const zones = useIsClient() ? getTimeZones(draft.timeZone) : [draft.timeZone];
	const names = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "language" }) : null;
	const [writtenIn, ...offered] = draft.languages;

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = briefing ? await updateBriefing(briefing.id, draft) : await createBriefing(newsletterId, draft);
			if (result?.error) return void toast.error(result.error);
			toast.success("Briefing saved");
			if (!briefing) router.push(`/briefings/${result.id}`);
			else router.refresh();
		});
	}

	function runNow() {
		startTransition(async () => {
			const result = await runBriefingNow(briefing.id);
			if (result?.error) return void toast.error(result.error);
			toast.success("A run is on its way: its draft shows in Campaigns when it is done");
			router.refresh();
		});
	}

	function remove() {
		if (!window.confirm("Delete this briefing and its run history? The issues it made stay.")) return;
		startTransition(async () => {
			const result = await deleteBriefing(briefing.id);
			if (result?.error) return void toast.error(result.error);
			router.push("/briefings");
		});
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<CardSettings title="Sources">
				<RowSettings label="Name" isLabel>
					<Input value={draft.name} onChange={(event) => set("name", event.target.value)} maxLength={100} required />
				</RowSettings>
				<RowSettings label="Reads" hint="Feeds, listing pages whose new links are the stories, or single pages checked for change. https only.">
					{draft.sources.map((source, index) => (
						<span key={source.id ?? index} className="flex flex-wrap gap-2">
							<select value={source.kind} onChange={(event) => setSource(index, { kind: event.target.value })} className={SELECT} aria-label="Kind">
								{KINDS.map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
							<Input value={source.url} onChange={(event) => setSource(index, { url: event.target.value })} placeholder="https://example.com/feed.xml" maxLength={1000} inputMode="url" aria-label="Address" className="min-w-0 flex-1" />
							<Button type="button" variant="ghost" size="icon" aria-label="Remove" onClick={() => set("sources", draft.sources.filter((_, at) => at !== index))}>
								<X />
							</Button>
						</span>
					))}
					<Button type="button" variant="outline" size="sm" className="self-start" onClick={() => set("sources", [...draft.sources, { kind: "feed", url: "", label: "" }])}>
						<Plus data-icon="inline-start" />
						Add a source
					</Button>
				</RowSettings>
			</CardSettings>

			<CardSettings title="Schedule">
				<RowSettings label="On">
					<span className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
						{WEEKDAYS.map((name, index) => (
							<label key={name} className="flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={draft.days.includes(index + 1)}
									onChange={(event) => set("days", event.target.checked ? [...draft.days, index + 1] : draft.days.filter((day) => day !== index + 1))}
									className="size-4 accent-foreground"
								/>
								{name}
							</label>
						))}
					</span>
				</RowSettings>
				<RowSettings label="At" isLabel>
					<span className="flex gap-2">
						<Input type="time" value={draft.time} onChange={(event) => set("time", event.target.value)} className="w-32" aria-label="Time" required />
						<select value={draft.timeZone} onChange={(event) => set("timeZone", event.target.value)} className={`${SELECT} min-w-0 flex-1`} aria-label="Time zone">
							{zones.map((zone) => (
								<option key={zone} value={zone}>
									{zone}
								</option>
							))}
						</select>
					</span>
				</RowSettings>
				<RowSettings label="Status">
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={draft.active} onChange={(event) => set("active", event.target.checked)} className="size-4 accent-foreground" />
						On: make a draft at each run
					</label>
				</RowSettings>
			</CardSettings>

			<CardSettings title="Issue">
				<RowSettings label="Audience" hint="Who reads it and what they care about. Stories are scored against this." isLabel>
					<Textarea value={draft.audience} onChange={(event) => set("audience", event.target.value)} rows={3} maxLength={2000} />
				</RowSettings>
				<RowSettings label="Style guide" hint="Voice, length, structure, words to avoid." isLabel>
					<Textarea value={draft.styleGuide} onChange={(event) => set("styleGuide", event.target.value)} rows={5} maxLength={8000} />
				</RowSettings>
				<RowSettings label="Written in" isLabel>
					<select value={writtenIn} onChange={(event) => set("languages", [event.target.value, ...offered.filter((code) => code !== event.target.value)])} className={SELECT}>
						{languages.map((code) => (
							<option key={code} value={code}>
								{names?.of(code) ?? code}
							</option>
						))}
					</select>
				</RowSettings>
				<RowSettings label="Also offered in" hint="Readers can read the issue in these through reader translation (beta).">
					<span className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
						{languages
							.filter((code) => code !== writtenIn)
							.map((code) => (
								<label key={code} className="flex items-center gap-1.5">
									<input
										type="checkbox"
										checked={offered.includes(code)}
										onChange={(event) => set("languages", [writtenIn, ...(event.target.checked ? [...offered, code] : offered.filter((other) => other !== code))])}
										className="size-4 accent-foreground"
									/>
									{names?.of(code) ?? code}
								</label>
							))}
					</span>
				</RowSettings>
				<RowSettings label="Stories" hint="At most this many, each scoring at least the minimum (0 to 100)">
					<span className="flex gap-2">
						<Input type="number" min={1} max={15} value={draft.maxStories} onChange={(event) => set("maxStories", event.target.value)} className="w-24" aria-label="Most stories" />
						<Input type="number" min={0} max={100} value={draft.minScore} onChange={(event) => set("minScore", event.target.value)} className="w-24" aria-label="Minimum score" />
					</span>
				</RowSettings>
				<RowSettings label="Test email" hint="Each run's draft is sent here, with its checks and cost: you or a team member." isLabel>
					<Input type="email" value={draft.testEmail} onChange={(event) => set("testEmail", event.target.value)} maxLength={254} />
				</RowSettings>
				<RowSettings label="Review">
					<span className="text-sm">Each issue waits as a draft for you to review. Nothing is sent by itself.</span>
				</RowSettings>
			</CardSettings>

			<CardSettings title="AI steps">
				{keys.length === 0 ? (
					<p className="px-4 py-3 text-sm text-muted-foreground">
						Add your own AI key first, on{" "}
						<Link href="/ai-keys" className="underline">
							AI keys
						</Link>
						: the model cost is yours, within the budget below.
					</p>
				) : (
					STEPS.map(([step, label, hint]) => (
						<RowSettings key={step} label={label} hint={hint}>
							<span className="flex flex-wrap gap-2">
								<select value={draft.steps[step].keyId} onChange={(event) => setStep(step, { keyId: event.target.value })} className={`${SELECT} min-w-0`} aria-label={`${label} key`}>
									<option value="">No key yet</option>
									{keys.map((key) => (
										<option key={key.id} value={key.id}>
											{key.name} ({key.providerLabel}, …{key.hint})
										</option>
									))}
								</select>
								<Input value={draft.steps[step].model} onChange={(event) => setStep(step, { model: event.target.value })} placeholder="Model name" maxLength={200} aria-label={`${label} model`} className="min-w-0 flex-1" />
							</span>
						</RowSettings>
					))
				)}
				<RowSettings label="Budget" hint="The most one run may spend on model calls, in USD (20 at most). A call that would pass it isn't made." isLabel>
					<Input type="number" min={0.01} max={20} step={0.01} value={draft.budgetUsd} onChange={(event) => set("budgetUsd", event.target.value)} className="w-28" />
				</RowSettings>
			</CardSettings>

			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" disabled={isPending}>
					{isPending && <Loader2 className="animate-spin" />}
					Save
				</Button>
				{briefing && (
					<>
						<Button type="button" variant="outline" onClick={runNow} disabled={isPending}>
							<Play data-icon="inline-start" />
							Run now
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

// The browser's zones, with the briefing's own first when the list doesn't have it.
function getTimeZones(current) {
	const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
	return ["UTC", ...zones.filter((zone) => zone !== "UTC"), ...(current && current !== "UTC" && !zones.includes(current) ? [current] : [])];
}
