import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";
import mongoose from "@/lib/docdb";
import { activate, startTestApp } from "./helpers/app.mjs";
import { AGENT, MCP_URL, createOAuthHarness, loadOAuthRoutes } from "./helpers/oauth-flow.mjs";

// Several MCP client sessions share one login, so a refresh token that was already used reaches the server again.
let app;
let h;

const refresh = (refreshToken) => h.postToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: AGENT.clientId, resource: MCP_URL });

async function connected(email) {
	const user = await h.customer(email);
	await activate(user);
	const { client, provider } = await h.connectApp(user);
	await client.close();
	return provider.saved.tokens;
}

const refreshTokens = () => mongoose.connection.db.collection("oauthRefreshToken");

before(async () => {
	app = await startTestApp();
	h = createOAuthHarness(await loadOAuthRoutes());
});

after(() => app?.stop());

describe("refresh token reuse", () => {
	test("a used token is answered again for ten minutes, with the tokens the first refresh issued", async () => {
		const tokens = await connected("replay-window@example.com");
		const first = await refresh(tokens.refresh_token);
		assert.equal(first.status, 200, JSON.stringify(first.body));

		const [row] = await refreshTokens().find({ rotationReplayExpiresAt: { $exists: true } }).toArray();
		const seconds = (new Date(row.rotationReplayExpiresAt) - new Date(row.rotatedAt ?? row.revoked)) / 1000;
		assert.ok(seconds > 590 && seconds <= 600, `the replay window is ten minutes, not ${seconds} seconds`);

		const again = await refresh(tokens.refresh_token);
		assert.equal(again.status, 200, JSON.stringify(again.body));
		assert.equal(again.body.refresh_token, first.body.refresh_token, "the same answer, not a second rotation");
		assert.equal((await h.mcpRequest(again.body.access_token)).status, 200);
	});

	test("past the window the refusal is logged and the login's tokens are dropped", async () => {
		const tokens = await connected("replay-expired@example.com");
		const first = await refresh(tokens.refresh_token);
		assert.equal(first.status, 200, JSON.stringify(first.body));
		await refreshTokens().updateMany({ rotatedAt: { $exists: true } }, { $set: { rotationReplayExpiresAt: new Date(Date.now() - 1000) } });

		const warn = mock.method(console, "warn", () => {});
		try {
			const stale = await refresh(tokens.refresh_token);
			assert.equal(stale.status, 400);
			assert.equal(stale.body.error, "invalid_grant");
			const logged = warn.mock.calls.map(({ arguments: args }) => args.join(" "));
			assert.ok(logged.some((line) => line.includes("refresh_token grant was refused as invalid_grant") && line.includes(AGENT.clientId)), logged.join("\n"));
			assert.ok(!logged.some((line) => line.includes(tokens.refresh_token)), "no token in the log");
		} finally {
			warn.mock.restore();
		}

		assert.equal((await refresh(first.body.refresh_token)).status, 400, "the whole login has to connect again");
	});
});
