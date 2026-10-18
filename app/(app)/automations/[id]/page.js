import { notFound } from "next/navigation";
import FormAutomation from "@/components/FormAutomation";
import HeaderPage from "@/components/HeaderPage";
import { scoped } from "@/lib/account-scope";
import { toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { listCustomFields } from "@/lib/custom-fields";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import Segment from "@/models/Segment";
import Tag from "@/models/Tag";

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
	const [fields, segments, tags] = await Promise.all([
		listCustomFields(account, newsletterId),
		Segment.find(scoped(account, { newsletterId })).sort({ name: 1 }).select({ name: 1 }).lean(),
		Tag.find(scoped(account, { newsletterId })).sort({ name: 1 }).select({ name: 1 }).lean(),
	]);

	return (
		<>
			<HeaderPage title={automation.name} backHref="/automations" />
			<FormAutomation
				key={`${automation.id}:${automation.updatedAt}:${automation.status}`}
				automation={automation}
				report={report}
				segments={segments.map(({ _id, name }) => ({ id: String(_id), name }))}
				dateFields={fields.filter(({ type }) => type === "date").map(({ key, label }) => ({ key, label }))}
				fields={fields.map(({ key, label }) => ({ key, label }))}
				tags={tags.map(({ name }) => name)}
			/>
		</>
	);
}
