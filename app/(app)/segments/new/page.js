import { redirect } from "next/navigation";
import FormSegment from "@/components/FormSegment";
import HeaderPage from "@/components/HeaderPage";
import { scoped } from "@/lib/account-scope";
import { listCustomFields } from "@/lib/custom-fields";
import { toNewsletterOption } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import Tag from "@/models/Tag";

export const metadata = { title: "New segment" };

export default async function NewSegmentPage() {
	const { account, selected } = await getSelectedNewsletter();
	if (!selected) redirect("/segments");
	const [fields, tags] = await Promise.all([
		listCustomFields(account, selected._id),
		Tag.find(scoped(account, { newsletterId: selected._id })).sort({ name: 1 }).select({ name: 1 }).lean(),
	]);

	return (
		<>
			<HeaderPage title="New segment" backHref="/segments" />
			<FormSegment
				newsletter={toNewsletterOption(selected)}
				segment={null}
				fields={fields.map(({ key, label, type, options, multiple }) => ({ key, label, type, options: options ?? [], multiple: Boolean(multiple) }))}
				tags={tags.map(({ name }) => name)}
			/>
		</>
	);
}
