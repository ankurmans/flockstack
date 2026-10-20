"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { isCloud } from "@/lib/config";
import { createCustomRequest, notifyCustomRequest } from "@/lib/custom-requests";
import { parseCustomRequest } from "@/lib/custom-rules";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { limitKey } from "@/lib/reader-links";

// A lead form anyone can fill in, so it is held back by network and by address: a few requests an hour is a person.
const PER_IP = { name: "custom-request-ip", limit: 5, window: "1 h" };
const PER_EMAIL = { name: "custom-request-email", limit: 3, window: "1 d" };

export async function sendCustomRequest(_state, formData) {
	if (!isCloud()) return { error: "This server has no Custom plan" };
	// People never see this field; bots fill in every input they find.
	if (formData.get("fax")) return { ok: true };

	const { value, problem } = parseCustomRequest({ get: (name) => formData.get(name), getAll: (name) => formData.getAll(name) });
	if (problem) return { error: problem };

	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) return { error: "Too many requests from your network. Try again in an hour, or write to us." };
	if (await isRateLimited({ ...PER_EMAIL, key: limitKey(value.email) })) return { error: "We already have your requests. We'll reply personally." };

	const request = await createCustomRequest(value);
	after(() => notifyCustomRequest(request));
	return { ok: true };
}
