import { requireAccount } from "@/lib/auth";
import { normalizeEmail } from "@/lib/validation";
import { getTeamRole, listTeam } from "@/lib/team";
import TeamSeat from "@/models/TeamSeat";
import Account from "@/models/Account";
import { acceptInvite, changeMember, inviteMember, switchWorkspace } from "./actions";

const field = "rounded-md border bg-background px-3 py-2 text-sm";
const button = "rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted";
function Roles({ value = "editor" }) { return <select className={field} name="role" defaultValue={value}><option value="admin">Admin</option><option value="editor">Editor</option><option value="viewer">Viewer</option></select>; }
export default async function TeamPage({ searchParams }) {
	const { user, account } = await requireAccount();
	const role = await getTeamRole(account, user);
	const personal = await Account.findOne({ ownerId: user.id }).select({ _id: 1 }).lean();
	const seats = await TeamSeat.find({ $or: [{ userId: String(user.id), status: "active" }, { email: normalizeEmail(user.email), status: "invited" }] }).setOptions({ crossAccount: true }).limit(100).lean();
	const team = role === "owner" ? await listTeam(account, user) : { seats: [] };
	const { error } = await searchParams;
	return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
		<h1 className="text-2xl font-semibold">Team and workspaces</h1>
		<p className="text-sm text-muted-foreground">Current account: {String(account._id)} · {role}. Admins can manage and send. Editors write drafts. Viewers read. Keys, billing, money, approvals and exports stay with the owner. Your personal account and sign-in remain yours.</p>
		{error && <p role="alert" className="text-sm text-destructive">{String(error).slice(0, 300)}</p>}
		<h2 className="font-medium">Switch workspace</h2>
		<form action={switchWorkspace}><input type="hidden" name="account" value={String(personal._id)} /><button className={button}>My personal account</button></form>
		{seats.map((seat) => <form className="flex items-center gap-3" action={seat.status === "invited" ? acceptInvite : switchWorkspace} key={String(seat._id)}><input type="hidden" name="id" value={String(seat._id)} /><input type="hidden" name="account" value={String(seat.accountId)} /><span className="text-sm">{String(seat.accountId)} · {seat.role}</span><button className={button}>{seat.status === "invited" ? "Accept invitation" : "Switch"}</button></form>)}
		{role === "owner" && <><h2 className="font-medium">Invite a person</h2><p className="text-sm text-muted-foreground">Share this page’s address after inviting them. They sign in with the invited email and accept here. No invitation email is sent. This account can have up to 100 seats, including you.</p><form action={inviteMember} className="flex flex-wrap gap-2"><input className={field} type="email" name="email" required placeholder="person@example.com" aria-label="Email" /><Roles /><button className={button}>Invite</button></form><h2 className="font-medium">Seats</h2>{team.seats.map((seat) => <form action={changeMember} key={seat.id} className="flex flex-wrap items-center gap-2"><input type="hidden" name="id" value={seat.id} /><span className="mr-auto text-sm">{seat.email} · {seat.status}</span><Roles value={seat.role} /><button className={button}>Save role</button><button className={button} name="remove" value="true">Remove</button></form>)}</>}
	</main>;
}
