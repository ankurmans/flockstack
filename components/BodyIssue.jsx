"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { getReaderText } from "@/lib/reader-languages";
import { claimMeteredRead, openGift, unlockIssue } from "@/app/archive/reader-actions";
import CardPaywall from "@/components/CardPaywall";
import ReaderTranslation from "@/components/ReaderTranslation";
import ShareGiftLink from "@/components/ShareGiftLink";
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
export default function BodyIssue({ slug, post, initial, newsletterName, subscribeHref, audio = null, isOpened = false, language = "en", readerTranslations = false }) {
	const [unlocked, setUnlocked] = useState(null);
	const [meter, setMeter] = useState(null);
	const [meterError, setMeterError] = useState(null);
	const [giftProblem, setGiftProblem] = useState(null);
	const [claiming, startClaim] = useTransition();
	const t = getReaderText(language);
	function claimRead() {
		startClaim(async () => {
			setMeterError(null);
			try {
				const answer = await claimMeteredRead(slug, post, true);
				if (answer?.error) setMeterError(answer.error);
				else if (answer?.unlocked) { setUnlocked(answer); setMeter(null); }
				else setMeterError("Your session ended. Sign in again.");
			} catch { setMeterError("Could not open this issue. Try again."); }
		});
	}
	const hasSession = useSyncExternalStore(
		subscribeToNothing,
		() => document.cookie.split("; ").includes(`${readerMarkerName(slug)}=1`),
		() => false
	);
	const isGated = initial.kind === "paywall" || Boolean(initial.hasAudienceVariants);

	useEffect(() => {
		if (!isGated || !hasSession) return;
		let isCurrent = true;
		unlockIssue(slug, post)
			.then((answer) => { if (isCurrent) { setMeter(answer?.meter ?? null); if (answer?.unlocked) setUnlocked(answer); } })
			.catch(() => {});
		return () => {
			isCurrent = false;
		};
	}, [isGated, hasSession, slug, post]);

	// A gift link (?gift=) opens this one paid issue; the page is cached for everyone, so only the browser knows it came by one.
	useEffect(() => {
		const code = new URLSearchParams(window.location.search).get("gift");
		if (!code || initial.kind !== "paywall") return;
		let isCurrent = true;
		openGift(slug, post, code)
			.then((answer) => {
				if (!isCurrent) return;
				if (answer?.unlocked) setUnlocked(answer);
				else setGiftProblem(answer?.message ?? "This gift link doesn't work.");
			})
			.catch(() => isCurrent && setGiftProblem("Could not open this gift link. Try again."));
		return () => {
			isCurrent = false;
		};
	}, [initial.kind, slug, post]);

	const body = unlocked ?? initial;
	return (
		<>
			{audio && (unlocked ? unlocked.audioAllowed !== false : audio.scope === "public" && (!audio.isGated || isOpened)) && <PlayerAudio src={audio.src} seconds={audio.seconds} title={audio.title} storageKey={audio.storageKey} className="mt-8" />}
			<ReaderTranslation slug={slug} post={post} language={language} enabled={readerTranslations} hasSession={hasSession}>
			{body.kind === "frame" ? (
				<FrameIssue html={body.html} className="-mx-5 mt-10 rounded-none sm:mx-0 sm:rounded-xl" />
			) : (
				<div style={{ "--stagger": 1 }} className="prose-issue mt-10 animate-enter" dangerouslySetInnerHTML={{ __html: body.html }} />
			)}
			</ReaderTranslation>
			{body.kind === "paywall" && meter && <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border p-5 text-center"><p className="text-sm text-muted-foreground">{t("Free reads reset on the first day of each month (UTC). We keep your claimed issue IDs until seven days after the month ends.")}</p>{meter.remaining > 0 ? <button type="button" disabled={claiming} onClick={claimRead} className="rounded-md border px-4 py-2">{claiming ? t("Opening…") : t("Read this issue ({count} free reads left)", { count: meter.remaining })}</button> : <p>{t("You have used your free reads for this month.")}</p>}{meterError && <p role="alert">{t(meterError)}</p>}</div>}
			{unlocked?.canShare && <ShareGiftLink slug={slug} post={post} />}
			{unlocked?.gift && <p className="mt-6 text-center text-sm text-muted-foreground text-pretty">Someone shared this issue with you.</p>}
			{giftProblem && !unlocked && <p role="alert" className="mt-6 text-center text-sm text-muted-foreground text-pretty">{giftProblem}</p>}
			{body.kind === "paywall" && <CardPaywall language={language} newsletterName={newsletterName} href={subscribeHref} isPartial={body.isPartial} />}
		</>
	);
}
