import { notFound } from "next/navigation";
import BlockCode from "@/components/BlockCode";
import FormEmbedSettings from "@/components/FormEmbedSettings";
import HeaderPage from "@/components/HeaderPage";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { listCustomFields } from "@/lib/custom-fields";
import { getAccent } from "@/lib/editor-blocks";
import { formatNumber } from "@/lib/format";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { formatDateKey } from "@/lib/time-zone";

export const metadata = { title: "Form" };

export default async function FormPage({ params }) {
	const { id } = await params;
	const { output: form } = await runDashboardAction("get_form", { id, days: 30 });
	if (!form) notFound();
	const current = await getSelectedNewsletter();
	openNewsletter(current, form.newsletterId, `/forms/${id}`);
	const fields = await listCustomFields(current.account, form.newsletterId);
	const surveyResult = await runDashboardAction("list_surveys", { newsletter: form.newsletterId });
	const most = Math.max(1, ...form.days.map(({ views }) => views));

	return (
		<>
			<HeaderPage title={form.name} backHref="/forms" />
			<div className="grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
				<FormEmbedSettings
					newsletterId={form.newsletterId}
					form={form}
					surveys={(surveyResult.output?.surveys ?? []).filter((s) => !s.closed).map(({ id, title }) => ({ id, title }))}
					fields={fields.map(({ key, label, type, options, multiple }) => ({ key, label, type, options: options ?? [], multiple: Boolean(multiple) }))}
					accent={getAccent(current.selected)}
				/>
				<div className="flex min-w-0 flex-col gap-4">
					<section className="rounded-xl bg-card shadow-border animate-enter">
						<h2 className="flex h-12 items-center px-4 text-sm font-medium">Last 30 days</h2>
						<dl className="grid grid-cols-3 gap-px border-t border-border/60 text-center tabular-nums">
							{[
								["Views", formatNumber(form.days.reduce((sum, day) => sum + day.views, 0))],
								["Signups", formatNumber(form.days.reduce((sum, day) => sum + day.signups, 0))],
								["Conversion", form.conversion === null ? "-" : `${(form.conversion * 100).toFixed(1)}%`],
							].map(([label, value]) => (
								<div key={label} className="px-2 py-3">
									<dt className="text-xs text-muted-foreground">{label}</dt>
									<dd className="text-lg font-semibold">{value}</dd>
								</div>
							))}
						</dl>
						<div role="img" aria-label="Views for each of the last 30 days" className="flex h-16 items-end gap-0.5 border-t border-border/60 px-4 pt-3 pb-3">
							{form.days.map((day) => (
								<span key={day.date} title={`${formatDateKey(day.date)}: ${day.views} views, ${day.signups} signups`} className="flex-1 rounded-sm bg-chart-1/70" style={{ height: `${Math.max(day.views > 0 ? 6 : 2, (day.views / most) * 100)}%` }} />
							))}
						</div>
						<p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">Totals since it was made: {formatNumber(form.views)} views, {formatNumber(form.signups)} signups. Days are UTC.</p>
					</section>
					<BlockCode title="One line (recommended)" code={form.embed.script} />
					<BlockCode title="Plain HTML form" code={form.embed.html} />
					<BlockCode title="Frame, no script" code={form.embed.iframe} />
					<BlockCode title="Link to the hosted form" code={form.embed.url} />
				</div>
			</div>
		</>
	);
}
