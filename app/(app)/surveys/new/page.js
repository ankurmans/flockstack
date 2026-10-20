import { redirect } from "next/navigation";
import FormSurvey from "@/components/FormSurvey";
import HeaderPage from "@/components/HeaderPage";
import { listCustomFields } from "@/lib/custom-fields";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "New survey" };

export default async function NewSurveyPage() {
	const { account, selected } = await getSelectedNewsletter();
	if (!selected) redirect("/surveys");
	const fields = await listCustomFields(account, selected._id);

	return (
		<>
			<HeaderPage title="New survey" backHref="/surveys" />
			<div className="max-w-3xl">
				<FormSurvey newsletterId={String(selected._id)} survey={null} fields={fields.map(({ key, label, type }) => ({ key, label, type }))} />
			</div>
		</>
	);
}
