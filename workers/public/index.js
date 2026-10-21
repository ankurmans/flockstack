// FlockStack Cloud's public pages: the docs, the legal pages and the files for agents and crawlers, as they were rendered at
// deploy time by scripts/build-public.mjs (npm run build:public) into workers/public/dist. The router (workers/router) asks this
// Worker first for the paths in lib/public-routing.js and falls back to the app for anything it cannot answer. A tiny script:
// it finds the page, puts the visitor's analytics settings in the markers (lib/prerender.js) and returns the file. One deployment
// per region (flockstack-public, flockstack-public-eu), each with the files of the build its own app Worker runs.
// Cloud only. A self-hosted server answers these pages from its app.
import manifest from "./dist/manifest.json";
import { createHandler } from "./handler.js";

const worker = { fetch: createHandler(manifest) };

export default worker;
