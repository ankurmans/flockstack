import { toCsv } from "./report-rules.js";

// Every report as CSV: one table each, named by `table`, with the rows the page shows. Rates are fractions from 0 to 1.
function rate(value) {
	return value === null || value === undefined ? "" : value;
}

export const REPORT_TABLES = {
	growth: ["series", "breakdown"],
	issues: ["issues"],
	site: ["daily", "referrers", "devices", "countries", "pages"],
};

export function getGrowthCsv(report, table) {
	if (table === "breakdown") {
		const columns = [
			["group", (row) => row.label],
			["new", (row) => row.new],
			["still_subscribed", (row) => row.active],
			["retention", (row) => rate(row.retention)],
			...report.buckets.map(({ key }, index) => [key, (row) => row.series[index]]),
		];
		return { csv: toCsv(columns, report.groups), rows: report.groups.length, filename: `growth-${report.by}-${report.from}-to-${report.to}.csv` };
	}
	const columns = [
		["period", (row) => row.key],
		["new", (row) => row.new],
		["left", (row) => row.left],
		["net", (row) => row.net],
		["total", (row) => row.total],
	];
	return { csv: toCsv(columns, report.buckets), rows: report.buckets.length, filename: `growth-by-${report.granularity}-${report.from}-to-${report.to}.csv` };
}

export function getIssuesCsv(issues) {
	const columns = [
		["subject", (row) => row.subject],
		["sent_at", (row) => row.sentAt],
		["audience", (row) => row.audience],
		["sent", (row) => row.sent],
		["delivered", (row) => row.delivered],
		["opened", (row) => row.opened],
		["open_rate", (row) => rate(row.openRate)],
		["clicked", (row) => row.clicked],
		["click_rate", (row) => rate(row.clickRate)],
		["unsubscribed", (row) => row.unsubscribed],
		["unsubscribe_rate", (row) => rate(row.unsubscribeRate)],
		["bounced", (row) => row.bounced],
		["complained", (row) => row.complained],
		["web_views", (row) => row.webViews],
		["top_link", (row) => row.topLink?.url ?? ""],
		["top_link_unique_clicks", (row) => row.topLink?.uniqueClicks ?? ""],
	];
	return { csv: toCsv(columns, issues), rows: issues.length, filename: "issues.csv" };
}

export function getSiteCsv(report, table) {
	const name = `site-${table}-${report.from}-to-${report.to}.csv`;
	if (table === "referrers") return { csv: toCsv([["referrer", (row) => row.referrer], ["views", (row) => row.views]], report.referrers), rows: report.referrers.length, filename: name };
	if (table === "devices") return { csv: toCsv([["device", (row) => row.device], ["views", (row) => row.views]], report.devices), rows: report.devices.length, filename: name };
	if (table === "countries") return { csv: toCsv([["country", (row) => row.country], ["views", (row) => row.views]], report.countries), rows: report.countries.length, filename: name };
	if (table === "pages") {
		const columns = [["issue", (row) => row.title], ["address", (row) => row.slug], ["views", (row) => row.views]];
		return { csv: toCsv(columns, report.pages), rows: report.pages.length, filename: name };
	}
	const columns = [["date", (row) => row.date], ["views", (row) => row.views], ["visitors", (row) => row.visitors]];
	return { csv: toCsv(columns, report.daily), rows: report.daily.length, filename: name };
}
