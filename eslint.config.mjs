import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".open-next/**",
    ".wrangler/**",
    ".worker/**",
    // The lean API Worker's build output (scripts/build-api-worker.mjs).
    "workers/api/dist/**",
    // The readers Worker's (scripts/build-readers-worker.mjs).
    "workers/readers/dist/**",
    "workers/collaboration/dist/**",
  ]),
]);

export default eslintConfig;
