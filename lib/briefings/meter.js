import { costOf, findPrice } from "./prices.js";

// The cost cap of one run (docs/BRIEFINGS-DESIGN.md, Cost cap): every model call is estimated before it is made and refused
// when the run's spend so far plus the estimate is over the briefing's budget; after it, the real cost is recorded from the
// provider's answer. A refusal ends the run as stopped_at_budget.
export class BudgetStop extends Error {
	constructor(message) {
		super(message);
		this.name = "BudgetStop";
	}
}

export class UnknownPrice extends Error {
	constructor(message) {
		super(message);
		this.name = "UnknownPrice";
	}
}

const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars) {
	return Math.ceil((chars || 0) / CHARS_PER_TOKEN);
}

function round(value) {
	return Math.round(value * 1e8) / 1e8;
}

// calls: the run's recorded calls so far (BriefingRun.calls), added to in place.
export function createMeter({ budgetUsd, prices, calls = [] }) {
	const spent = () => calls.reduce((total, call) => total + (call.costUsd || 0), 0);

	function priceFor(provider, model) {
		const price = findPrice({ provider, model, prices });
		if (!price) throw new UnknownPrice(`No price is known for ${model} (${provider}): add its price to the briefing so the run can stay under its cap`);
		return price;
	}

	// Throws BudgetStop when the call could take the run over its budget. Answers the estimate in USD.
	function admit({ step, provider, model, inputChars, maxTokens }) {
		const price = priceFor(provider, model);
		const estimate = costOf(price, estimateTokens(inputChars), maxTokens);
		const before = spent();
		if (before + estimate > budgetUsd) {
			throw new BudgetStop(
				`Stopped before the ${step} step: it could cost about $${estimate.toFixed(4)}, and with $${before.toFixed(4)} spent the run would pass its $${Number(budgetUsd).toFixed(2)} cap. ` +
					"A run over its cap usually means the style guide, the sources or the number of stories need a look."
			);
		}
		return estimate;
	}

	// usage: { inputTokens, outputTokens, costUsd? } from the provider; costUsd is OpenRouter's own figure.
	function record({ step, provider, model, usage = {}, inputChars = 0 }) {
		const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : estimateTokens(inputChars);
		const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
		const fromProvider = Number.isFinite(usage.costUsd);
		const costUsd = round(fromProvider ? usage.costUsd : costOf(priceFor(provider, model), inputTokens, outputTokens));
		const call = { step, provider, model, inputTokens, outputTokens, costUsd, costFrom: fromProvider ? "provider" : "price_table" };
		calls.push(call);
		return call;
	}

	return { admit, record, priceFor, spent: () => round(spent()), calls };
}
