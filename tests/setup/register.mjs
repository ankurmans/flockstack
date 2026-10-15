import { register } from "node:module";

// Lets tests import server actions, route handlers and pages as they are: the @/ alias resolves, JSX compiles, and
// Next.js request APIs, links, images and fonts, QStash, SES, DNS lookups (domain checks and imports' mail domains),
// the DNS helper, Vercel Blob, S3, CloudFront, image downloads and client metadata documents are replaced by the
// stubs in tests/stubs.
register("./hooks.mjs", import.meta.url);
