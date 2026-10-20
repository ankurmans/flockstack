import { notFound } from "next/navigation";
import FormAutomation from "@/components/FormAutomation";
import HeaderPage from "@/components/HeaderPage";
import { scoped } from "@/lib/account-scope";
import { toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { loadSegmentChoices } from "@/lib/segment-choices";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import Automation from "@/models/Automation";
import Product from "@/models/Product";
import Segment from "@/models/Segment";

export const metadata = { title: "Automation" };

export default async function AutomationPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { account, user } = view;
	const report = await runAction("get_automation_report", { account, user, via: "dashboard", input: { id } }).catch((error) => {
		if (toActionError(error).code === "not_found") notFound();
		throw error;
	});
	const { automation } = report;
	openNewsletter(view, automation.newsletterId, `/automations/${id}`);
	const newsletterId = automation.newsletterId;
	const [choices, segments, automations, products] = await Promise.all([
		loadSegmentChoices(account, newsletterId),
		Segment.find(scoped(account, { newsletterId, $or: [{ buildStatus: null }, { buildStatus: "ready" }] })).sort({ name: 1 }).select({ name: 1 }).lean(),
		Automation.find(scoped(account, { newsletterId, status: { $ne: "deleted" }, _id: { $ne: automation.id } })).sort({ name: 1 }).select({ name: 1 }).lean(),
		Product.find(scoped(account, { newsletterId })).sort({ title: 1 }).select({ title: 1 }).lean(),
	]);

	return (
		<>
			<HeaderPage title={automation.name} backHref="/automations" />
			<FormAutomation
				key={`${automation.id}:${automation.updatedAt}:${automation.status}`}
				automation={automation}
				report={report}
				choices={choices}
				segments={segments.map(({ _id, name }) => ({ id: String(_id), name }))}
				automations={automations.map(({ _id, name }) => ({ id: String(_id), name }))}
				products={products.map(({ _id, title }) => ({ id: String(_id), title }))}
			/>
		</>
	);
}
