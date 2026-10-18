import { MAX_DOWNLOADS_PER_ORDER, verifyDownloadToken } from "@/lib/download-link";
import { connectDb } from "@/lib/db";
import { getPrivateFile } from "@/lib/private-files";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { isObjectIdString } from "@/lib/validation";
import Order from "@/models/Order";
import Product from "@/models/Product";

const PER_IP = { name: "download-ip", limit: 60, window: "1 h" };
const SECURITY_HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

function page(status, message) {
	return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Download</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.25rem;line-height:1.5"><p>${message}</p></body>`, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
	});
}

function toAttachmentName(name) {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// A buyer's download. The link in their email is signed and expires (lib/download-link.js); on top of that the order has to
// still be paid, so a refund or a chargeback stops it, and a newer link replaces an older one. The file comes out of a
// private bucket through this route only. Opens without a session, on the newsletter's host or the app's.
export async function GET(request) {
	if (await isRateLimited({ ...PER_IP, key: getClientIp(request.headers) })) return page(429, "Too many downloads from your network. Try again in a little while.");
	const link = await verifyDownloadToken(new URL(request.url).searchParams.get("token"));
	if (!link || !isObjectIdString(link.orderId)) {
		return page(410, "This download link has expired or isn't valid. Reply to the email it came in and ask for a new one.");
	}

	await connectDb();
	const order = await Order.findOne({ _id: link.orderId }).setOptions({ crossAccount: true }).lean();
	if (!order || order.status !== "paid" || order.revokedAt || (order.tokenVersion ?? 1) !== link.version) {
		return page(410, "This download link isn't active any more. If you think that's a mistake, reply to the email it came in and ask for a new one.");
	}
	if ((order.downloadCount ?? 0) >= MAX_DOWNLOADS_PER_ORDER) return page(429, "This link has been used the most times it allows. Reply to the email it came in and ask for a new one.");
	const product = await Product.findOne({ accountId: order.accountId, _id: order.productId }).lean();
	if (!product?.file?.key) return page(404, "The file isn't available right now. Reply to the email this link came in and let the seller know.");

	const file = await getPrivateFile(product.file.key);
	if (!file) return page(404, "The file isn't available right now. Reply to the email this link came in and let the seller know.");
	await Order.updateOne({ accountId: order.accountId, _id: order._id }, { $inc: { downloadCount: 1 }, $set: { lastDownloadAt: new Date() } });
	return new Response(file.body, {
		headers: {
			...SECURITY_HEADERS,
			"content-type": product.file.contentType || "application/octet-stream",
			"content-length": String(file.size),
			"content-disposition": toAttachmentName(product.file.name || "download"),
		},
	});
}
