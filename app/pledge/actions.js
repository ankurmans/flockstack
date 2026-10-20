"use server";

import { headers } from "next/headers";
import { connectDb } from "@/lib/db";
import { cancelPledgeByToken } from "@/lib/pledges";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";

// People click from home and office networks; a shared one still fits several readers.
const PER_IP = { name: "pledge-cancel-ip", limit: 20, window: "10 m" };

export async function cancelPledge(token) {
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) return { error: "busy" };
	await connectDb();
	return cancelPledgeByToken(token);
}
