import { toScriptJson } from "@/lib/seo-rules";

// "<" is escaped so a title containing "</script>" can't end the tag early.
export default function ScriptJsonLd({ data }) {
	return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: toScriptJson(data) }} />;
}
