import { PricingNote } from "@/components/SiteExtensions";
import SliderPricing from "@/components/SliderPricing";
import TextContactUs from "@/components/TextContactUs";
import { getPricing } from "@/lib/pricing";
import { findPlansOnSale } from "@/lib/stripe";

// The plans on sale on the public pages and the billing page: a slider across them, with what every plan includes and,
// before a plan, the marketing site's note. initialPlanId and initialPeriod: where the slider starts, on the billing page
// the account's plan or the one its list fits. current and action: SliderPricing's.
export default async function ListPricing({ initialPlanId, initialPeriod, current, action }) {
	const plans = await findPlansOnSale();

	return (
		<div className="flex flex-col gap-4">
			<SliderPricing {...getPricing(initialPlanId, plans)} initialPeriod={initialPeriod} current={current} action={action}>
				{PricingNote && !current && <PricingNote />}
			</SliderPricing>
			<TextContactUs emails={plans.at(-1).emailsPerMonth} className="mt-4" />
		</div>
	);
}
