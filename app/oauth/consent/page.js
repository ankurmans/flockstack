import { redirect } from "next/navigation";
import { AppWindow, ArrowLeftRight, Check } from "lucide-react";
import { switchAccount } from "@/app/oauth/consent/actions";
import ButtonSignout from "@/components/ButtonSignout";
import FormConsent from "@/components/FormConsent";
import LogoFlockstack from "@/components/LogoFlockstack";
import { PRESET_INFO, getPresetOfScopes, getPresetsUpTo } from "@/lib/action-scopes";
import { isDeletionPending } from "@/lib/account-state";
import { getCurrentAccount } from "@/lib/auth";
import { readOAuthRequest } from "@/lib/oauth";
import { isLoopbackRedirect } from "@/lib/oauth-rules";

export const metadata = { title: "Connect an app" };

// The level a new connection starts on when the app asked for full access: the one that asks you before anything goes out.
const SUGGESTED = "send_with_approval";

// Better Auth sends people here with the app's signed authorization request when it needs their consent (and
// for prompt=select_account). The app gets at most what it asked for, at the levels of an API key; the owner can give less.
export default async function ConsentPage({ searchParams }) {
	const oauthRequest = await readOAuthRequest(await searchParams);
	if (!oauthRequest || oauthRequest.isExpired) return <Expired />;
	const current = await getCurrentAccount();
	if (!current) redirect(`/signin?${oauthRequest.query}`);
	if (isDeletionPending(current.account)) redirect("/restore");

	const { client, query, redirectUri, scopes } = oauthRequest;
	const redirectHost = getHost(redirectUri);
	const asked = getPresetOfScopes(scopes) ?? "full";
	// Highest first. An app that asked for less than full is offered no more than it asked.
	const choices = getPresetsUpTo(asked).toReversed();
	const selected = choices.includes(SUGGESTED) ? SUGGESTED : asked;
	const hasProfile = scopes.some((scope) => scope === "email" || scope === "profile");

	return (
		<main className="flex min-h-dvh items-center justify-center px-4 py-16">
			<div className="w-full max-w-sm animate-enter">
				<div className="mb-7 flex flex-col items-center gap-4 text-center">
					<div className="flex items-center gap-3 text-muted-foreground">
						<span className="grid size-10 place-items-center rounded-[9px] bg-muted shadow-border">
							<AppWindow className="size-5" />
						</span>
						<ArrowLeftRight className="size-4" />
						<LogoFlockstack className="size-10" />
					</div>
					<div className="flex flex-col gap-1">
						<h1 className="text-lg font-semibold tracking-tight text-balance">Connect {client.name} to FlockStack</h1>
						{client.host && client.host !== client.name && <p className="font-mono text-xs text-muted-foreground">{client.host}</p>}
					</div>
				</div>

				<div className="overflow-hidden rounded-xl shadow-border">
					<fieldset className="flex flex-col gap-2 p-4">
						<legend className="mb-1 text-sm font-medium">What {client.name} may do</legend>
						{choices.map((preset) => (
							<label
								key={preset}
								className="group flex cursor-pointer items-start gap-3 rounded-lg p-3 shadow-border transition-[box-shadow,background-color] duration-150 hover:shadow-border-hover has-checked:bg-muted/60 has-checked:shadow-border-hover"
							>
								<input type="radio" name="access" value={preset} form="consent" defaultChecked={preset === selected} className="mt-0.5 size-4 shrink-0 accent-foreground" />
								<span className="flex flex-col gap-1.5">
									<span className="text-sm font-medium">
										{PRESET_INFO[preset].label}
										{preset === SUGGESTED && <span className="ml-2 text-xs font-normal text-muted-foreground">Recommended</span>}
									</span>
									<span className="hidden flex-col gap-1.5 group-has-checked:flex">
										{[...PRESET_INFO[preset].consent, ...(hasProfile ? ["See your name and email address"] : [])].map((line) => (
											<span key={line} className="flex gap-2 text-xs text-pretty text-muted-foreground">
												<Check className="mt-0.5 size-3.5 shrink-0 text-foreground" />
												{line}
											</span>
										))}
									</span>
								</span>
							</label>
						))}
						<p className="text-xs text-muted-foreground">
							Same levels as an API key. You can disconnect it anytime, and approve or reject what it asks to do on the Approvals page.
						</p>
					</fieldset>
					<form action={switchAccount} className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/40 px-4 py-2.5">
						<input type="hidden" name="oauth_query" value={query} />
						<p className="min-w-0 truncate text-sm">
							<span className="text-muted-foreground">Signed in as </span>
							<span className="font-medium">{current.user.email}</span>
						</p>
						<ButtonSignout className="shrink-0">Switch</ButtonSignout>
					</form>
				</div>

				{isLoopbackRedirect(redirectUri) && (
					<p className="mt-4 text-center text-sm text-pretty text-amber-700 dark:text-amber-400">
						This app runs on your computer ({redirectHost}). Allow it only if you started this connection.
					</p>
				)}
				<div className="mt-6">
					<FormConsent oauthQuery={query} />
				</div>
				<p className="mt-4 text-center text-xs text-pretty text-muted-foreground">
					Then you go back to {redirectHost}. Disconnect it anytime on the API keys page.
				</p>
			</div>
		</main>
	);
}

function Expired() {
	return (
		<main className="flex min-h-dvh items-center justify-center px-4 py-16">
			<div className="flex w-full max-w-xs flex-col items-center gap-3 text-center animate-enter">
				<LogoFlockstack className="size-10" />
				<h1 className="text-lg font-semibold tracking-tight">This request expired</h1>
				<p className="text-sm text-pretty text-muted-foreground">Go back to the app and connect FlockStack again.</p>
			</div>
		</main>
	);
}

function getHost(value) {
	try {
		return new URL(value).host;
	} catch {
		return "the app";
	}
}
