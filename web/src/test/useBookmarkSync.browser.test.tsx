import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useBookmarkSync } from "../hooks/useBookmarkSync";
import { db } from "../lib/db";

const mocks = vi.hoisted(() => ({
	createBookmark: vi.fn(),
	deleteBookmark: vi.fn(),
	// Swapped per test: the remote listByUserBook result the hook sees.
	remote: undefined as undefined | Record<string, unknown>[],
}));

vi.mock("convex/react", async () => {
	const { getFunctionName } = await import("convex/server");
	const { api } = await import("../../convex/_generated/api");
	const nameOf = (ref: unknown) => getFunctionName(ref as never);
	return {
		useQuery: () => mocks.remote,
		useMutation: (ref: unknown) =>
			nameOf(ref) === nameOf(api.bookmarks.createBookmark)
				? mocks.createBookmark
				: mocks.deleteBookmark,
	};
});

beforeEach(async () => {
	await db.bookmarks.clear();
	mocks.createBookmark.mockReset();
	mocks.deleteBookmark.mockReset();
	mocks.deleteBookmark.mockResolvedValue(undefined);
	mocks.remote = undefined;
});

describe("useBookmarkSync in-flight operations", () => {
	it("pushes a delete that lands while its create request is in flight", async () => {
		let resolveCreate: (id: string) => void = () => {};
		mocks.createBookmark.mockImplementation(
			() =>
				new Promise<string>((resolve) => {
					resolveCreate = resolve;
				}),
		);
		const { result } = await renderHook(() =>
			useBookmarkSync({ bookId: "book_a", canQuery: true }),
		);

		const clientKey = await result.current.createBookmark({
			sectionIndex: 1,
			blockIndex: 2,
			offset: 0.25,
		});
		expect(clientKey).toEqual(expect.any(String));
		await expect.poll(() => mocks.createBookmark.mock.calls.length).toBe(1);
		const local = await db.bookmarks.toCollection().first();
		expect(local).toBeDefined();
		expect(
			await result.current.deleteBookmark(local?.clientKey ?? "missing"),
		).toBe(true);
		resolveCreate("bookmark_1");

		await expect.poll(() => mocks.deleteBookmark.mock.calls.length).toBe(1);
		expect(mocks.deleteBookmark).toHaveBeenCalledWith({
			bookmarkId: "bookmark_1",
		});
		// The pushed delete keeps a clean local tombstone (resurrection guard);
		// the merge purges it once the server-side tombstone is observed.
		await expect
			.poll(async () => (await db.bookmarks.toCollection().first())?.dirty)
			.toBe(0);
		const tombstone = await db.bookmarks.toCollection().first();
		expect(tombstone?.deletedAt).toBeGreaterThan(0);
	});
});

describe("useBookmarkSync delete resurrection", () => {
	it("a pushed delete survives a stale remote emission that still lists the bookmark alive", async () => {
		mocks.createBookmark.mockResolvedValue("bm_stale_1");
		const { result, rerender } = await renderHook(() =>
			useBookmarkSync({ bookId: "book_stale", canQuery: true }),
		);
		const clientKey = await result.current.createBookmark({
			sectionIndex: 2,
			blockIndex: 1,
			offset: 0.5,
		});
		await expect
			.poll(async () => (await db.bookmarks.get(clientKey ?? ""))?.convexId)
			.toBe("bm_stale_1");

		await result.current.deleteBookmark(clientKey ?? "missing");
		await expect.poll(() => mocks.deleteBookmark.mock.calls.length).toBe(1);
		// The tombstone is kept (clean) until the merge sees the server-side
		// tombstone — deleting it now would open the resurrection window.
		await expect
			.poll(async () => (await db.bookmarks.get(clientKey ?? ""))?.dirty)
			.toBe(0);
		expect(
			(await db.bookmarks.get(clientKey ?? ""))?.deletedAt,
		).toBeGreaterThan(0);

		// A STALE emission from before the delete: the bookmark is still alive
		// in it. It must not resurrect — neither in the durable store nor in
		// the rendered list.
		mocks.remote = [
			{
				_id: "bm_stale_1",
				clientKey,
				sectionIndex: 2,
				blockIndex: 1,
				offset: 0.5,
				createdAt: 111,
			},
		];
		await rerender();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(result.current.bookmarks).toHaveLength(0);
		expect(
			(await db.bookmarks.get(clientKey ?? ""))?.deletedAt,
		).toBeGreaterThan(0);

		// The fresh emission carries the server-side tombstone: local row purged.
		mocks.remote = [
			{
				_id: "bm_stale_1",
				clientKey,
				sectionIndex: 2,
				blockIndex: 1,
				offset: 0.5,
				createdAt: 111,
				deletedAt: 222,
			},
		];
		await rerender();
		await expect
			.poll(async () => await db.bookmarks.get(clientKey ?? ""))
			.toBeUndefined();
		expect(result.current.bookmarks).toHaveLength(0);
	});
});
