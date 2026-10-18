import CommentBody from "@/components/CommentBody";
import ToolsComment from "@/components/ToolsComment";
import { parseCommentBody } from "@/lib/comment-body";
import { formatDate } from "@/lib/format";

// One comment on an issue's page, with its replies under it. It is rendered on the server for everyone alike: what depends
// on who is reading (reply, edit, report) is ToolsComment's, once the page knows. Only a reader's display name shows.
export default function ItemComment({ comment, isReply = false }) {
	return (
		<li id={`comment-${comment.id}`} className="scroll-mt-24">
			{comment.isGone ? (
				<p className="text-sm text-muted-foreground italic">This comment was removed.</p>
			) : (
				<article aria-label={`Comment by ${comment.authorName}`}>
					<header className="flex flex-wrap items-baseline gap-x-2 text-sm">
						<span className="font-medium">{comment.authorName}</span>
						<time dateTime={comment.createdAt} className="text-muted-foreground tabular-nums">
							{formatDate(comment.createdAt)}
						</time>
						{comment.edited && <span className="text-muted-foreground">(edited)</span>}
					</header>
					<div className="mt-1.5 text-[15px] leading-relaxed text-pretty text-foreground/90">
						<CommentBody paragraphs={parseCommentBody(comment.body)} />
					</div>
					<ToolsComment id={comment.id} canReply={!isReply} />
				</article>
			)}
			{comment.replies.length > 0 && (
				<ol className="mt-4 flex flex-col gap-5 border-l border-border/70 pl-4 sm:pl-6">
					{comment.replies.map((reply) => (
						<ItemComment key={reply.id} comment={reply} isReply />
					))}
				</ol>
			)}
		</li>
	);
}
