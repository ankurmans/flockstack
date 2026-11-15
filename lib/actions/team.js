import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
const role = z.enum(["admin", "editor", "viewer"]).describe("Admin can manage and send; editor can read and write drafts; viewer can only read. Security, billing, money, approvals and exports remain owner-only.");
export const teamActions = [
	defineAction({ name: "select_team_workspace", whileBlocked: true, requiresPlan: false, title: "Select a workspace", group: "Team", dashboardOnly: true, description: "Switches this signed-in browser to an account this person owns or has an active seat in. Rechecks membership before setting the workspace cookie.", http: { method: "POST", path: "/team/select" }, input: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/).describe("Account ID") }), output: z.object({ selected: z.boolean() }), handler: async ({ user, input }) => (await import("@/lib/team")).selectTeamWorkspace(user, input.id) }),
	defineAction({ name: "accept_team_invitation", whileBlocked: true, requiresPlan: false, title: "Accept a team invitation", group: "Team", dashboardOnly: true, description: "Accepts an invitation only when this signed-in person's verified email matches it, then switches their browser to that workspace.", http: { method: "POST", path: "/team/accept" }, input: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/).describe("Invitation seat ID") }), output: z.object({ selected: z.boolean() }), handler: async ({ user, input }) => (await import("@/lib/team")).selectTeamWorkspace(user, input.id, { accept: true }) }),
	defineAction({ name: "list_team_members", title: "List team seats", group: "Team", readOnly: true, description: "Lists active seats and invitations. Owner only, including for delegated keys. The owner has one seat outside this list.", http: { method: "GET", path: "/team" }, output: z.object({ seats: z.array(z.object({ id: z.string(), email: z.string(), role, status: z.string(), approverFor: z.array(z.string()).describe("The newsletters whose agents' requests this person may approve") })) }), handler: async ({ account, user }) => (await import("@/lib/team")).listTeam(account, user ?? { id: String(account.ownerId) }) }),
	defineAction({ name: "invite_team_member", title: "Invite a team member", group: "Team", description: "Reserves a seat for an email. Share the returned team page address yourself; FlockStack sends no invitation email. Only a signed-in person with that verified email can accept. Up to 100 seats including the owner. Owner only.", http: { method: "POST", path: "/team" }, input: z.object({ email: z.string().email().max(254).describe("The person's sign-in email"), role }), output: z.object({ id: z.string(), status: z.string(), inviteUrl: z.string(), message: z.string() }), handler: async ({ account, user, input }) => (await import("@/lib/team")).inviteTeamMember(account, user ?? { id: String(account.ownerId) }, input) }),
	defineAction({ name: "update_team_member", whileBlocked: true, title: "Change a team seat", group: "Team", idempotent: true, description: "Owner changes a person's role or revokes their seat. Revocation is checked on each request. Ownership cannot be transferred or removed through a seat.", http: { method: "PATCH", path: "/team/{id}" }, input: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/).describe("Seat ID"), role: role.optional(), remove: z.boolean().optional().describe("Revoke this seat") }), output: z.object({ updated: z.boolean() }), handler: async ({ account, user, input }) => { if (!input.remove && !input.role) throw (await import("@/lib/actions/errors")).actionError("validation_failed", "Choose a role or remove: true"); return (await import("@/lib/team")).updateTeamMember(account, user ?? { id: String(account.ownerId) }, input); } }),
	defineAction({
		name: "set_team_approver",
		whileBlocked: true,
		title: "Name a team approver",
		group: "Team",
		idempotent: true,
		dashboardOnly: true,
		description: "Lets a team member approve or reject what API keys and connected apps ask to do on the newsletters named, whatever their role. They can't approve billing changes, change who approves or change approval settings. An empty list takes it away. Owner only, in the dashboard.",
		http: { method: "PATCH", path: "/team/{id}/approver" },
		input: z.object({
			id: z.string().regex(/^[a-f0-9]{24}$/).describe("Seat ID"),
			newsletters: z.array(z.string().trim().min(1).max(100)).max(50).describe("Newsletter IDs or slugs; empty to stop"),
		}),
		output: z.object({ approverFor: z.array(z.string()) }),
		handler: async ({ account, user, input }) => {
			const { findNewsletter } = await import("@/lib/actions/shared");
			const newsletterIds = [...new Set(await Promise.all(input.newsletters.map(async (ref) => String((await findNewsletter(account, ref, { _id: 1 }))._id))))];
			const result = await (await import("@/lib/team")).setTeamApprover(account, user, { id: input.id, newsletterIds });
			const { describePerson, recordActivity } = await import("@/lib/agent-activity");
			await recordActivity(account, {
				kind: "setting",
				...describePerson(account, user),
				via: "dashboard",
				action: "set_team_approver",
				className: "admin",
				status: "ok",
				summary: `Team approver (id: ${input.id}, newsletters: ${newsletterIds.length})`,
			});
			return result;
		},
	}),
];
