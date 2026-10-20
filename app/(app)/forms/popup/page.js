import { redirect } from "next/navigation";
import FormPopup from "@/components/FormPopup";
import HeaderPage from "@/components/HeaderPage";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Pop-up" };

export default async function PopupPage() {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const newsletter = String(selected._id);
	const { output } = await runDashboardAction("get_popup_settings", { newsletter });

	return (
		<>
			<HeaderPage title="Pop-up" />
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
				<p className="text-sm text-pretty text-muted-foreground">
					The signup form your website shows over an issue, and the option to show older issues to readers who haven&apos;t subscribed only as their beginning.
				</p>
				{output && <FormPopup key={newsletter} newsletterId={newsletter} settings={output} />}
			</div>
		</>
	);
}
