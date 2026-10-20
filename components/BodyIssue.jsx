"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { unlockIssue } from "@/app/archive/reader-actions";
import CardPaywall from "@/components/CardPaywall";
import FrameIssue from "@/components/FrameIssue";
import PlayerAudio from "@/components/PlayerAudio";
import { readerMarkerName } from "@/lib/reader-cookies";

const subscribeToNothing = () => () => {};

// An issue's text. The page is cached for everyone, so it holds what everyone may read, with the upgrade card where a
// paid part starts. A browser with a reader session asks the server once, and a paid reader's answer replaces the page's
// text with the whole issue; for anyone else nothing changes. initial: { kind, html, isPartial } from lib/web-issue.js.
// audio: the issue's audio version, { src, seconds, scope, isGated, title, storageKey }. Everyone gets the player of public audio
// on an issue that is open; the paid kind, and an issue the gate holds, show it once the server has said this reader may read
// the issue (unlocked, or isOpened: the gate's component opened it).
export default function BodyIssue({ slug, post, initial, newsletterName, subscribeHref, audio = null, isOpened = false }) {
	const [unlocked, setUnlocked] = useState(null);
	const hasSession = useSyncExternalStore(
		subscribeToNothing,
		() => document.cookie.split("; ").includes(`${readerMarkerName(slug)}=1`),
		() => false
	);
	const isGated = initial.kind === "paywall";

	useEffect(() => {
		if (!isGated || !hasSession) return;
		let isCurrent = true;
		unlockIssue(slug, post)
			.then((answer) => isCurrent && answer?.unlocked && setUnlocked(answer))
			.catch(() => {});
		return () => {
			isCurrent = false;
		};
	}, [isGated, hasSession, slug, post]);

	const body = unlocked ?? initial;
	return (
		<>
			{audio && (unlocked ? true : audio.scope === "public" && (!audio.isGated || isOpened)) && <PlayerAudio src={audio.src} seconds={audio.seconds} title={audio.title} storageKey={audio.storageKey} className="mt-8" />}
			{body.kind === "frame" ? (
				<FrameIssue html={body.html} className="-mx-5 mt-10 rounded-none sm:mx-0 sm:rounded-xl" />
			) : (
				<div style={{ "--stagger": 1 }} className="prose-issue mt-10 animate-enter" dangerouslySetInnerHTML={{ __html: body.html }} />
			)}
			{body.kind === "paywall" && <CardPaywall newsletterName={newsletterName} href={subscribeHref} isPartial={body.isPartial} />}
		</>
	);
}
