import { notFound } from "next/navigation";
import FormPage from "@/components/FormPage";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Page" };

export default async function WebsitePageEditor({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { output: page } = await runDashboardAction("get_page", { id });
	if (!page) notFound();
	openNewsletter(view, page.newsletterId, `/website/pages/${id}`);
	const newsletter = view.newsletters.find((item) => String(item._id) === page.newsletterId);

	return (
		<LayoutNarrow>
			<HeaderPage title={page.title} backHref="/website" />
			<FormPage key={id} page={page} urlBase={getArchiveUrls(newsletter).absolutePost("")} isWebsiteOn={Boolean(newsletter?.archiveEnabled)} />
		</LayoutNarrow>
	);
}
