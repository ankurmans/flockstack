"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { findPublicPoll, recordEmailVote, recordWebVote, saveFollowUp } from "@/lib/polls";

// Website votes are anonymous, so their count is held back per address; subscribers' votes are one per link anyway.
const WEB_PER_IP = { name: "poll-web-ip", limit: 30, window: "10 m" };
const FOLLOW_UP_PER_IP = { name: "poll-follow-up-ip", limit: 20, window: "10 m" };

function resultsPath(pollId, token, extra = {}) {
	const query = new URLSearchParams({ p: String(pollId), ...(token && { token }), ...extra });
	return `/poll/results?${query}`;
}

// The vote page sends this as soon as it opens: a person's browser votes, a link scanner that only fetches the page doesn't.
export async function vote(pollId, option, token) {
	if (token) {
		const result = await recordEmailVote({ pollId, option, token });
		if (result.problem === "invalid") return { error: "invalid" };
		if (result.problem) redirect(resultsPath(pollId, token, { status: result.problem }));
		redirect(resultsPath(pollId, token));
	}
	const ip = getClientIp(await headers());
	if (await isRateLimited({ ...WEB_PER_IP, key: ip })) return { error: "busy" };
	const result = await recordWebVote({ pollId, option, ip });
	if (result.problem === "invalid") return { error: "invalid" };
	redirect(resultsPath(pollId, null, result.problem ? { status: result.problem } : {}));
}

export async function answerFollowUp(pollId, token, _state, formData) {
	const ip = getClientIp(await headers());
	if (await isRateLimited({ ...FOLLOW_UP_PER_IP, key: ip })) return { error: "Too many answers from your network. Try again in a few minutes." };
	const poll = await findPublicPoll(pollId);
	if (!poll) return { error: "This poll is gone" };
	const saved = await saveFollowUp(poll, { token, ip, comment: formData.get("comment") });
	return saved ? { ok: true } : { error: "Vote first, then add a few words" };
}
