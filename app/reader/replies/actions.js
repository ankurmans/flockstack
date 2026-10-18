"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { verifyReaderToken } from "@/lib/reader-links";
import Contact from "@/models/Contact";

const PER_IP = { name: "reader-replies-ip", limit: 20, window: "10 m" };

// The button on the page behind "Stop emails about replies": off, or on again. It changes only this reader's choice about
// reply emails, nothing about their subscription.
export async function setReplyEmails(formData) {
	const token = String(formData.get("token") ?? "");
	const wantsEmails = formData.get("emails") === "on";
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) return;
	const reference = verifyReaderToken("replies", token);
	if (!reference) return;
	await connectDb();
	const newsletter = await findOpenNewsletter({ _id: reference.newsletterId });
	if (!newsletter) return;
	await Contact.updateOne(
		{ accountId: newsletter.accountId, newsletterId: newsletter._id, _id: reference.contactId },
		wantsEmails ? { $unset: { "community.repliesOff": 1 } } : { $set: { "community.repliesOff": true } }
	);
	revalidatePath("/reader/replies");
}
