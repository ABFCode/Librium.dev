import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useStatusSync } from "../hooks/useStatusSync";
import { db } from "../lib/db";

// Wedged-push recovery for the batched, multi-row status pass: a mutation
// that never settles mid-loop must not strand the remaining dirty rows, a
// slow-but-progressing pass must NOT be abandoned (heartbeat per row), and an
// abandoned pass must not replay its stale snapshot once superseded.

const mocks = vi.hoisted(() => ({
	updateStatus: vi.fn(),
	STALL_MS: 150,
}));

vi.mock("convex/react", () => ({
	useConvexAuth: () => ({ isAuthenticated: true }),
	useQuery: () => undefined,
	useMutation: () => mocks.updateStatus,
}));

vi.mock("../lib/syncPushQueue", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../lib/syncPushQueue")>();
	class TestSyncPushQueue extends mod.SyncPushQueue {
		constructor(_stallTimeoutMs?: number, onStallAbandon?: () => void) {
			super(mocks.STALL_MS, onStallAbandon);
		}
	}
	return { ...mod, SyncPushQueue: TestSyncPushQueue };
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wake = () => window.dispatchEvent(new Event("focus"));

beforeEach(async () => {
	await db.bookStatus.clear();
	mocks.updateStatus.mockReset();
	Object.defineProperty(window.navigator, "onLine", {
		configurable: true,
		value: true,
	});
});

describe("useStatusSync wedged push recovery", () => {
	it("recovers all dirty rows after the pass wedges on the first row", async () => {
		mocks.updateStatus
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockImplementation((args: { status: string | null }) =>
				Promise.resolve({
					accepted: true,
					serverTime: 10,
					status: args.status,
				}),
			);
		await db.bookStatus.bulkPut([
			{
				bookId: "book_a",
				status: "want",
				editedAt: 1,
				dirty: 1,
				syncedServerTime: 0,
			},
			{
				bookId: "book_b",
				status: "reading",
				editedAt: 1,
				dirty: 1,
				syncedServerTime: 0,
			},
		]);
		await renderHook(() => useStatusSync({ canQuery: true }));
		// book_a's push wedges; book_b is stranded behind it in the same pass.
		await expect.poll(() => mocks.updateStatus.mock.calls.length).toBe(1);

		await wait(mocks.STALL_MS + 50);
		wake();
		await expect
			.poll(async () =>
				(await db.bookStatus.toArray()).every((row) => row.dirty === 0),
			)
			.toBe(true);
		const pushed = mocks.updateStatus.mock.calls.map(
			(call) => (call[0] as { bookId: string }).bookId,
		);
		expect(pushed.filter((id) => id === "book_a").length).toBeGreaterThan(1);
		expect(pushed).toContain("book_b");
	});

	it("does not abandon a slow pass that is making row-by-row progress", async () => {
		const ROW_MS = 100; // per-row latency: under the stall timeout per row,
		// but the 3-row pass total (300ms) is well over it.
		mocks.updateStatus.mockImplementation(
			(args: { status: string | null }) =>
				new Promise((resolve) =>
					setTimeout(
						() =>
							resolve({ accepted: true, serverTime: 20, status: args.status }),
						ROW_MS,
					),
				),
		);
		await db.bookStatus.bulkPut([
			{
				bookId: "book_a",
				status: "want",
				editedAt: 1,
				dirty: 1,
				syncedServerTime: 0,
			},
			{
				bookId: "book_b",
				status: "reading",
				editedAt: 1,
				dirty: 1,
				syncedServerTime: 0,
			},
			{
				bookId: "book_c",
				status: "finished",
				editedAt: 1,
				dirty: 1,
				syncedServerTime: 0,
			},
		]);
		await renderHook(() => useStatusSync({ canQuery: true }));
		await expect.poll(() => mocks.updateStatus.mock.calls.length).toBe(1);

		// Wake mid-pass, past the stall timeout measured from pass start. The
		// per-row heartbeat proves progress, so this must not fork a duplicate.
		await wait(mocks.STALL_MS + 70);
		wake();
		await expect
			.poll(
				async () =>
					(await db.bookStatus.toArray()).every((row) => row.dirty === 0),
				{ timeout: 5_000 },
			)
			.toBe(true);
		await wait(150); // let any wrongly-forked duplicate pass surface
		expect(mocks.updateStatus).toHaveBeenCalledTimes(3);
	});

	it("an abandoned status push that applied server-side cannot roll back a newer status", async () => {
		// Push A ("want") applies at 100 but its acknowledgement never
		// arrives. The fresh pass re-pushes the newer "finished" with A's old
		// base; the device-aware server accepts it (same device), so the
		// user's change survives.
		let resolveFirst: (value: {
			accepted: boolean;
			serverTime: number;
			status: string | null;
		}) => void = () => {};
		mocks.updateStatus
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementation((args: { status: string | null }) =>
				Promise.resolve({
					accepted: true,
					serverTime: 101,
					status: args.status,
				}),
			);
		const { result } = await renderHook(() =>
			useStatusSync({ canQuery: true }),
		);
		await result.current.setStatus("book_a", "want");
		await expect.poll(() => mocks.updateStatus.mock.calls.length).toBe(1);
		await result.current.setStatus("book_a", "finished");

		await wait(mocks.STALL_MS + 50);
		wake();
		await expect
			.poll(async () => (await db.bookStatus.get("book_a"))?.dirty)
			.toBe(0);
		const repush = mocks.updateStatus.mock.calls[1]?.[0] as {
			status: string;
			baseServerTime: number;
			deviceId?: string;
		};
		expect(repush).toEqual(
			expect.objectContaining({ status: "finished", baseServerTime: 0 }),
		);
		expect(typeof repush.deviceId).toBe("string");

		// The original push's acknowledgement finally arrives — a no-op.
		resolveFirst({ accepted: true, serverTime: 100, status: "want" });
		await wait(50);
		expect(await db.bookStatus.get("book_a")).toEqual(
			expect.objectContaining({
				status: "finished",
				dirty: 0,
				syncedServerTime: 101,
			}),
		);
	});

	it("a superseded pass stops at its next heartbeat instead of replaying stale rows", async () => {
		// Gen-1 wedges on book_a with book_b and book_c still ahead of it in
		// the same snapshot. After abandonment, gen-2 pushes all three rows.
		// When gen-1's wedged mutation finally settles, its loop must bail at
		// the next heartbeat — book_b and book_c must NOT get duplicate
		// pushes from the dead generation.
		let resolveFirst: (value: {
			accepted: boolean;
			serverTime: number;
			status: string | null;
		}) => void = () => {};
		mocks.updateStatus
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementation((args: { status: string | null }) =>
				Promise.resolve({
					accepted: true,
					serverTime: 50,
					status: args.status,
				}),
			);
		await db.bookStatus.bulkPut([
			{
				bookId: "book_a",
				status: "want",
				editedAt: 1,
				dirty: 1,
				syncedServerTime: 0,
			},
			{
				bookId: "book_b",
				status: "reading",
				editedAt: 1,
				dirty: 1,
				syncedServerTime: 0,
			},
			{
				bookId: "book_c",
				status: "finished",
				editedAt: 1,
				dirty: 1,
				syncedServerTime: 0,
			},
		]);
		await renderHook(() => useStatusSync({ canQuery: true }));
		await expect.poll(() => mocks.updateStatus.mock.calls.length).toBe(1);

		await wait(mocks.STALL_MS + 50);
		wake();
		await expect
			.poll(async () =>
				(await db.bookStatus.toArray()).every((row) => row.dirty === 0),
			)
			.toBe(true);
		// Gen-2 pushed a, b, c. Now the dead generation's mutation settles.
		resolveFirst({ accepted: true, serverTime: 49, status: "want" });
		await wait(200);
		const perBook = new Map<string, number>();
		for (const call of mocks.updateStatus.mock.calls) {
			const bookId = (call[0] as { bookId: string }).bookId;
			perBook.set(bookId, (perBook.get(bookId) ?? 0) + 1);
		}
		// book_a: gen-1's wedged push + gen-2's re-push. book_b/book_c: gen-2
		// only — the superseded loop bailed before reaching them.
		expect(perBook.get("book_a")).toBe(2);
		expect(perBook.get("book_b")).toBe(1);
		expect(perBook.get("book_c")).toBe(1);
	});
});
