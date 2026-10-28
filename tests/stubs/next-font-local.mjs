// next build serves a local font from the build's media folder; in tests, each one is a family named after its file.
export default function localFont({ src, variable = "" } = {}) {
	const file = String(Array.isArray(src) ? src[0]?.path : src).split("/").pop().replace(/\.\w+$/, "");
	return { className: "", variable, style: { fontFamily: `'${file}', '${file} Fallback'` } };
}
