import { redirect } from "next/navigation";
import FormLinkPage from "@/components/FormLinkPage";
import HeaderPage from "@/components/HeaderPage";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Link page" };

// The open newsletter's link-in-bio page: what it lists, and its address on the newsletter's website.
export default async function LinkPage() {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const newsletterId = String(selected._id);
	const { output } = await runDashboardAction("get_link_page", { newsletter: newsletterId });

	return (
		<>
			<HeaderPage title="Link page" />
			<div className="mx-auto w-full max-w-2xl">{output && <FormLinkPage key={newsletterId} newsletterId={newsletterId} page={output} />}</div>
		</>
	);
}
