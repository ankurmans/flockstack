import { redirect } from "next/navigation";
import CardSnippets from "@/components/CardSnippets";
import CardTemplates from "@/components/CardTemplates";
import FormDefaultStyle from "@/components/FormDefaultStyle";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { runAction } from "@/lib/actions/run-action";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { DEFAULT_ACCENT } from "@/lib/editor-blocks";

export const metadata = { title: "Templates" };

// What a new issue starts from, through list_templates, list_snippets and get_newsletter as the API reads them.
export default async function TemplatesPage() {
	const { account, user, selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const input = { newsletter: String(selected._id) };
	const [{ templates }, { snippets }, newsletter] = await Promise.all([
		runAction("list_templates", { account, user, input, via: "dashboard" }),
		runAction("list_snippets", { account, user, input, via: "dashboard" }),
		runAction("get_newsletter", { account, user, input: { id: String(selected._id) }, via: "dashboard" }),
	]);
	const newsletterId = String(selected._id);

	return (
		<LayoutNarrow>
			<HeaderPage title="Templates" />
			<div className="flex flex-col gap-4">
				<CardTemplates key={`templates-${newsletterId}`} newsletterId={newsletterId} templates={templates} />
				<CardSnippets key={`snippets-${newsletterId}`} newsletterId={newsletterId} snippets={snippets} />
				<FormDefaultStyle
					key={`style-${newsletterId}`}
					newsletterId={newsletterId}
					defaultStyle={newsletter.defaultStyle}
					accentColor={newsletter.accentColor || DEFAULT_ACCENT}
				/>
			</div>
		</LayoutNarrow>
	);
}
