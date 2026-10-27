import { readPublicSponsorshipAsset } from "@/lib/sponsorship-assets";
export const dynamic = "force-dynamic";
export async function GET(_request, { params }) {
	const { id, signature } = await params;
	const asset = await readPublicSponsorshipAsset(id, signature);
	if (!asset) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
	return new Response(asset.bytes, { headers: { "content-type": asset.contentType, "content-length": String(asset.bytes.length), "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}
