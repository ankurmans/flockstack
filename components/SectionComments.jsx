import { getReaderText } from "@/lib/reader-languages";
import ProviderSupporterBadges from "@/components/ProviderSupporterBadges";
import ItemComment from "@/components/ItemComment";
import PanelComments from "@/components/PanelComments";
import ProviderComments from "@/components/ProviderComments";
import { MAX_PUBLIC_ROOTS } from "@/lib/comment-rules";
import ProviderReaderLanguage from "@/components/ProviderReaderLanguage";

// The discussion under an issue on the newsletter's website. The list is the same for everyone and comes from the server;
// the sign-in, the box and each comment's tools wait for the page to know who is reading. data: lib/comments.js
// listPublicComments. restriction: a sentence for the sign-in, when only some subscribers can comment.
export default function SectionComments({ slug, post, data, restriction = "", language = "en" }) {
	const t = getReaderText(language);
	return (
		<section id="comments" aria-labelledby="comments-title" className="mx-auto max-w-2xl scroll-mt-24 px-5 pt-14">
			<ProviderReaderLanguage language={language}><ProviderComments slug={slug} post={post} restriction={restriction}>
				<h2 id="comments-title" className="text-xl font-semibold tracking-tight">
					{t("Comments")}
					{data.total > 0 && <span className="ml-2 text-base font-normal text-muted-foreground tabular-nums">{t("{count} comments", { count: new Intl.NumberFormat(language).format(data.total) })}</span>}
				</h2>
				<div className="mt-5">
					<PanelComments />
				</div>
				{data.comments.length === 0 ? (
					<p className="mt-8 text-sm text-muted-foreground">{t("No comments yet.")}</p>
				) : (
					<>
						{data.isTrimmed && <p className="mt-8 text-sm text-muted-foreground">{t("Showing the latest {count} comments.", { count: MAX_PUBLIC_ROOTS })}</p>}
						<ProviderSupporterBadges slug={slug} post={post} ids={data.comments.flatMap((comment) => [comment.id, ...comment.replies.map((reply) => reply.id)])}>
						<ol className="mt-8 flex flex-col gap-8">
							{data.comments.map((comment) => (
								<ItemComment language={language} key={comment.id} comment={comment} />
							))}
						</ol></ProviderSupporterBadges>
					</>
				)}
			</ProviderComments></ProviderReaderLanguage>
		</section>
	);
}
