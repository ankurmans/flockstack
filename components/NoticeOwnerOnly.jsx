import HeaderPage from "@/components/HeaderPage";

// A page of the account owner's that a team seat can open: the title and a sentence, nothing from the account.
export default function NoticeOwnerOnly({ title, children }) {
	return (
		<>
			<HeaderPage title={title} />
			<p className="max-w-xl text-sm text-pretty text-muted-foreground">{children}</p>
		</>
	);
}
