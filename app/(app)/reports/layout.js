import NavSub from "@/components/NavSub";

const TABS = [
	{ href: "/reports", label: "Growth", except: ["/reports/issues", "/reports/site", "/reports/revenue"] },
	{ href: "/reports/issues", label: "Issues" },
	{ href: "/reports/site", label: "Website" },
	{ href: "/reports/revenue", label: "Revenue" },
];

export default function ReportsLayout({ children }) {
	return (
		<>
			<NavSub items={TABS} label="Reports" />
			{children}
		</>
	);
}
