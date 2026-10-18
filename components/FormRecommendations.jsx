"use client";

import { useState, useTransition } from "react";
import { Search, Trash2 } from "lucide-react";
import {
	addRecommendation,
	decideRecommendation,
	removeRecommendation,
	savePitch,
	saveRecommendationSettings,
	searchNewsletters,
} from "@/app/(app)/recommending/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatNumber } from "@/lib/format";
import { MAX_PITCH_LENGTH } from "@/lib/recommendation-rules";
import { toast } from "@/lib/toast";
import { toSlugInput } from "@/lib/slug";

const STATUS_LABELS = { active: "Showing", pending: "Pending", removed: "Removed" };
const STATUS_VARIANTS = { active: "secondary", pending: "outline", removed: "destructive" };

function describeCounts({ impressions, signups, confirmed }, { sent }) {
	return `${formatNumber(impressions)} shown · ${formatNumber(signups)} ${sent ? "signed up" : "joined"} · ${formatNumber(confirmed)} confirmed`;
}

// A newsletter's recommendations: the two settings, the newsletters it recommends with what each brought, and the ones that
// recommend it, which its owner can decline with a reason the recommender reads.
export default function FormRecommendations({ newsletterId, data }) {
	const [isSaving, startSaving] = useTransition();

	function saveSettings(patch) {
		const next = { ...data.settings, ...patch };
		startSaving(async () => {
			const result = await saveRecommendationSettings({
				newsletterId,
				allowIncoming: next.allowIncoming,
				listed: next.allowIncoming && next.listed,
			});
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<div className="flex flex-col gap-4">
			<CardSettings title="Settings" stagger={1}>
				<RowSettings
					label="Take recommendations"
					hint="Other newsletters can recommend this one. Turn it off and they stop showing it at once; they see why."
				>
					<Switch
						checked={data.settings.allowIncoming}
						disabled={isSaving}
						onCheckedChange={(allowIncoming) => saveSettings({ allowIncoming })}
						aria-label="Take recommendations"
					/>
				</RowSettings>
				<RowSettings
					label="List in the directory"
					hint="Creators in your region can find this newsletter at /recommendations and in search. It shows your description and a range of subscribers, never an exact number."
				>
					<Switch
						checked={data.settings.listed && data.settings.allowIncoming}
						disabled={isSaving || !data.settings.allowIncoming}
						onCheckedChange={(listed) => saveSettings({ listed })}
						aria-label="List in the directory"
					/>
				</RowSettings>
			</CardSettings>

			<CardSettings title={`Newsletters you recommend (${data.outgoing.filter(({ status }) => status !== "removed").length} of ${data.limit})`} stagger={2}>
				{data.outgoing.length === 0 && (
					<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
						Readers see these after they subscribe, on your website and wherever an issue has{" "}
						<code className="font-mono text-foreground">{"{{recommendations}}"}</code>. A reader&apos;s email goes to another newsletter only if
						they tick it.
					</p>
				)}
				{data.outgoing.map((item) => (
					<RowOutgoing key={`${item.id}:${item.pitch}`} newsletterId={newsletterId} item={item} />
				))}
				<FormAdd newsletterId={newsletterId} isFull={data.outgoing.filter(({ status }) => status !== "removed").length >= data.limit} />
			</CardSettings>

			<CardSettings title="Newsletters that recommend yours" stagger={3}>
				{data.incoming.length === 0 && (
					<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
						Nobody recommends this newsletter yet. List it in the directory and others can find it.
					</p>
				)}
				{data.incoming.map((item) => (
					<RowIncoming key={item.id} newsletterId={newsletterId} item={item} />
				))}
			</CardSettings>
		</div>
	);
}

function RowOutgoing({ newsletterId, item }) {
	const [pitch, setPitch] = useState(item.pitch);
	const [isPending, startTransition] = useTransition();
	const isRemoved = item.status === "removed";

	function act(run) {
		startTransition(async () => {
			const result = await run();
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<div className="flex flex-col gap-2 px-4 py-3">
			<div className="flex items-center gap-2.5">
				{item.newsletter && <AvatarNewsletter newsletter={item.newsletter} size={28} />}
				<span className="min-w-0 truncate text-sm font-medium">{item.newsletter?.name ?? "A deleted newsletter"}</span>
				<Badge variant={STATUS_VARIANTS[item.status]}>{STATUS_LABELS[item.status]}</Badge>
				{!isRemoved && (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="ml-auto text-muted-foreground"
						aria-label={`Stop recommending ${item.newsletter?.name ?? "this newsletter"}`}
						disabled={isPending}
						onClick={() => act(() => removeRecommendation({ newsletterId, id: item.id }))}
					>
						<Trash2 />
					</Button>
				)}
			</div>
			{item.reason && (
				<p className="text-sm text-pretty text-amber-700 dark:text-amber-400" role="status">
					{item.reason}
				</p>
			)}
			{!isRemoved && (
				<div className="flex items-center gap-2">
					<Input value={pitch} maxLength={MAX_PITCH_LENGTH} onChange={(event) => setPitch(event.target.value)} aria-label={`Pitch for ${item.newsletter?.name ?? "this newsletter"}`} />
					{pitch !== item.pitch && (
						<Button type="button" size="sm" disabled={isPending} onClick={() => act(() => savePitch({ newsletterId, id: item.id, pitch }))}>
							Save
						</Button>
					)}
				</div>
			)}
			<p className="text-xs text-muted-foreground tabular-nums">{describeCounts(item, { sent: true })}</p>
		</div>
	);
}

function RowIncoming({ newsletterId, item }) {
	const [isAsking, setIsAsking] = useState(false);
	const [reason, setReason] = useState("");
	const [isPending, startTransition] = useTransition();

	function decide(decision) {
		startTransition(async () => {
			const result = await decideRecommendation({ newsletterId, id: item.id, decision, reason });
			if (result?.error) return void toast.error(result.error);
			setIsAsking(false);
			setReason("");
		});
	}

	return (
		<div className="flex flex-col gap-2 px-4 py-3">
			<div className="flex items-center gap-2.5">
				<AvatarNewsletter newsletter={item.recommender} size={28} />
				<span className="min-w-0 truncate text-sm font-medium">{item.recommender.name}</span>
				<Badge variant={item.status === "removed" ? "destructive" : "secondary"}>{item.status === "removed" ? "Removed" : "Showing"}</Badge>
				<span className="ml-auto">
					{item.status === "active" && !isAsking && (
						<Button type="button" variant="outline" size="sm" onClick={() => setIsAsking(true)}>
							Decline
						</Button>
					)}
					{item.status === "removed" && item.removedBy === "recommended" && (
						<Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => decide("restore")}>
							Bring back
						</Button>
					)}
				</span>
			</div>
			<p className="text-sm text-pretty text-muted-foreground">{item.pitch}</p>
			{item.reason && <p className="text-sm text-pretty text-amber-700 dark:text-amber-400">{item.reason}</p>}
			{isAsking && (
				<div className="flex items-center gap-2">
					<Input
						value={reason}
						maxLength={200}
						placeholder="Why? They read this"
						onChange={(event) => setReason(event.target.value)}
						aria-label={`Reason for declining ${item.recommender.name}`}
					/>
					<Button type="button" size="sm" disabled={isPending} onClick={() => decide("decline")}>
						Decline
					</Button>
					<Button type="button" variant="ghost" size="sm" onClick={() => setIsAsking(false)}>
						Cancel
					</Button>
				</div>
			)}
			<p className="text-xs text-muted-foreground tabular-nums">{describeCounts(item, { sent: false })}</p>
		</div>
	);
}

function FormAdd({ newsletterId, isFull }) {
	const [slug, setSlug] = useState("");
	const [pitch, setPitch] = useState("");
	const [query, setQuery] = useState("");
	const [found, setFound] = useState(null);
	const [isPending, startTransition] = useTransition();

	function add(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await addRecommendation({ newsletterId, slug, pitch });
			if (result?.error) return void toast.error(result.error);
			setSlug("");
			setPitch("");
		});
	}

	function search(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await searchNewsletters({ query });
			if (result?.error) return void toast.error(result.error);
			setFound(result.output.newsletters);
		});
	}

	return (
		<div className="flex flex-col gap-3 px-4 py-3">
			<form onSubmit={add} className="flex flex-col gap-2">
				<Input
					value={slug}
					placeholder="Slug of the newsletter, like weekly-fox"
					onChange={(event) => setSlug(toSlugInput(event.target.value))}
					aria-label="Slug of the newsletter to recommend"
					maxLength={40}
				/>
				<Input
					value={pitch}
					placeholder="Why would your readers like it? Your words, plain text"
					maxLength={MAX_PITCH_LENGTH}
					onChange={(event) => setPitch(event.target.value)}
					aria-label="Pitch"
				/>
				<div className="flex items-center justify-between gap-3">
					<span className="text-xs text-muted-foreground tabular-nums">
						{pitch.length} of {MAX_PITCH_LENGTH}
					</span>
					<Button type="submit" size="sm" disabled={isPending || isFull || !slug || !pitch.trim()}>
						Recommend
					</Button>
				</div>
				{isFull && <p className="text-xs text-muted-foreground">Remove one to add another.</p>}
			</form>
			<form onSubmit={search} className="flex items-center gap-2 border-t border-border/60 pt-3">
				<Input value={query} placeholder="Find newsletters in the directory" onChange={(event) => setQuery(event.target.value)} aria-label="Search the directory" />
				<Button type="submit" variant="outline" size="sm" disabled={isPending}>
					<Search data-icon="inline-start" />
					Search
				</Button>
			</form>
			{found && found.length === 0 && <p className="text-sm text-muted-foreground">No newsletters found. Only ones that listed themselves show up.</p>}
			{found && found.length > 0 && (
				<ul className="flex flex-col gap-2">
					{found.map((item) => (
						<li key={item.slug} className="flex items-center gap-2.5">
							<AvatarNewsletter newsletter={item} size={28} />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm font-medium">{item.name}</span>
								<span className="block truncate text-xs text-muted-foreground">
									{item.subscriberRange} subscribers · {item.slug}
								</span>
							</span>
							<Button type="button" variant="outline" size="sm" onClick={() => setSlug(item.slug)}>
								Use
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
