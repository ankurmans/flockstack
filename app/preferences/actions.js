"use server";

import { headers } from "next/headers";
import { savePreferences } from "@/lib/preferences";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";

const PER_IP = { name: "preferences-ip", limit: 20, window: "10 m" };

export async function savePreferenceForm(token, _state, formData) {
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) return { error: "Too many changes from your network. Try again in a few minutes." };
	const result = await savePreferences(token, (field) => (field.type === "list" && field.multiple ? formData.getAll(`field_${field.key}`) : formData.get(`field_${field.key}`)));
	if (result.problem === "invalid") return { error: "This link doesn't work. Open it from an email again." };
	if (result.problem) return { error: result.problem };
	return { ok: true };
}
