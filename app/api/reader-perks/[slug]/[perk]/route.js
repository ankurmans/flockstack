import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { findSessionReader } from "@/lib/reader-session";
import { canReadPerk } from "@/lib/perk-rules";
import { getPrivateFile, safeFileName } from "@/lib/private-files";
import { scoped } from "@/lib/account-scope";
import { isRateLimited } from "@/lib/rate-limit";
import { limitKey } from "@/lib/reader-links";
import Product from "@/models/Product";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(_request, { params }) {
	await connectDb(); const { slug, perk: id } = await params;
	const newsletter = await findOpenNewsletter({ slug, archiveEnabled: true });
	if (!newsletter) return new Response("Not found", { status: 404, headers });
	const contact = await findSessionReader(newsletter); const perk = (newsletter.perks ?? []).find((perk) => perk.id === id);
	if (!perk || !canReadPerk(newsletter, contact, perk) || !perk.productId) return new Response("Not found", { status: 404, headers });
	if (await isRateLimited({ name: "perk-download", key: limitKey(`${newsletter._id}:${contact._id}`), limit: 30, window: "1 h" })) return new Response("Try again later", { status: 429, headers });
	const product = await Product.findOne(scoped(newsletter.accountId, { _id: perk.productId, newsletterId: newsletter._id })).lean();
	const object = product?.file?.key ? await getPrivateFile(product.file.key) : null;
	if (!object) return new Response("Not found", { status: 404, headers });
	return new Response(object.body, { headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${safeFileName(product.file.name)}"`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" } });
}
