// Writes lib/og-fonts.js: the Geist files in assets/fonts as base64, for the share images (ImageResponse).
// A Cloudflare Worker has no files to read at run time, so the fonts travel inside the bundle as a module.
// Run it again after replacing a font file:
//
//     node scripts/make-og-fonts.mjs
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const FONTS = [
	{ name: "GEIST_REGULAR", file: "assets/fonts/Geist-Regular.ttf" },
	{ name: "GEIST_SEMIBOLD", file: "assets/fonts/Geist-SemiBold.ttf" },
];

const lines = [
	"// Written by scripts/make-og-fonts.mjs from assets/fonts: Geist, under the SIL Open Font License 1.1",
	"// (assets/fonts/OFL.txt). Not edited by hand.",
];
for (const { name, file } of FONTS) {
	const data = await readFile(new URL(file, ROOT));
	lines.push(`export const ${name} = "${data.toString("base64")}";`);
}
await writeFile(new URL("lib/og-fonts.js", ROOT), `${lines.join("\n")}\n`);
console.log(`lib/og-fonts.js: ${FONTS.map(({ file }) => file).join(", ")}`);
