import "server-only";
import { createHash } from "node:crypto";
import { pickSplitPath } from "@/lib/automation-split";
export function chooseAutomationEmail(step, contactId) {
	if (!step?.variants?.length) return step;
	const index = step.winnerVariantId ? step.variants.findIndex((variant) => variant.id === step.winnerVariantId) : pickSplitPath(step.variants.map(({ percent }) => percent), `${step.variantSeed || step.id}:${contactId}`);
	const variant = step.variants[index]; if (!variant) return null;
	return resolveAutomationVariant(step, variant);
}
export function resolveAutomationVariant(step, variant) {
	const format = variant.format ?? step.format ?? "markdown";
	const bodyKey = format === "markdown" ? "markdown" : "html";
	const content = { ...step, subject: variant.subject ?? step.subject, previewText: variant.previewText ?? step.previewText, format, [bodyKey]: variant[bodyKey] ?? step[bodyKey] ?? "" };
	return { ...content, automationVariantId: variant.id, automationVariantName: variant.name, automationExperimentId: createHash("sha256").update(JSON.stringify([step.variantSeed || step.id, step.variants.map(({ id, percent }) => [id, percent])])).digest("hex"), automationVariantPhase: step.winnerVariantId ? "winner" : "test", automationVariantVersion: createHash("sha256").update(JSON.stringify([content.subject, content.previewText, content.format, content[bodyKey]])).digest("hex") };
}
