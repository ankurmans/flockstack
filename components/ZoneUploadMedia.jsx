"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ATTACHMENT_EXTENSIONS } from "@/lib/attachment-files";
import { toast } from "@/lib/toast";
import { IMAGE_TYPES, uploadAttachment, uploadImageFile } from "@/lib/upload-image";

// Uploads into the folder the page shows: pictures (scaled down if big) and downloadable files, several at once.
export default function ZoneUploadMedia({ folder }) {
	const router = useRouter();
	const inputRef = useRef(null);
	const [pending, setPending] = useState(0);

	async function upload(files) {
		setPending(files.length);
		let failed = 0;
		for (const file of files) {
			try {
				if (IMAGE_TYPES.includes(file.type)) await uploadImageFile(file, { folder });
				else await uploadAttachment(file, { folder });
			} catch (error) {
				failed++;
				toast.error(`${file.name}: ${error.message}`);
			}
			setPending((count) => count - 1);
		}
		if (failed < files.length) router.refresh();
	}

	return (
		<>
			<Button onClick={() => inputRef.current?.click()} disabled={pending > 0}>
				{pending > 0 ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Upload data-icon="inline-start" />}
				{pending > 0 ? `Uploading ${pending}` : folder ? `Upload to ${folder}` : "Upload"}
			</Button>
			<input
				ref={inputRef}
				type="file"
				multiple
				hidden
				accept={[...IMAGE_TYPES, ...ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`)].join(",")}
				onChange={(event) => {
					const files = [...event.target.files];
					event.target.value = "";
					if (files.length > 0) upload(files);
				}}
			/>
		</>
	);
}
