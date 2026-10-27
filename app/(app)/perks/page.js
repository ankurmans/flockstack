import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { getNewsletterTiers } from "@/lib/tier-rules";
import FormPerks from "@/components/FormPerks";
export default async function PerksPage() {
	const { selected } = await getSelectedNewsletter(); const newsletter = String(selected._id);
	const [perks, products] = await Promise.all([runDashboardAction("list_subscriber_perks", { newsletter }), runDashboardAction("list_products", { newsletter })]);
	return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6"><h1 className="text-2xl font-semibold">Subscriber perks</h1>{perks.output && products.output ? <FormPerks newsletter={newsletter} perks={perks.output.perks} products={products.output.products.filter((product) => product.file)} tiers={getNewsletterTiers(selected).map(({ id, name }) => ({ id, name }))} /> : <p>{perks.failure?.message ?? products.failure?.message}</p>}</main>;
}
