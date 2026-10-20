import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import FormAudioSettings from "@/components/FormAudioSettings";
import HeaderPage from "@/components/HeaderPage";
import { scoped } from "@/lib/account-scope";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { isAudioEnabled } from "@/lib/audio-config";
import { getAudioLimit } from "@/lib/plans";
import { formatDate, formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import AudioVersion from "@/models/AudioVersion";

export const metadata = { title: "Audio" };

// The open newsletter's audio: the characters used this month, its default voice and its podcast feed. Hidden while
// audio versions are off.
export default async function AudioPage() {
	if (!isAudioEnabled()) notFound();
	const { account, selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const newsletter = String(selected._id);
	const hasAudio = getAudioLimit(account) !== 0;
	const [settings, voices, usage] = await Promise.all([
		runDashboardAction("get_audio_settings", { newsletter }),
		runDashboardAction("list_audio_voices", {}),
		runDashboardAction("get_audio_usage", {}),
	]);
	const episodes = await AudioVersion.countDocuments(scoped(account, { newsletterId: selected._id, "file.scope": "public", "file.key": { $type: "string" } }));

	return (
		<>
			<HeaderPage title="Audio" />
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
				{usage.output && <Usage usage={usage.output} hasPlan={hasAudio} />}
				{hasAudio && settings.output && voices.output && (
					<FormAudioSettings
						key={newsletter}
						newsletterId={newsletter}
						settings={settings.output}
						voices={voices.output.voices}
						hasWebsite={Boolean(selected.archiveEnabled)}
						hasLogo={Boolean(selected.imageUrl)}
						episodes={episodes}
					/>
				)}
			</div>
		</>
	);
}

function Usage({ usage, hasPlan }) {
	if (!hasPlan) {
		return (
			<p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-pretty">
				Audio versions aren&apos;t part of the Free plan.{" "}
				<Link href="/billing" className="font-medium underline underline-offset-4">
					See plans
				</Link>
			</p>
		);
	}
	if (usage.limit === null) return <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-pretty">{formatNumber(usage.used)} characters read this month. This server has no limit.</p>;
	const share = usage.limit ? Math.min(1, (usage.used + usage.reserved) / usage.limit) : 1;
	return (
		<section aria-label="Characters this month" style={{ "--stagger": 0 }} className="rounded-xl bg-card px-4 py-3 shadow-border animate-enter">
			<div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
				<span className="font-medium">Characters this month</span>
				<span className="text-muted-foreground tabular-nums">
					{formatNumber(usage.used)} of {formatNumber(usage.limit)}
				</span>
			</div>
			<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
				<div className="h-full rounded-full bg-foreground" style={{ width: `${share * 100}%` }} />
			</div>
			<p className="mt-2 text-xs text-pretty text-muted-foreground">
				{formatNumber(usage.left ?? 0)} left{usage.reserved > 0 ? `, ${formatNumber(usage.reserved)} held for audio being made` : ""}. The count starts over on {formatDate(usage.resetsAt)}.
				Audio is counted by the character read; there is no extra charge, and an audio version that would go past what is left isn&apos;t started.
			</p>
		</section>
	);
}
