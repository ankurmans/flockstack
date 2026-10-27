import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
	plugins: [cloudflareTest({
		wrangler: { configPath: "./workers/collaboration/wrangler.jsonc" },
		miniflare: {
			bindings: { APP_URL: "https://example.com", COLLABORATION_ENABLED: "true", BETTER_AUTH_SECRET: "synthetic-native-editor-secret-32-characters", EDITOR_TEST_SCHEMA: execFileSync(process.execPath, ["scripts/docdb-schema.mjs"], { encoding: "utf8" }) },
			d1Databases: { TEST_DB: "editor-authority-test-db" },
			serviceBindings: { AUTHORITY: { name: "editor-authority-test", entrypoint: "Authority" }, REAL_AUTHORITY: { name: "editor-real-authority", entrypoint: "CollaborationAuthority" } },
			workers: [{ name: "editor-real-authority", modules: true, script: readFileSync(new URL("./workers/api/dist/index.js", import.meta.url), "utf8"), compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], bindings: { COLLABORATION_ENABLED: "true", FLOCKSTACK_CLOUD: "true", BETTER_AUTH_SECRET: "synthetic-native-editor-secret-32-characters" }, d1Databases: { DB: "editor-authority-test-db" } }, { name: "editor-authority-test", modules: true, script: readFileSync(new URL("./tests/native/editor-authority.js", import.meta.url), "utf8"), compatibilityDate: "2026-09-01" }],
		},
	})],
	test: { include: ["tests/native/*.spec.js"], testTimeout: 15000, server: { deps: { inline: ["linkedom", "@acemir/cssom"] } } },
});
