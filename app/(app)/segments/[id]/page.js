import { notFound } from "next/navigation";
import { isValidObjectId } from "@/lib/docdb";
import FormSegment from "@/components/FormSegment";
import HeaderPage from "@/components/HeaderPage";
import { scoped } from "@/lib/account-scope";
import { listCustomFields } from "@/lib/custom-fields";
import { toNewsletterOption } from "@/lib/newsletters";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { serialize } from "@/lib/serialize";
import Segment from "@/models/Segment";
import Tag from "@/models/Tag";

export const metadata = { title: "Segment" };

export default async function SegmentPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { account } = view;
	if (!isValidObjectId(id)) notFound();
	const segment = await Segment.findOne(scoped(account, { _id: id })).lean();
	if (!segment) notFound();
	openNewsletter(view, segment.newsletterId, `/segments/${id}`);
	const { selected } = view;
	const [fields, tags] = await Promise.all([
		listCustomFields(account, selected._id),
		Tag.find(scoped(account, { newsletterId: selected._id })).sort({ name: 1 }).select({ name: 1 }).lean(),
	]);

	return (
		<>
			<HeaderPage title={segment.name} backHref="/segments" />
			<FormSegment
				newsletter={toNewsletterOption(selected)}
				segment={{ id: String(segment._id), ...serialize({ name: segment.name, description: segment.description ?? "", rules: segment.rules }) }}
				fields={fields.map(({ key, label, type, options, multiple }) => ({ key, label, type, options: options ?? [], multiple: Boolean(multiple) }))}
				tags={tags.map(({ name }) => name)}
			/>
		</>
	);
}
