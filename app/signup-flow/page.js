import CardNotice from "@/components/CardNotice";
import FormRecommendedSubscribe from "@/components/FormRecommendedSubscribe";
import FormSurveyResponse from "@/components/FormSurveyResponse";
import ProviderReaderLanguage from "@/components/ProviderReaderLanguage";
import { Button } from "@/components/ui/button";
import { getReaderText } from "@/lib/reader-languages";
import { readSignupFlow } from "@/lib/signup-flows";

export const dynamic = "force-dynamic";
export const metadata = { title: "After signup", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function SignupFlowPage({ searchParams }) {
	const query = await searchParams;
	const page = await readSignupFlow({ formId: typeof query.f === "string" ? query.f : "", step: typeof query.step === "string" ? query.step : "0", token: typeof query.token === "string" ? query.token : null });
	if (!page) return <main className="theme-neutral flex min-h-dvh items-center justify-center p-6"><CardNotice title="This page has expired">Open the newsletter’s signup form to continue.</CardNotice></main>;
	const t = getReaderText(page.language);
	return <ProviderReaderLanguage language={page.language}>
		<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-12">
			<div className="flex w-full max-w-md flex-col gap-4 rounded-xl bg-card p-6 shadow-border sm:p-8">
				<h1 className="text-lg font-semibold">{page.newsletterName}</h1>
				{page.isPending && <p role="status" className="text-sm text-muted-foreground">{t("Check your email to confirm your subscription.")}</p>}
				{page.survey && <section><h2 className="font-medium">{page.survey.title}</h2>{page.survey.intro && <p className="mt-2 text-sm">{page.survey.intro}</p>}<FormSurveyResponse survey={{ id: page.survey.id, questions: page.survey.questions }} token={page.survey.token} source="signup" className="mt-4" /></section>}
				{page.upgradeUrl && <section className="flex flex-col gap-3"><h2 className="font-medium">{t("Get the paid issues")}</h2><p className="text-sm text-muted-foreground">{t("See the paid plans and choose whether to upgrade.")}</p><Button asChild><a href={page.upgradeUrl}>{t("See paid plans")}</a></Button></section>}
				{page.recommendations && <FormRecommendedSubscribe step={page.recommendations} language={page.language} />}
				{((page.type === "survey" && !page.survey) || (page.type === "upsell" && !page.upgradeUrl) || (page.type === "recommendations" && !page.recommendations)) && <p className="text-sm text-muted-foreground">{t("There is no step to complete here. You can continue.")}</p>}
				<Button asChild variant="outline"><a href={page.nextUrl} rel="noopener noreferrer">{t("Continue")}</a></Button>
				{page.index + 1 < page.total && <a href={page.finishUrl} rel="noopener noreferrer" className="text-center text-sm underline underline-offset-4">{t("Skip the remaining steps")}</a>}
			</div>
		</main>
	</ProviderReaderLanguage>;
}
