import { notFound } from "next/navigation";
import ButtonCopy from "@/components/ButtonCopy";
import CardSurveySummary from "@/components/CardSurveySummary";
import FormSurvey from "@/components/FormSurvey";
import HeaderPage from "@/components/HeaderPage";
import { runAction } from "@/lib/actions/run-action";
import { listCustomFields } from "@/lib/custom-fields";
import { isValidObjectId } from "@/lib/docdb";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Survey" };

// A survey's questions on the left, what readers answered on the right, through get_survey as the API reads it.
export default async function SurveyPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { account, user } = view;
	if (!isValidObjectId(id)) notFound();
	const survey = await runAction("get_survey", { account, user, input: { id }, via: "dashboard" }).catch(() => null);
	if (!survey) notFound();
	openNewsletter(view, survey.newsletterId, `/surveys/${id}`);
	const fields = await listCustomFields(account, survey.newsletterId);

	return (
		<>
			<HeaderPage title={survey.title} backHref="/surveys">
				<ButtonCopy value={survey.url} label="Copy link" />
			</HeaderPage>
			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
				<FormSurvey newsletterId={survey.newsletterId} survey={survey} fields={fields.map(({ key, label, type }) => ({ key, label, type }))} />
				<CardSurveySummary responses={survey.responses} summary={survey.summary} />
			</div>
		</>
	);
}
