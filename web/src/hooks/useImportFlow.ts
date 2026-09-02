import { useConvex, useConvexAuth, useMutation } from "convex/react";
import { useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { sha256Hex } from "../lib/contentHash";
import {
	convertTextOffThread,
	isTextImport,
} from "../lib/convertTextOffThread";
import { db, deleteLocalBook, saveImportedBook } from "../lib/db";
import { payloadToLocalBookInput } from "../lib/localBook";
import { parseEpubOffThread } from "../lib/parseEpubOffThread";
import { ensurePersistentStorage } from "../lib/persistentStorage";
import { isQuotaExceededError, quotaErrorMessage } from "../lib/quotaErrors";
import { uploadBookAsset } from "../lib/uploadBookAsset";

export type QueueStatus = "queued" | "importing" | "done" | "failed";

export type QueueItem = {
	id: string;
	file: File;
	status: QueueStatus;
	title?: string;
	error?: string;
	// Import succeeded, but with a caveat (e.g. the cover didn't upload).
	warning?: string;
};

const fileKey = (f: File) => `${f.name}-${f.size}-${f.lastModified}`;

export const useImportFlow = () => {
	const importDb = db;
	const convex = useConvex();
	const { isAuthenticated } = useConvexAuth();
	const registerImport = useMutation(api.books.registerImport);
	const [queue, setQueue] = useState<QueueItem[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isUploading, setIsUploading] = useState(false);
	const runningRef = useRef(false);
	// Queued items removed after a run started. submit() iterates a snapshot,
	// so it consults this before starting each item.
	const removedRef = useRef(new Set<string>());

	// Files still waiting to be imported (kept for compatibility with callers).
	const files = queue.filter((q) => q.status === "queued").map((q) => q.file);

	const setItem = (id: string, patch: Partial<QueueItem>) => {
		setQueue((prev) =>
			prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
		);
	};

	// Direct-to-R2 upload under a structured key (books/{bookId}/…).
	const uploadToR2 = (bookId: string, kind: "epub" | "cover", blob: Blob) =>
		uploadBookAsset(convex, bookId, kind, blob);

	const importOne = async (file: File) => {
		let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
		const textImport = isTextImport(file.name);

		// .txt/.md webnovel rips become real EPUBs first (spine text ingestion,
		// off-thread) and then ride the exact same pipeline — R2 gets a proper
		// EPUB, so seeding/export/metadata all work identically.
		if (textImport) {
			bytes = await convertTextOffThread(bytes, file.name);
		}
		// fileName keeps the source's name (provenance); fileSize describes the
		// bytes actually stored in R2 — for text imports that's the converted
		// EPUB, not the original rip.
		const storedSize = bytes.byteLength;
		const contentHash = await sha256Hex(bytes);
		// Blob construction snapshots the bytes before the EPUB buffer is
		// transferred to the parser worker. That avoids a second full in-memory
		// structured-clone while retaining an immutable upload/retry source.
		const epubBlob = new Blob([bytes as BlobPart], {
			type: "application/epub+zip",
		});

		// Parse entirely in the browser, off the main thread — a 2,000-chapter
		// webnovel no longer freezes the import UI. Original EPUBs can be re-read
		// from File if the worker chunk fails; generated text EPUBs retain the
		// existing non-transfer fallback to avoid converting twice.
		const payload = await parseEpubOffThread(
			bytes,
			textImport
				? undefined
				: {
						transfer: true,
						fallbackBytes: async () => new Uint8Array(await file.arrayBuffer()),
					},
		);
		const m = payload.metadata;

		// Register metadata first — the book exists (and is readable locally,
		// below) before any blob upload starts. The quota pre-check can refuse
		// here (nothing created yet); map it with the file's size so "this
		// book can never fit" reads differently from "storage is full".
		let bookId: string;
		let alreadyAttached = false;
		try {
			const registration = await registerImport({
				fileName: file.name,
				fileSize: storedSize,
				sectionCount: payload.sections.length,
				contentHash,
				metadata: {
					title: m.title,
					author:
						m.authors && m.authors.length > 0
							? m.authors.join(", ")
							: undefined,
					language: m.language,
					publisher: m.publisher,
					publishedAt: m.publishedAt,
					series: m.series,
					seriesIndex: m.seriesIndex,
					subjects: m.subjects,
					identifiers: m.identifiers,
				},
			});
			bookId = registration.bookId as unknown as string;
			alreadyAttached = registration.alreadyAttached;
		} catch (err) {
			const mapped = quotaErrorMessage(err, storedSize);
			throw mapped ? new Error(mapped) : err;
		}

		// Local-first: the parsed book lands in IndexedDB immediately.
		try {
			await saveImportedBook(
				payloadToLocalBookInput(bookId, payload),
				importDb,
			);
			if (!alreadyAttached) {
				await importDb.pendingUploads.put({
					bookId,
					fileName: file.name,
					blob: epubBlob,
					updatedAt: Date.now(),
				});
			} else {
				// A previous attempt may have finalized remotely and crashed before
				// deleting its local staging row. Registration is the confirmation.
				await importDb.pendingUploads.delete(bookId);
			}
			// Content now lives on this device — ask to keep it (the browser's
			// prompt reads clearly here, unlike at login).
			ensurePersistentStorage();
		} catch {
			// IndexedDB unavailable — the R2 backup below still works.
		}

		// Backup the master copy (raw EPUB + cover) to R2. Each upload is
		// verified and attached server-side (finalizeUpload) — quota is
		// enforced on the size R2 actually reports.
		try {
			if (!alreadyAttached) {
				await uploadToR2(bookId, "epub", epubBlob);
				await importDb.pendingUploads.delete(bookId).catch(() => {});
			}
		} catch (err) {
			if (isQuotaExceededError(err)) {
				// A quota rejection is deterministic (retrying won't help), so a
				// half-created book must not survive it: without this cleanup the
				// metadata row syncs to every device as a phantom that can never
				// seed, and re-importing the file would create a duplicate.
				await convex
					.action(api.books.deleteBook, { bookId: bookId as never })
					.catch(() => {});
				await deleteLocalBook(bookId, importDb).catch(() => {});
				throw new Error(
					quotaErrorMessage(err, storedSize) ?? "Cloud storage is full.",
				);
			}
			// Non-quota failures keep the local book and its staged raw EPUB. The
			// library's pending-upload sync retries this exact book ID later.
			await importDb.pendingUploads
				.update(bookId, {
					lastError: err instanceof Error ? err.message : "Cloud backup failed",
					updatedAt: Date.now(),
				})
				.catch(() => {});
			throw err;
		}
		// Cover problems must never fail an import whose EPUB is already
		// attached — the book is fully usable, and marking it "failed" invites
		// a retry that would create a duplicate. Surface a warning instead.
		let warning: string | undefined;
		if (!alreadyAttached && payload.cover) {
			try {
				const coverType = payload.cover.contentType || "image/jpeg";
				const { coverStamp } = await uploadToR2(
					bookId,
					"cover",
					new Blob([payload.cover.bytes as BlobPart], { type: coverType }),
				);
				// Stamp the local cover with the server's coverUpdatedAt. Without
				// this the library reconcile sees coverVersion=undefined <
				// remote.coverUpdatedAt, drops the just-saved blob, and re-downloads
				// the identical bytes from R2.
				if (coverStamp) {
					await importDb.books
						.update(bookId, { coverVersion: coverStamp })
						.catch(() => {});
				}
			} catch (err) {
				warning = `Imported without its cover — ${
					quotaErrorMessage(err) ??
					(err instanceof Error ? err.message : "the cover upload failed")
				}`;
			}
		}

		return { title: m.title || file.name, warning };
	};

	const submit = async () => {
		if (runningRef.current) {
			return;
		}
		const pending = queue.filter((q) => q.status === "queued");
		if (pending.length === 0) {
			setError("Select at least one book file.");
			return;
		}
		if (!isAuthenticated) {
			setError("Please sign in to upload books.");
			return;
		}
		runningRef.current = true;
		setIsUploading(true);
		setError(null);
		// Sequential: one book at a time keeps memory bounded (parse runs in a
		// worker now, but each payload is large) and failures isolated per file.
		for (const item of pending) {
			if (removedRef.current.has(item.id)) {
				continue;
			}
			setItem(item.id, { status: "importing" });
			try {
				const { title, warning } = await importOne(item.file);
				setItem(item.id, { status: "done", title, warning });
			} catch (err) {
				setItem(item.id, {
					status: "failed",
					error:
						quotaErrorMessage(err) ??
						(err instanceof Error ? err.message : "Import failed"),
				});
			}
		}
		setIsUploading(false);
		runningRef.current = false;
	};

	const addFiles = (incoming: FileList | File[]) => {
		const next = Array.from(incoming).filter(
			(file) =>
				file.name.toLowerCase().endsWith(".epub") || isTextImport(file.name),
		);
		if (next.length === 0) {
			setError("Only EPUB, .txt, and .md files are supported.");
			return;
		}
		setError(null);
		setQueue((prev) => {
			const seen = new Set(prev.map((item) => fileKey(item.file)));
			const merged = [...prev];
			for (const file of next) {
				const key = fileKey(file);
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push({
					id: `${key}-${merged.length}`,
					file,
					status: "queued",
				});
			}
			return merged;
		});
	};

	const clearFinished = () => {
		setQueue((prev) =>
			prev.filter(
				(item) => item.status === "queued" || item.status === "importing",
			),
		);
	};

	// Only items that have not started can be removed; an in-flight import is
	// allowed to finish (its half-done state is retried by the library's
	// pending-upload sync, not abandoned).
	const removeQueued = (id: string) => {
		removedRef.current.add(id);
		setQueue((prev) =>
			prev.filter((item) => !(item.id === id && item.status === "queued")),
		);
	};

	const clearQueued = () => {
		setQueue((prev) => {
			for (const item of prev) {
				if (item.status === "queued") {
					removedRef.current.add(item.id);
				}
			}
			return prev.filter((item) => item.status !== "queued");
		});
	};

	return {
		queue,
		files,
		isDragging,
		setIsDragging,
		error,
		setError,
		isUploading,
		isAuthenticated,
		submit,
		addFiles,
		clearFinished,
		removeQueued,
		clearQueued,
	};
};
