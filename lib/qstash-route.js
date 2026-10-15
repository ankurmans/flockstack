import "server-only";
import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { sendAlert } from "@/lib/alerts";

// QStash retries a failed job 3 times by default (Upstash-Retried counts them): the third try failing alerts.
const ALERT_AFTER_RETRIES = 2;

async function alertIfRepeated(request, problem) {
	const retried = Number.parseInt(request.headers.get("upstash-retried") ?? "", 10);
	if (!(retried >= ALERT_AFTER_RETRIES)) return;
	const path = new URL(request.url).pathname;
	await sendAlert({
		accountId: null,
		key: `job-failing:${path}`,
		title: "Background job failing",
		detail: `${path} failed ${retried + 1} times in a row: ${String(problem).slice(0, 300)}.`,
		action: "After its last try QStash keeps it in the dead letter queue: check the logs, then retry it there.",
		link: "https://console.upstash.com/qstash",
	});
}

// Jobs only run when QStash signed the request. There's no QStash locally, so dev runs them unsigned.
export function withQStashSignature(handler, { verify = verifySignatureAppRouter } = {}) {
	let verifiedHandler;
	return async function POST(request) {
		if (process.env.NODE_ENV === "development") return handler(request);
		if (!process.env.QSTASH_CURRENT_SIGNING_KEY || !process.env.QSTASH_NEXT_SIGNING_KEY) {
			return NextResponse.json({ error: "QStash is not configured" }, { status: 503 });
		}
		// Created on first use: verifySignatureAppRouter throws right away when signing keys are missing. Off, dev mode
		// keeps QSTASH_DEV from swapping the signing keys for QStash's public development ones.
		verifiedHandler ??= verify(handler, { devMode: false });
		let response;
		// A signature that doesn't verify throws, and it's anyone's request, not the server failing.
		try {
			response = await verifiedHandler(request);
		} catch (error) {
			if (error?.name === "SignatureError") return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
			await alertIfRepeated(request, error?.message ?? error);
			throw error;
		}
		if (response.status >= 500) await alertIfRepeated(request, `it answered ${response.status}`);
		return response;
	};
}
