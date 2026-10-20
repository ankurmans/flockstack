"use server";

import { headers } from "next/headers";
import { redeemGift } from "@/lib/gifts";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";

// People click from home and office networks; a shared one still fits several readers.
const PER_IP = { name: "gift-redeem-ip", limit: 20, window: "10 m" };

export async function redeem(token) {
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) return { error: "busy" };
	return redeemGift(token);
}
