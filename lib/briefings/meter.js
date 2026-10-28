import { DEFAULT_STEP_BUDGETS } from "../briefing-rules.js";
import { costOf, findPrice } from "./prices.js";

// The cost cap of one run (docs/BRIEFINGS-DESIGN.md, Cost cap): every model call is estimated before it is made and refused
// when the step's share of the budget (stepBudgets, in percent) or the run's whole budget would be passed; after it, the real
// cost is recorded from the provider's answer. A step that can do less catches the refusal and does less; one that can't ends
// the run as stopped_at_budget.
export class BudgetStop extends Error {
	constructor(message, { step, scope, estimate, left, share } = {}) {
		super(message);
		this.name = "BudgetStop";
		this.step = step;
		this.scope = scope;
		this.estimate = estimate;
		this.left = left;
		this.share = share;
	}
}

export class UnknownPrice extends Error {
	constructor(message) {
		super(message);
		this.name = "UnknownPrice";
	}
}

const CHARS_PER_TOKEN = 4;

// A text's tokens, erring high: four ASCII characters a token, but CJK and other scripts take far more tokens a character, so every
// non-ASCII character counts its UTF-8 bytes / 3 (a CJK character is about a token). A number is taken as a character count.
const BYTES_PER_TOKEN = 3;

export function estimateTokens(text) {
	if (typeof text === "number") return Math.ceil((text || 0) / CHARS_PER_TOKEN);
	const value = String(text ?? "");
	const ascii = value.replace(/[^\x00-\x7f]/g, "").length;
	const otherBytes = new TextEncoder().encode(value).length - ascii;
	return Math.ceil(ascii / CHARS_PER_TOKEN + otherBytes / BYTES_PER_TOKEN);
}

function round(value) {
	return Math.round(value * 1e8) / 1e8;
}

// calls: the run's recorded calls so far (BriefingRun.calls), added to in place.
// sectionCaps: { sectionId: USD } for a sectioned briefing (lib/briefings/sections.js): a section's extract and write calls are held
// to its cap, on top of the step's share and the run's budget.
export const SECTION_STEPS = ["extract", "write"];

export function createMeter({ budgetUsd, stepBudgets, prices, calls = [], sectionCaps = {} }) {
	const spent = () => calls.reduce((total, call) => total + (call.costUsd || 0), 0);
	const spentOnSection = (sectionId) => calls.filter((call) => call.sectionId === sectionId && SECTION_STEPS.includes(call.step)).reduce((total, call) => total + (call.costUsd || 0), 0);
	const spentOn = (step) => calls.filter((call) => call.step === step).reduce((total, call) => total + (call.costUsd || 0), 0);
	const shareOf = (step) => {
		const percent = Number.isFinite(stepBudgets?.[step]) ? stepBudgets[step] : DEFAULT_STEP_BUDGETS[step];
		return Number.isFinite(percent) ? (budgetUsd * percent) / 100 : budgetUsd;
	};

	function priceFor(provider, model) {
		const price = findPrice({ provider, model, prices });
		if (!price) throw new UnknownPrice(`No price is known for ${model} (${provider}): add its price to the briefing so the run can stay under its cap`);
		return price;
	}

	// Throws BudgetStop when the call could take the run over its budget. Answers the estimate in USD.
	// input: the text sent (or inputChars, its length, when only that is known).
	function admit({ step, provider, model, input, inputChars, maxTokens, sectionId }) {
		const price = priceFor(provider, model);
		const estimate = costOf(price, estimateTokens(input ?? inputChars), maxTokens);
		const before = spent();
		if (before + estimate > budgetUsd) {
			throw new BudgetStop(
				`Stopped before the ${step} step: it could cost about $${estimate.toFixed(4)}, and with $${before.toFixed(4)} spent the run would pass its $${Number(budgetUsd).toFixed(2)} cap. ` +
					"A run over its cap usually means the funnel widths, the style guide or the number of stories need a look.",
				{ step, scope: "run", estimate, left: Math.max(0, budgetUsd - before), share: budgetUsd }
			);
		}
		const share = shareOf(step);
		if (spentOn(step) + estimate > share) {
			throw new BudgetStop(`Stopped before a ${step} call: it could cost about $${estimate.toFixed(4)}, past the step's $${share.toFixed(4)} share of the budget.`, { step, scope: "step", estimate, left: Math.max(0, share - spentOn(step)), share });
		}
		const cap = sectionId && SECTION_STEPS.includes(step) ? sectionCaps[sectionId] : undefined;
		if (Number.isFinite(cap) && spentOnSection(sectionId) + estimate > cap) {
			throw new BudgetStop(`Stopped before a ${step} call for the ${sectionId} section: it could cost about $${estimate.toFixed(4)}, past the section's $${cap.toFixed(4)} share.`, { step, scope: "section", estimate, left: Math.max(0, cap - spentOnSection(sectionId)), share: cap });
		}
		return estimate;
	}

	// usage: { inputTokens, outputTokens, costUsd? } from the provider; costUsd is OpenRouter's own figure. A count the provider
	// left out is charged high, never as nothing: the input's estimate, and for the output the call's max_tokens or the reply's
	// own length, whichever is more.
	function record({ step, provider, model, usage = {}, input, inputChars = 0, output = "", maxTokens = 0, sectionId }) {
		const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : estimateTokens(input ?? inputChars);
		const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : Math.max(maxTokens || 0, estimateTokens(output));
		const fromProvider = Number.isFinite(usage.costUsd);
		const costUsd = round(fromProvider ? usage.costUsd : costOf(priceFor(provider, model), inputTokens, outputTokens));
		const call = { step, ...(sectionId && { sectionId }), provider, model, inputTokens, outputTokens, costUsd, costFrom: fromProvider ? "provider" : "price_table" };
		calls.push(call);
		return call;
	}

	return { admit, record, priceFor, spent: () => round(spent()), spentOn: (step) => round(spentOn(step)), spentOnSection: (sectionId) => round(spentOnSection(sectionId)), shareOf, calls };
}
