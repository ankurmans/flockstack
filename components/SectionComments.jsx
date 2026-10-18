import ItemComment from "@/components/ItemComment";
import PanelComments from "@/components/PanelComments";
import ProviderComments from "@/components/ProviderComments";
import { MAX_PUBLIC_ROOTS } from "@/lib/comment-rules";
import { formatCount } from "@/lib/format";

// The discussion under an issue on the newsletter's website. The list is the same for everyone and comes from the server;
// the sign-in, the box and each comment's tools wait for the page to know who is reading. data: lib/comments.js
// listPublicComments. restriction: a sentence for the sign-in, when only some subscribers can comment.
export default function SectionComments({ slug, post, data, restriction = "" }) {
	return (
		<section id="comments" aria-labelledby="comments-title" className="mx-auto max-w-2xl scroll-mt-24 px-5 pt-14">
			<ProviderComments slug={slug} post={post} restriction={restriction}>
				<h2 id="comments-title" className="text-xl font-semibold tracking-tight">
					Comments
					{data.total > 0 && <span className="ml-2 text-base font-normal text-muted-foreground tabular-nums">{formatCount(data.total, "comment")}</span>}
				</h2>
				<div className="mt-5">
					<PanelComments />
				</div>
				{data.comments.length === 0 ? (
					<p className="mt-8 text-sm text-muted-foreground">No comments yet.</p>
				) : (
					<>
						{data.isTrimmed && <p className="mt-8 text-sm text-muted-foreground">Showing the latest {MAX_PUBLIC_ROOTS} comments.</p>}
						<ol className="mt-8 flex flex-col gap-8">
							{data.comments.map((comment) => (
								<ItemComment key={comment.id} comment={comment} />
							))}
						</ol>
					</>
				)}
			</ProviderComments>
		</section>
	);
}
