import { drawSectionIcon } from "@/lib/card-images";
import { connectDb } from "@/lib/db";
import { getIconColor } from "@/lib/issue-card";
import { getRenderedImage } from "@/lib/rendered-images";
import { isSectionIconKey } from "@/lib/section-icons";
import Newsletter from "@/models/Newsletter";

const FILE_PATTERN = /^([a-z-]{1,20})\.png$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// A section icon for emails (docs/VISUALS-DESIGN.md): 48 by 48, transparent, in the newsletter's accent as it reads on white.
// Every newsletter of one color shares the stored file. The address carries the color (?c=), so a new accent is a new address
// and the old one is cached for a year; an address with another color gets today's, cached for an hour.
export async function GET(request, { params }) {
	const { slug, file } = await params;
	const key = FILE_PATTERN.exec(file)?.[1];
	if (!isSectionIconKey(key) || !SLUG_PATTERN.test(slug)) return new Response("Not found", { status: 404 });
	await connectDb();
	const newsletter = await Newsletter.findOne({ slug }).setOptions({ crossAccount: true }).select("accentColor").lean();
	if (!newsletter) return new Response("Not found", { status: 404 });

	const color = getIconColor(newsletter);
	const { bytes } = await getRenderedImage(`section-icons/${color}/${key}.png`, () => drawSectionIcon(key, `#${color}`));
	const isCurrent = new URL(request.url).searchParams.get("c") === color;
	return new Response(bytes, {
		headers: { "Content-Type": "image/png", "Cache-Control": isCurrent ? "public, max-age=31536000, immutable" : "public, max-age=3600, s-maxage=86400" },
	});
}
