import { redirect } from "next/navigation";
import FormSegment from "@/components/FormSegment";
import HeaderPage from "@/components/HeaderPage";
import { toNewsletterOption } from "@/lib/newsletters";
import { loadSegmentChoices } from "@/lib/segment-choices";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "New segment" };

export default async function NewSegmentPage() {
	const { account, selected } = await getSelectedNewsletter();
	if (!selected) redirect("/segments");
	const choices = await loadSegmentChoices(account, selected._id);

	return (
		<>
			<HeaderPage title="New segment" backHref="/segments" />
			<FormSegment newsletter={toNewsletterOption(selected)} segment={null} {...choices} />
		</>
	);
}
