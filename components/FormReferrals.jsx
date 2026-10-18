"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { saveReferralSettings } from "@/app/(app)/referrals/actions";
import BarSave from "@/components/BarSave";
import ButtonCopy from "@/components/ButtonCopy";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MAX_REWARDS } from "@/lib/referral-rules";
import { REFERRAL_COUNT_TAG, REFERRAL_LINK_TAG, SHARE_BLOCK_HTML, SHARE_BLOCK_MARKDOWN } from "@/lib/referral-tags";
import { toast } from "@/lib/toast";

let nextKey = 0;

function toDraft(settings) {
	return {
		enabled: settings.enabled,
		rewards: settings.rewards.map((reward) => ({ key: nextKey++, ...reward, referrals: String(reward.referrals) })),
	};
}

function toSnapshot({ enabled, rewards }) {
	return JSON.stringify([enabled, rewards.map(({ id, referrals, title, url, text }) => [id, referrals, title, url, text])]);
}

// problem: why the program can't count referrals yet (turn on confirmation emails, the website), or null. The switch stays
// available to turn it on later; saving it on while a problem stands is refused with that same sentence.
export default function FormReferrals({ newsletterId, settings }) {
	const [draft, setDraft] = useState(() => toDraft(settings));
	const [saved, setSaved] = useState(() => toSnapshot(toDraft(settings)));
	const [savedAt, setSavedAt] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const isDirty = toSnapshot(draft) !== saved;

	function set(patch) {
		setDraft((current) => ({ ...current, ...patch }));
	}

	function setReward(key, patch) {
		setDraft((current) => ({ ...current, rewards: current.rewards.map((reward) => (reward.key === key ? { ...reward, ...patch } : reward)) }));
	}

	function addReward() {
		const last = Math.max(0, ...draft.rewards.map(({ referrals }) => Number(referrals) || 0));
		set({ rewards: [...draft.rewards, { key: nextKey++, id: "", referrals: String(last < 3 ? 3 : last + 5), title: "", url: "", text: "" }] });
	}

	function save(event) {
		event.preventDefault();
		startSaving(async () => {
			const result = await saveReferralSettings({ newsletterId, ...draft });
			if (result?.error) return void toast.error(result.error);
			setSaved(toSnapshot(draft));
			setSavedAt(result.savedAt);
		});
	}

	function discard() {
		const fresh = toDraft(settings);
		setDraft(fresh);
		setSaved(toSnapshot(fresh));
		setSavedAt(null);
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<CardSettings
				title="Referral program"
				stagger={1}
				action={<Switch checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Referral program" />}
			>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Every subscriber gets a link of their own to your website. When someone signs up through it and confirms their email, it counts for
					the subscriber who shared it, and they unlock the rewards you set. Repeats and self-referrals never count.
				</p>
				{settings.problem && (
					<p className="px-4 py-3 text-sm text-pretty text-amber-700 dark:text-amber-400" role="status">
						{settings.problem}
					</p>
				)}
			</CardSettings>

			<CardSettings
				title="Rewards"
				stagger={2}
				action={
					<Button type="button" variant="outline" size="sm" onClick={addReward} disabled={draft.rewards.length >= MAX_REWARDS}>
						<Plus data-icon="inline-start" />
						Add reward
					</Button>
				}
			>
				{draft.rewards.length === 0 && (
					<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
						Without rewards, referrals are only counted. A reward is a title and a link or a message, shown on the subscriber&apos;s referral
						page and emailed to them when they reach its number.
					</p>
				)}
				{draft.rewards.map((reward, index) => (
					<div key={reward.key} className="flex flex-col gap-2 px-4 py-3">
						<div className="flex items-center gap-2">
							<label className="flex items-center gap-2 text-sm text-muted-foreground">
								At
								<Input
									type="number"
									min={1}
									value={reward.referrals}
									onChange={(event) => setReward(reward.key, { referrals: event.target.value })}
									className="w-20 tabular-nums"
									aria-label={`Referrals that unlock reward ${index + 1}`}
								/>
								referrals
							</label>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="ml-auto text-muted-foreground"
								aria-label={`Remove reward ${index + 1}`}
								onClick={() => set({ rewards: draft.rewards.filter(({ key }) => key !== reward.key) })}
							>
								<Trash2 />
							</Button>
						</div>
						<Input value={reward.title} placeholder="Title, e.g. The field guide" maxLength={100} onChange={(event) => setReward(reward.key, { title: event.target.value })} aria-label={`Title of reward ${index + 1}`} />
						<Input value={reward.url} placeholder="https:// link to a file or page (optional)" onChange={(event) => setReward(reward.key, { url: event.target.value })} aria-label={`Link of reward ${index + 1}`} />
						<Textarea value={reward.text} placeholder="A message to reveal, e.g. a code (optional)" rows={2} maxLength={1000} onChange={(event) => setReward(reward.key, { text: event.target.value })} aria-label={`Message of reward ${index + 1}`} />
					</div>
				))}
			</CardSettings>

			<CardSettings title="Put it in your issues" stagger={3}>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Write <code className="font-mono text-foreground">{REFERRAL_LINK_TAG}</code> where each subscriber&apos;s own link goes and{" "}
					<code className="font-mono text-foreground">{REFERRAL_COUNT_TAG}</code> for the number of people they&apos;ve referred. In the editor,
					type / and pick Referral block. For an issue written in HTML or Markdown, paste one of these.
				</p>
				<RowSettings label="HTML">
					<Snippet value={SHARE_BLOCK_HTML} label="Copy the HTML block" />
				</RowSettings>
				<RowSettings label="Markdown">
					<Snippet value={SHARE_BLOCK_MARKDOWN} label="Copy the Markdown block" />
				</RowSettings>
			</CardSettings>

			<BarSave isDirty={isDirty} isSaving={isSaving} savedAt={savedAt} onDiscard={discard} />
		</form>
	);
}

function Snippet({ value, label }) {
	return (
		<span className="flex items-start gap-1 rounded-lg bg-muted/60 py-2 pr-1 pl-3">
			<code className="min-w-0 flex-1 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap">{value}</code>
			<ButtonCopy value={value} label={label} />
		</span>
	);
}
