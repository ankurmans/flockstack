import { notFound } from "next/navigation";
import { isValidObjectId } from "@/lib/docdb";
import FormSegment from "@/components/FormSegment";
import HeaderPage from "@/components/HeaderPage";
import { scoped } from "@/lib/account-scope";
import { toNewsletterOption } from "@/lib/newsletters";
import { loadSegmentChoices } from "@/lib/segment-choices";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { serialize } from "@/lib/serialize";
import Segment from "@/models/Segment";

export const metadata = { title: "Segment" };

export default async function SegmentPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { account } = view;
	if (!isValidObjectId(id)) notFound();
	const segment = await Segment.findOne(scoped(account, { _id: id })).lean();
	if (!segment) notFound();
	openNewsletter(view, segment.newsletterId, `/segments/${id}`);
	const { selected } = view;
	const choices = await loadSegmentChoices(account, selected._id);

	return (
		<>
			<HeaderPage title={segment.name} backHref="/segments" />
			<FormSegment
				newsletter={toNewsletterOption(selected)}
				segment={{
					id: String(segment._id),
					kind: segment.kind ?? "dynamic",
					status: segment.buildStatus ?? "ready",
					members: segment.memberCount ?? null,
					...serialize({ name: segment.name, description: segment.description ?? "", rules: segment.rules, savedAt: segment.snapshotAt ?? null }),
				}}
				{...choices}
			/>
		</>
	);
}
