"use client";

import { useState, useTransition } from "react";
import { saveAudioSettings } from "@/app/(app)/audio/actions";
import BarSave from "@/components/BarSave";
import ButtonCopy from "@/components/ButtonCopy";
import ButtonVoiceSample from "@/components/ButtonVoiceSample";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PODCAST_CATEGORIES } from "@/lib/podcast-categories";
import { toast } from "@/lib/toast";

const FIRST_VOICE = "first";

function toDraft(settings) {
	return {
		voiceId: settings.voiceId ?? FIRST_VOICE,
		podcastEnabled: settings.podcast.enabled,
		podcastCategory: settings.podcast.category,
		podcastExplicit: settings.podcast.explicit,
		podcastOwnerEmail: settings.podcast.ownerEmail ?? "",
	};
}

// The newsletter's default voice, with a sample of each, and its podcast feed: the address to give Apple Podcasts and
// Spotify, and what they need from it.
export default function FormAudioSettings({ newsletterId, settings, voices, hasWebsite, hasLogo, episodes }) {
	const [draft, setDraft] = useState(() => toDraft(settings));
	const [saved, setSaved] = useState(() => JSON.stringify(toDraft(settings)));
	const [savedAt, setSavedAt] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const isDirty = JSON.stringify(draft) !== saved;

	function set(patch) {
		setDraft((current) => ({ ...current, ...patch }));
	}

	function save(event) {
		event.preventDefault();
		startSaving(async () => {
			const result = await saveAudioSettings({ newsletterId, ...draft, voiceId: draft.voiceId === FIRST_VOICE ? "" : draft.voiceId });
			if (result?.error) return void toast.error(result.error);
			setSaved(JSON.stringify(draft));
			setSavedAt(result.savedAt);
		});
	}

	function discard() {
		setDraft(toDraft(settings));
		setSaved(JSON.stringify(toDraft(settings)));
		setSavedAt(null);
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<CardSettings title="Voices" stagger={1}>
				<RowSettings label="Default voice" hint="New audio versions start with this voice. Each issue can use another.">
					<Select value={draft.voiceId} onValueChange={(voiceId) => set({ voiceId })}>
						<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Default voice">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={FIRST_VOICE}>The first voice ({voices[0]?.name})</SelectItem>
							{voices.map(({ id, name }) => (
								<SelectItem key={id} value={id}>
									{name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</RowSettings>
				<ul className="divide-y divide-border/60">
					{voices.map(({ id, name, description, previewUrl }) => (
						<li key={id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
							<span className="min-w-0 text-sm">
								<span className="font-medium">{name}</span>
								{description && <span className="block text-xs text-pretty text-muted-foreground">{description}</span>}
							</span>
							<ButtonVoiceSample previewUrl={previewUrl} name={name} />
						</li>
					))}
				</ul>
			</CardSettings>

			<CardSettings
				title="Podcast"
				stagger={2}
				action={<Switch checked={draft.podcastEnabled} onCheckedChange={(podcastEnabled) => set({ podcastEnabled })} aria-label="Podcast feed" />}
			>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					A feed of the issues you made audio for, so people can follow them in a podcast app. Only issues for everyone are in it: an issue for paid
					subscribers only never is, and an issue&apos;s paid part is never read.
				</p>
				{!hasWebsite && <p className="px-4 py-3 text-sm text-pretty text-amber-700 dark:text-amber-400" role="status">The feed is served from your website. Turn the website on in the newsletter&apos;s settings first.</p>}
				{!hasLogo && <p className="px-4 py-3 text-sm text-pretty text-amber-700 dark:text-amber-400" role="status">Podcast apps want cover art. It is your newsletter&apos;s logo, which you add in its settings, and Apple Podcasts asks for at least 1400 by 1400 pixels.</p>}
				{draft.podcastEnabled && (
					<>
						<RowSettings label="Feed address" hint={episodes === 0 ? "Apple Podcasts and Spotify turn a show without an episode down: make audio for an issue first." : `${episodes} ${episodes === 1 ? "episode" : "episodes"} now.`}>
							<span className="flex min-w-0 items-center gap-1">
								<code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{settings.podcast.feedUrl}</code>
								<ButtonCopy value={settings.podcast.feedUrl} label="Copy the feed address" />
							</span>
						</RowSettings>
						<RowSettings label="Category">
							<Select value={draft.podcastCategory} onValueChange={(podcastCategory) => set({ podcastCategory })}>
								<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Category">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PODCAST_CATEGORIES.map((category) => (
										<SelectItem key={category} value={category}>
											{category}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</RowSettings>
						<RowSettings label="Explicit">
							<span className="flex items-center gap-2 pt-1.5 text-sm">
								<Switch checked={draft.podcastExplicit} onCheckedChange={(podcastExplicit) => set({ podcastExplicit })} aria-label="Mark the show explicit" />
								Contains explicit content
							</span>
						</RowSettings>
						<RowSettings label="Owner email" isLabel hint="Optional. It is printed in the feed, where anyone can read it. Spotify and Apple Podcasts can use it to check the show is yours.">
							<Input type="email" value={draft.podcastOwnerEmail} onChange={(event) => set({ podcastOwnerEmail: event.target.value })} placeholder="you@example.com" autoComplete="off" />
						</RowSettings>
					</>
				)}
			</CardSettings>

			{draft.podcastEnabled && (
				<CardSettings title="Put it in Apple Podcasts and Spotify" stagger={3}>
					<ol className="list-decimal space-y-2 px-8 py-3 text-sm text-pretty marker:text-muted-foreground">
						<li>Save, so the feed is on. Make audio for at least one issue.</li>
						<li>
							<strong className="font-medium">Apple Podcasts:</strong> sign in to{" "}
							<a href="https://podcastsconnect.apple.com" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
								Apple Podcasts Connect
							</a>{" "}
							with an Apple Account, add a show with an RSS feed and paste the feed address. Apple checks it and says what to fix, and reviews the show before it
							appears.{" "}
							<a href="https://podcasters.apple.com/support/823-podcast-requirements" target="_blank" rel="noreferrer" className="underline underline-offset-4">
								Apple&apos;s requirements
							</a>
						</li>
						<li>
							<strong className="font-medium">Spotify:</strong> sign in to{" "}
							<a href="https://creators.spotify.com" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
								Spotify for Creators
							</a>{" "}
							and add a podcast you already have by its RSS feed address. Spotify can ask to confirm you own it by emailing the owner email above.
						</li>
						<li>Both read the feed again by themselves, so a new audio version turns up as a new episode.</li>
					</ol>
				</CardSettings>
			)}
			<BarSave isDirty={isDirty} isSaving={isSaving} savedAt={savedAt} onDiscard={discard} />
		</form>
	);
}
