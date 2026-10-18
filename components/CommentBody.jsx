// A comment's parts (lib/comment-body.js parseCommentBody) as elements. Every part is text React escapes, so markup a reader
// typed prints as typed; only the links the parser accepted are anchors, and they say they are the reader's.
export default function CommentBody({ paragraphs }) {
	return paragraphs.map((parts, index) => (
		<p key={index} className="not-first:mt-3 break-words">
			{parts.map((part, partIndex) => {
				if (part.type === "br") return <br key={partIndex} />;
				if (part.type === "link") {
					return (
						<a key={partIndex} href={part.href} rel="nofollow ugc noopener noreferrer" target="_blank" className="font-medium underline underline-offset-4 break-all">
							{part.text}
						</a>
					);
				}
				return part.text;
			})}
		</p>
	));
}
