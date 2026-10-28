import { WEB_FONT_FAMILIES } from "@/lib/archive-fonts";
import { getSiteCss } from "@/lib/site-themes";

// The theme's colors, the accent and the fonts for one newsletter's website. Everything in it is a constant or a checked
// #rrggbb (lib/brand.js), never text a writer typed.
export default function StyleSite({ newsletter, only }) {
	return <style dangerouslySetInnerHTML={{ __html: getSiteCss(newsletter, { only, webFonts: WEB_FONT_FAMILIES }) }} />;
}
