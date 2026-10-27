export const MAX_EMAIL_VARIANTS = 4;
export function readEmailVariants(step, { where, complete, maxBytes }) {
	if (!step.variants?.length) {
		if (step.winnerVariantId) return { problem: `${where}: a winner needs email variants` };
		return { fields: {} };
	}
	if (step.variants.length < 2 || step.variants.length > MAX_EMAIL_VARIANTS) return { problem: `${where}: an email test has 2 to 4 variants` };
	const given = step.variants.filter((variant) => variant.percent !== undefined).length;
	if (given && given !== step.variants.length) return { problem: `${where}: give every email variant a percent, or none` };
	if (given && step.variants.reduce((sum, { percent }) => sum + percent, 0) !== 100) return { problem: `${where}: email variant percentages add up to 100` };
	const ids = new Set(); const variants = []; const share = Math.floor(100 / step.variants.length);
	let bytes = new TextEncoder().encode(step.content ?? "").byteLength;
	for (const [index, variant] of step.variants.entries()) {
		const id = variant.id ?? String.fromCharCode(97 + index);
		if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || ids.has(id)) return { problem: `${where}: email variant IDs must be unique letters, digits, - and _` };
		ids.add(id);
		if (variant.format && variant.format !== (step.format ?? "markdown") && variant.content === undefined) return { problem: `${where}: a different variant format needs its content` };
		if (complete && !(variant.subject ?? step.subject)?.trim()) return { problem: `${where}: each email variant needs a subject` };
		if (complete && !(variant.content ?? step.content)?.trim()) return { problem: `${where}: each email variant needs content` };
		const format = variant.format ?? step.format ?? "markdown";
		bytes += new TextEncoder().encode(variant.content ?? "").byteLength;
		variants.push({ id, name: variant.name?.trim() || `Variant ${String.fromCharCode(65 + index)}`, percent: variant.percent ?? (index === 0 ? 100 - share * (step.variants.length - 1) : share), ...(variant.subject !== undefined && { subject: variant.subject.trim() }), ...(variant.previewText !== undefined && { previewText: variant.previewText.trim() }), ...(variant.format !== undefined && { format }), ...(variant.content !== undefined && { [format === "markdown" ? "markdown" : "html"]: variant.content }) });
	}
	if (bytes > maxBytes) return { problem: `${where}: the base email and variant bodies together exceed ${maxBytes} bytes` };
	if (step.winnerVariantId && !ids.has(step.winnerVariantId)) return { problem: `${where}: choose a winner from this email's variants` };
	return { fields: { variants, ...(step.variantSeed && { variantSeed: step.variantSeed }), ...(step.winnerVariantId && { winnerVariantId: step.winnerVariantId }) } };
}
export function toVariantOutput(variant) {
	return { id: variant.id, name: variant.name, percent: variant.percent, ...(variant.subject !== undefined && { subject: variant.subject }), ...(variant.previewText !== undefined && { previewText: variant.previewText }), ...(variant.format !== undefined && { format: variant.format }), ...(variant.markdown !== undefined && { content: variant.markdown }), ...(variant.html !== undefined && { content: variant.html }) };
}
