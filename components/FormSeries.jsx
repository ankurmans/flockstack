"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { previewFeed } from "@/app/(app)/campaigns/actions";
import { createSeries, deleteSeries, runSeriesNow, updateSeries } from "@/app/(app)/series/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { richToText, textToRich } from "@/lib/rich-text";
import { toast } from "@/lib/toast";
import { useIsClient } from "@/lib/use-is-client";

const SELECT = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function fromSeries(series, defaultTimeZone) {
	return {
		name: series?.name ?? "",
		feedUrl: series?.feedUrl ?? "",
		frequency: series?.schedule.frequency ?? "weekly",
		days: series?.schedule.days?.length ? series.schedule.days : [1],
		dayOfMonth: series?.schedule.dayOfMonth ?? 1,
		hour: series?.schedule.hour ?? 8,
		timeZone: series?.schedule.timeZone ?? defaultTimeZone,
		mode: series?.mode ?? "draft",
		subject: series?.subject ?? "{{first_title}}",
		previewText: series?.previewText ?? "",
		count: series?.count ?? 3,
		order: series?.order ?? "newest",
		image: series?.image ?? true,
		excerpt: series?.excerpt ?? true,
		date: series?.date ?? true,
		intro: richToText(series?.intro),
		active: series?.active ?? false,
	};
}

// A series' feed, schedule and issue. series null: a new one for newsletterId.
export default function FormSeries({ newsletterId, series, defaultTimeZone = "UTC" }) {
	const router = useRouter();
	const [draft, setDraft] = useState(() => fromSeries(series, defaultTimeZone));
	const [feed, setFeed] = useState(null);
	const [isPending, startTransition] = useTransition();
	const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
	// The browser's list of zones differs from the server's, so it shows after the page loads.
	const zones = useIsClient() ? getTimeZones(draft.timeZone) : [draft.timeZone];

	function save(event) {
		event.preventDefault();
		const values = { ...draft, intro: textToRich(draft.intro) };
		startTransition(async () => {
			const result = series ? await updateSeries(series.id, values) : await createSeries(newsletterId, values);
			if (result?.error) return void toast.error(result.error);
			toast.success("Series saved");
			if (!series) router.push(`/series/${result.id}`);
			else router.refresh();
		});
	}

	function checkFeed() {
		setFeed(null);
		startTransition(async () => setFeed(await previewFeed(draft.feedUrl, { count: draft.count, order: draft.order })));
	}

	function runNow() {
		startTransition(async () => {
			const result = await runSeriesNow(series.id);
			if (result?.error) return void toast.error(result.error);
			toast.success(result.run.status === "skipped" ? (result.run.reason ?? "Nothing new") : "A draft is ready in Campaigns");
			router.refresh();
		});
	}

	function remove() {
		if (!window.confirm("Delete this series and its history? The issues it made stay.")) return;
		startTransition(async () => {
			const result = await deleteSeries(series.id);
			if (result?.error) return void toast.error(result.error);
			router.push("/series");
		});
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<CardSettings title="Feed">
				<RowSettings label="Name" isLabel>
					<Input value={draft.name} onChange={(event) => set("name", event.target.value)} maxLength={100} required />
				</RowSettings>
				<RowSettings label="Feed address" hint="An RSS or Atom feed, read over https. Check it to see what it has now." isLabel>
					<Input value={draft.feedUrl} onChange={(event) => set("feedUrl", event.target.value)} placeholder="https://example.com/feed.xml" maxLength={1000} inputMode="url" required />
					<span className="flex flex-col gap-2">
						<Button type="button" variant="outline" size="sm" className="self-start" onClick={checkFeed} disabled={isPending || !draft.feedUrl}>
							Check the feed
						</Button>
						{feed?.error && (
							<span role="alert" className="text-sm text-destructive">
								{feed.error}
							</span>
						)}
						{feed?.items && (
							<span className="flex flex-col gap-1 text-sm text-muted-foreground">
								{feed.items.length === 0 ? "The feed has no items yet." : feed.items.map((item) => <span key={`${item.link}${item.title}`} className="truncate">{item.title}</span>)}
							</span>
						)}
					</span>
				</RowSettings>
			</CardSettings>

			<CardSettings title="Schedule">
				<RowSettings label="Repeat" isLabel>
					<select value={draft.frequency} onChange={(event) => set("frequency", event.target.value)} className={SELECT}>
						<option value="daily">Every day</option>
						<option value="weekly">Every week</option>
						<option value="monthly">Every month</option>
					</select>
				</RowSettings>
				{draft.frequency === "weekly" && (
					<RowSettings label="On">
						<span className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
							{WEEKDAYS.map((name, day) => (
								<label key={name} className="flex items-center gap-1.5">
									<input
										type="checkbox"
										checked={draft.days.includes(day)}
										onChange={(event) => set("days", event.target.checked ? [...draft.days, day] : draft.days.filter((other) => other !== day))}
										className="size-4 accent-foreground"
									/>
									{name}
								</label>
							))}
						</span>
					</RowSettings>
				)}
				{draft.frequency === "monthly" && (
					<RowSettings label="On day" hint="Up to the 28th, which every month has" isLabel>
						<select value={draft.dayOfMonth} onChange={(event) => set("dayOfMonth", Number(event.target.value))} className={SELECT}>
							{Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
								<option key={day} value={day}>
									{day}
								</option>
							))}
						</select>
					</RowSettings>
				)}
				<RowSettings label="At" isLabel>
					<span className="flex gap-2">
						<select value={draft.hour} onChange={(event) => set("hour", Number(event.target.value))} className={SELECT} aria-label="Hour">
							{HOURS.map((hour) => (
								<option key={hour} value={hour}>
									{String(hour).padStart(2, "0")}:00
								</option>
							))}
						</select>
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
						On: make an issue at each run
					</label>
				</RowSettings>
			</CardSettings>

			<CardSettings title="Issue">
				<RowSettings label="Each issue">
					<label className="flex items-start gap-2 text-sm">
						<input type="radio" name="mode" checked={draft.mode === "draft"} onChange={() => set("mode", "draft")} className="mt-0.5 size-4 accent-foreground" />
						<span>
							Wait as a draft for me to review
							<span className="block text-xs text-muted-foreground">You get an email when it is ready.</span>
						</span>
					</label>
					<label className="flex items-start gap-2 text-sm">
						<input type="radio" name="mode" checked={draft.mode === "send"} onChange={() => set("mode", "send")} className="mt-0.5 size-4 accent-foreground" />
						<span>
							Send automatically to the whole list
							<span className="block text-xs text-muted-foreground">No review: the issue is the feed&apos;s new items as they are.</span>
						</span>
					</label>
				</RowSettings>
				<RowSettings label="Subject" hint="{{date}}, {{first_title}} and {{count}} are filled in" isLabel>
					<Input value={draft.subject} onChange={(event) => set("subject", event.target.value)} maxLength={200} required />
				</RowSettings>
				<RowSettings label="Preview text" isLabel>
					<Input value={draft.previewText} onChange={(event) => set("previewText", event.target.value)} maxLength={300} />
				</RowSettings>
				<RowSettings label="Introduction" hint="Optional, above the items. Paragraphs with a blank line between them, or HTML." isLabel>
					<Textarea value={draft.intro} onChange={(event) => set("intro", event.target.value)} rows={3} maxLength={5000} />
				</RowSettings>
				<RowSettings label="Items" hint="At most this many new items, when the feed has more" isLabel>
					<span className="flex gap-2">
						<select value={draft.count} onChange={(event) => set("count", Number(event.target.value))} className={SELECT} aria-label="Items">
							{Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
								<option key={count} value={count}>
									{count}
								</option>
							))}
						</select>
						<select value={draft.order} onChange={(event) => set("order", event.target.value)} className={SELECT} aria-label="Order">
							<option value="newest">Newest first</option>
							<option value="oldest">Oldest first</option>
						</select>
					</span>
				</RowSettings>
				<RowSettings label="Show">
					<span className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
						{[
							["date", "Date"],
							["excerpt", "Excerpt"],
							["image", "Picture"],
						].map(([key, label]) => (
							<label key={key} className="flex items-center gap-2">
								<input type="checkbox" checked={draft[key]} onChange={(event) => set(key, event.target.checked)} className="size-4 accent-foreground" />
								{label}
							</label>
						))}
					</span>
				</RowSettings>
			</CardSettings>

			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" disabled={isPending}>
					{isPending && <Loader2 className="animate-spin" />}
					Save
				</Button>
				{series && (
					<>
						<Button type="button" variant="outline" onClick={runNow} disabled={isPending}>
							<Play data-icon="inline-start" />
							Make a draft now
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

// The browser's zones, with the series' own first when the list doesn't have it.
function getTimeZones(current) {
	const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
	return ["UTC", ...zones.filter((zone) => zone !== "UTC"), ...(current && current !== "UTC" && !zones.includes(current) ? [current] : [])];
}
