"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Trash2, Volume2 } from "lucide-react";
import { createAudio, getAudio, getAudioCost, removeAudio, setListenLink } from "@/app/(app)/audio/actions";
import ButtonVoiceSample from "@/components/ButtonVoiceSample";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatBytes, formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";

const POLL_MS = 3000;

function isActive(audio) {
	return audio?.status === "queued" || audio?.status === "running";
}

function formatLength(seconds) {
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

// The audio version of an issue, in the issue's review step and its report: pick a voice, see what it will use of the
// month's characters, create it (a background job: this page follows it), listen to it, delete it. canLink: the issue has
// a web page for an email's Listen link to open. Hidden by the page while audio versions are off.
export default function CardAudio({ campaignId, initial = { audio: null, estimate: null }, voices = [], defaultVoiceId = null, canLink = false, hasPlan = true, isPaidOnly = false }) {
	const [audio, setAudio] = useState(initial.audio);
	const [estimate, setEstimate] = useState(initial.estimate);
	const [voiceId, setVoiceId] = useState(initial.audio?.voiceId ?? defaultVoiceId ?? voices[0]?.id ?? "");
	const [emailLink, setEmailLink] = useState(Boolean(initial.audio?.emailLink));
	const [isCreating, startCreating] = useTransition();
	const [isDeleting, startDeleting] = useTransition();
	const [isConfirming, setIsConfirming] = useState(false);
	const wasActive = useRef(isActive(initial.audio));
	const voice = voices.find(({ id }) => id === voiceId);

	const refreshEstimate = useCallback(async () => {
		const result = await getAudioCost(campaignId);
		if (result?.estimate) setEstimate(result.estimate);
	}, [campaignId]);

	useEffect(() => {
		if (!isActive(audio)) return;
		const interval = setInterval(async () => {
			const result = await getAudio(campaignId);
			if (result?.audio) setAudio(result.audio);
		}, POLL_MS);
		return () => clearInterval(interval);
	}, [audio, campaignId]);

	useEffect(() => {
		const active = isActive(audio);
		if (wasActive.current && !active) {
			if (audio?.status === "ready") toast.success("The audio version is ready");
			if (audio?.status === "failed") toast.error("The audio version failed", { description: audio.error ?? undefined });
			refreshEstimate();
		}
		wasActive.current = active;
	}, [audio, refreshEstimate]);

	useEffect(() => {
		window.addEventListener("focus", refreshEstimate);
		return () => window.removeEventListener("focus", refreshEstimate);
	}, [refreshEstimate]);

	function create() {
		startCreating(async () => {
			const result = await createAudio({ campaignId, voiceId, emailLink: canLink ? emailLink : undefined });
			if (result.error) return void toast.error(result.error);
			wasActive.current = isActive(result.audio);
			setAudio(result.audio);
			if (result.audio.created === false) toast.message("The audio is up to date", { description: "Nothing changed since it was made." });
			refreshEstimate();
		});
	}

	function remove() {
		if (!isConfirming) return void setIsConfirming(true);
		setIsConfirming(false);
		startDeleting(async () => {
			const result = await removeAudio(campaignId);
			if (result.error) return void toast.error(result.error);
			setAudio(null);
			refreshEstimate();
		});
	}

	async function changeLink(next) {
		setEmailLink(next);
		if (!audio?.file) return;
		const result = await setListenLink({ campaignId, emailLink: next });
		if (result.error) {
			setEmailLink(!next);
			return void toast.error(result.error);
		}
		setAudio(result.audio);
	}

	if (!hasPlan) {
		return (
			<CardSettings title="Audio version" stagger={3}>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Audio versions aren&apos;t part of the Free plan.{" "}
					<Link href="/billing" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
						See plans
					</Link>
				</p>
			</CardSettings>
		);
	}

	const active = isActive(audio);
	const file = audio?.file;
	const cantCreate = !estimate || !estimate.hasText || estimate.tooLong || estimate.wouldExceed;
	const label = file ? "Create again" : "Create audio version";

	return (
		<CardSettings
			title="Audio version"
			stagger={3}
			action={
				<Button type="button" size="sm" onClick={create} disabled={isCreating || active || cantCreate}>
					{isCreating || active ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Volume2 data-icon="inline-start" />}
					{active ? "Making it" : label}
				</Button>
			}
		>
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				{isPaidOnly
					? "A voice reads this issue aloud. It is for paid subscribers only, so only paid readers hear it, on the issue's page."
					: "A voice reads this issue aloud. Readers play it on the issue's page, and it can be a podcast. What comes after a paywall break is left out."}
			</p>
			<RowSettings label="Voice" hint={voice?.description || undefined}>
				<span className="flex flex-wrap items-center gap-2">
					<Select value={voiceId} onValueChange={setVoiceId} disabled={active}>
						<SelectTrigger className="h-9 w-full sm:w-60" aria-label="Voice">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{voices.map(({ id, name }) => (
								<SelectItem key={id} value={id}>
									{name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{voice && <ButtonVoiceSample previewUrl={voice.previewUrl} name={voice.name} />}
				</span>
			</RowSettings>
			{canLink && (
				<RowSettings label="In the email" hint="Opens the issue's emails with a link to the player. It appears in emails sent once the audio is ready.">
					<span className="flex items-center gap-2 pt-1.5 text-sm">
						<Switch checked={emailLink} onCheckedChange={changeLink} aria-label="Listen to this issue link at the top of the email" />
						Listen to this issue
					</span>
				</RowSettings>
			)}
			{estimate && (
				<p className="px-4 py-3 text-sm text-pretty" role="status">
					{!estimate.hasText ? "There is no text to read yet." : estimate.tooLong ? "This issue is too long for one audio version." : estimate.message}
					{estimate.hasText && !estimate.tooLong && <span className="text-muted-foreground"> About {estimate.minutes} min.</span>}
					{estimate.wouldExceed && (
						<>
							{" "}
							<Link href="/billing" className="font-medium underline underline-offset-4">
								Change plan
							</Link>
						</>
					)}
				</p>
			)}
			{active && (
				<p className="px-4 py-3 text-sm text-muted-foreground tabular-nums" role="status">
					Reading part {Math.min(audio.progress.done + 1, audio.progress.total)} of {audio.progress.total}. You can leave this page.
				</p>
			)}
			{audio?.status === "failed" && (
				<p className="px-4 py-3 text-sm text-pretty text-destructive" role="alert">
					{audio.error || "The audio version failed."} {file ? "The earlier audio is still in place." : ""} Create it again to try again: parts already read aren&apos;t read twice.
				</p>
			)}
			{file && (
				<div className="flex flex-col gap-2 px-4 py-3">
					{audio.outOfDate && !active && <p className="text-sm text-pretty text-amber-700 dark:text-amber-400">The issue changed after this audio was made. Create it again to replace it.</p>}
					<audio controls preload="none" className="w-full" src={`/api/audio/${campaignId}?v=${new Date(file.readyAt).getTime()}`} />
					<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
						<span>
							{formatLength(file.seconds)} · {formatBytes(file.bytes)} · {formatNumber(audio.characters)} characters
						</span>
						<Button type="button" variant="ghost" size="sm" onClick={remove} disabled={isDeleting || active} className={isConfirming ? "text-destructive" : "text-muted-foreground"}>
							<Trash2 data-icon="inline-start" />
							{isConfirming ? "Click again to delete" : "Delete audio"}
						</Button>
					</div>
				</div>
			)}
		</CardSettings>
	);
}
