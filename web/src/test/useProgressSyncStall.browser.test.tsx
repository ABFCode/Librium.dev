import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useProgressSync } from "../hooks/useProgressSync";
import { db } from "../lib/db";

// Wedged-push recovery flows: a mutation promise that never settles (frozen
// tab, half-dead websocket) must not strand dirty rows until a page reload.
// The queue is rebuilt with a test-sized stall timeout so recovery is
// observable without 15-second waits; the semantics under test are identical.
//
// The mock server implements the real device-aware acceptance rule from
// convex/syncVersion.ts: a stale-base push is rejected only when the current
// server value was authored by a different device.

const mocks = vi.hoisted(() => ({
	updateProgress: vi.fn(),
	STALL_MS: 150,
}));

vi.mock("convex/react", () => ({
	useQuery: () => null,
	useMutation: () => mocks.updateProgress,
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
const resume = () => document.dispatchEvent(new Event("visibilitychange"));
const setOnline = (value: boolean) => {
	Object.defineProperty(window.navigator, "onLine", {
		configurable: true,
		value,
	});
};

type PushResult = {
	accepted: boolean;
	serverTime: number;
	lastSectionIndex?: number;
	lastBlockIndex?: number;
	lastBlockOffset?: number;
	lastSectionFraction?: number;
};

beforeEach(async () => {
	await db.progress.clear();
	mocks.updateProgress.mockReset();
	setOnline(true);
});

describe("useProgressSync wedged push recovery", () => {
	it("abandons a wedged push on the next wake and flushes the dirty row", async () => {
		let resolveSecond: (value: PushResult) => void = () => {};
		mocks.updateProgress
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveSecond = resolve;
					}),
			);
		const { result } = await renderHook(() =>
			useProgressSync({ bookId: "book_wedge", canQuery: true }),
		);
		await result.current.saveProgress({
			sectionIndex: 5,
			blockIndex: 2,
			blockOffset: 0.5,
		});
		await expect.poll(() => mocks.updateProgress.mock.calls.length).toBe(1);

		// Pre-queue, this wake appended behind the wedged promise forever.
		await wait(mocks.STALL_MS + 50);
		wake();
		await expect
			.poll(() => mocks.updateProgress.mock.calls.length)
			.toBeGreaterThanOrEqual(2);
		expect(mocks.updateProgress.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ lastSectionIndex: 5, baseServerTime: 0 }),
		);

		resolveSecond({ accepted: true, serverTime: 40 });
		await expect
			.poll(async () => (await db.progress.get("book_wedge"))?.dirty)
			.toBe(0);
		expect((await db.progress.get("book_wedge"))?.syncedServerTime).toBe(40);
	});

	it("recovers a wedged push via the stall timer with no wake events at all", async () => {
		// The dangerous quiet case: the session's last save wedges, the tab
		// stays focused, the user stops editing. Only the queue's own timer
		// (plus the retry wake it arms) can recover.
		let resolveSecond: (value: PushResult) => void = () => {};
		mocks.updateProgress
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveSecond = resolve;
					}),
			);
		const { result } = await renderHook(() =>
			useProgressSync({ bookId: "book_timer", canQuery: true }),
		);
		await result.current.saveProgress({
			sectionIndex: 3,
			blockIndex: 0,
			blockOffset: 0,
		});
		await expect.poll(() => mocks.updateProgress.mock.calls.length).toBe(1);

		// No focus/online/visibility events and no further edits. Timer fires
		// at ~STALL_MS, abandons, arms the retry backoff (~1s), which wakes the
		// effect and schedules the fresh pass.
		await expect
			.poll(() => mocks.updateProgress.mock.calls.length, { timeout: 8_000 })
			.toBeGreaterThanOrEqual(2);
		resolveSecond({ accepted: true, serverTime: 9 });
		await expect
			.poll(async () => (await db.progress.get("book_timer"))?.dirty)
			.toBe(0);
	});

	it("grants a resumed tab a fresh grace period before declaring a wedge", async () => {
		// Suspend/freeze: a long gap with no 'online' event. During a real
		// freeze neither timers nor network run (modeled here as offline); on
		// resume, the visibilitychange must refresh the grace anchor so the
		// merely-suspended mutation is not instantly duplicated by the resume
		// wake's schedule() call.
		let resolveFirst: (value: PushResult) => void = () => {};
		mocks.updateProgress.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		);
		const { result } = await renderHook(() =>
			useProgressSync({ bookId: "book_resume", canQuery: true }),
		);
		await result.current.saveProgress({
			sectionIndex: 4,
			blockIndex: 0,
			blockOffset: 0,
		});
		await expect.poll(() => mocks.updateProgress.mock.calls.length).toBe(1);
		setOnline(false); // frozen: nothing runs, nothing is reachable

		// Resume past the stall timeout: the tab becomes visible and the
		// network is back — and the visibility wake immediately schedules.
		await wait(mocks.STALL_MS + 80);
		setOnline(true);
		resume();
		await wait(50);
		expect(mocks.updateProgress).toHaveBeenCalledTimes(1);

		// The suspended mutation settles shortly after resume, as it would
		// when the websocket comes back.
		resolveFirst({ accepted: true, serverTime: 7 });
		await expect
			.poll(async () => (await db.progress.get("book_resume"))?.dirty)
			.toBe(0);
		expect(mocks.updateProgress).toHaveBeenCalledTimes(1);
	});

	it("gives a reconnect a full grace period even after a quiet offline gap", async () => {
		setOnline(false);
		let resolveFirst: (value: PushResult) => void = () => {};
		mocks.updateProgress.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		);
		const { result } = await renderHook(() =>
			useProgressSync({ bookId: "book_offline", canQuery: true }),
		);
		await result.current.saveProgress({
			sectionIndex: 4,
			blockIndex: 0,
			blockOffset: 0,
		});
		await expect.poll(() => mocks.updateProgress.mock.calls.length).toBe(1);

		// A quiet offline gap longer than the stall timeout — no edits, no
		// wakes — then the network returns. The reconnect wake fires before
		// the Convex client has flushed its held mutation; the reconnect
		// anchor must grant a full timeout of grace instead of forking a
		// stale-base duplicate.
		await wait(mocks.STALL_MS + 80);
		setOnline(true);
		window.dispatchEvent(new Event("online"));
		await wait(50);
		expect(mocks.updateProgress).toHaveBeenCalledTimes(1);

		// The held mutation flushes shortly after reconnect, as Convex does.
		resolveFirst({ accepted: true, serverTime: 9 });
		await expect
			.poll(async () => (await db.progress.get("book_offline"))?.dirty)
			.toBe(0);
		expect(mocks.updateProgress).toHaveBeenCalledTimes(1);
	});

	it("still abandons a push that stays wedged past the reconnect grace period", async () => {
		setOnline(false);
		let resolveSecond: (value: PushResult) => void = () => {};
		mocks.updateProgress
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveSecond = resolve;
					}),
			);
		const { result } = await renderHook(() =>
			useProgressSync({ bookId: "book_regrace", canQuery: true }),
		);
		await result.current.saveProgress({
			sectionIndex: 4,
			blockIndex: 0,
			blockOffset: 0,
		});
		await expect.poll(() => mocks.updateProgress.mock.calls.length).toBe(1);

		await wait(mocks.STALL_MS + 80);
		setOnline(true);
		window.dispatchEvent(new Event("online"));
		await wait(50);
		expect(mocks.updateProgress).toHaveBeenCalledTimes(1);

		// Still unsettled a full timeout after reconnect — now it is wedged.
		await wait(mocks.STALL_MS + 50);
		wake();
		await expect
			.poll(() => mocks.updateProgress.mock.calls.length)
			.toBeGreaterThanOrEqual(2);
		resolveSecond({ accepted: true, serverTime: 9 });
		await expect
			.poll(async () => (await db.progress.get("book_regrace"))?.dirty)
			.toBe(0);
	});

	it("an abandoned push that applied server-side cannot roll back a newer edit", async () => {
		// The critical interleaving: push A (section 5) reaches the server and
		// applies, but its acknowledgement never arrives. The queue abandons
		// A; the fresh pass re-pushes the newer section 7 with A's old base.
		// The device-aware server rule accepts it — the stale base is this
		// device's own lost acknowledgement, not a conflict — so the newer
		// edit survives without any client-side echo gymnastics.
		let resolveFirst: (value: PushResult) => void = () => {};
		let resolveRepush: (value: PushResult) => void = () => {};
		mocks.updateProgress
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveRepush = resolve;
					}),
			);
		const { result } = await renderHook(() =>
			useProgressSync({ bookId: "book_rollback", canQuery: true }),
		);
		await result.current.saveProgress({
			sectionIndex: 5,
			blockIndex: 2,
			blockOffset: 0.5,
		});
		await expect.poll(() => mocks.updateProgress.mock.calls.length).toBe(1);
		// Newer edit lands while A is still (apparently) in flight.
		await result.current.saveProgress({
			sectionIndex: 7,
			blockIndex: 1,
			blockOffset: 0,
		});

		await wait(mocks.STALL_MS + 50);
		wake();
		await expect
			.poll(() => mocks.updateProgress.mock.calls.length)
			.toBeGreaterThanOrEqual(2);
		const repush = mocks.updateProgress.mock.calls[1]?.[0] as {
			lastSectionIndex: number;
			baseServerTime: number;
			deviceId?: string;
		};
		expect(repush).toEqual(
			expect.objectContaining({ lastSectionIndex: 7, baseServerTime: 0 }),
		);
		// The client identifies itself so the server can apply the rule.
		expect(typeof repush.deviceId).toBe("string");

		// Same device → the server accepts despite the stale base.
		resolveRepush({ accepted: true, serverTime: 101 });
		await expect
			.poll(async () => (await db.progress.get("book_rollback"))?.dirty)
			.toBe(0);

		// The original push's acknowledgement finally arrives — a no-op.
		resolveFirst({ accepted: true, serverTime: 100 });
		await wait(50);
		expect(await db.progress.get("book_rollback")).toEqual(
			expect.objectContaining({
				sectionIndex: 7,
				dirty: 0,
				syncedServerTime: 101,
			}),
		);
	});

	it("a genuine foreign conflict still adopts the server's newer position", async () => {
		// Server-wins semantics must survive the redesign: a rejection now
		// always means another device holds a newer position.
		mocks.updateProgress.mockImplementationOnce(() =>
			Promise.resolve({
				accepted: false,
				serverTime: 200,
				lastSectionIndex: 15,
				lastBlockIndex: 4,
				lastBlockOffset: 0.5,
				lastSectionFraction: 0.75,
			}),
		);
		const { result } = await renderHook(() =>
			useProgressSync({ bookId: "book_foreign", canQuery: true }),
		);
		await result.current.saveProgress({
			sectionIndex: 2,
			blockIndex: 0,
			blockOffset: 0,
		});
		await expect
			.poll(async () => (await db.progress.get("book_foreign"))?.dirty)
			.toBe(0);
		expect(await db.progress.get("book_foreign")).toEqual(
			expect.objectContaining({
				sectionIndex: 15,
				blockIndex: 4,
				syncedServerTime: 200,
			}),
		);
	});

	it("converges under randomized edits, delays, lost acks, wedges, and foreign writes", async () => {
		// Deterministic LCG so failures reproduce.
		let seed = 0xc0ffee;
		const rand = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		// Model server implementing the real device-aware acceptance rule.
		const server = {
			time: 0,
			sectionIndex: 0,
			blockIndex: 0,
			blockOffset: 0,
			sectionFraction: 0,
			writerDevice: undefined as string | undefined,
		};
		const foreignWrite = () => {
			server.time += 1;
			server.sectionIndex = 500 + Math.floor(rand() * 100);
			server.blockIndex = 0;
			server.blockOffset = 0;
			server.sectionFraction = 0;
			server.writerDevice = "foreign-device";
		};
		let chaos = true;
		mocks.updateProgress.mockImplementation(
			(args: {
				baseServerTime?: number;
				deviceId?: string;
				lastSectionIndex?: number;
				lastBlockIndex?: number;
				lastBlockOffset?: number;
				lastSectionFraction?: number;
			}) => {
				// Convex executes a delivered mutation on arrival (FIFO per
				// client); only the RESPONSE can be delayed — or lost entirely,
				// the applied-but-unacknowledged case the device rule resolves.
				const stale = (args.baseServerTime ?? 0) < server.time;
				const sameDevice =
					args.deviceId !== undefined && server.writerDevice === args.deviceId;
				let result: PushResult;
				if (stale && !sameDevice) {
					result = {
						accepted: false,
						serverTime: server.time,
						lastSectionIndex: server.sectionIndex,
						lastBlockIndex: server.blockIndex,
						lastBlockOffset: server.blockOffset,
						lastSectionFraction: server.sectionFraction,
					};
				} else {
					server.time += 1;
					server.sectionIndex = args.lastSectionIndex ?? 0;
					server.blockIndex = args.lastBlockIndex ?? 0;
					server.blockOffset = args.lastBlockOffset ?? 0;
					server.sectionFraction = args.lastSectionFraction ?? 0;
					server.writerDevice = args.deviceId;
					result = { accepted: true, serverTime: server.time };
				}
				return new Promise<PushResult>((resolve) => {
					if (chaos && rand() < 0.25) {
						return; // ack lost — applied but never confirmed
					}
					setTimeout(() => resolve(result), 5 + rand() * 40);
				});
			},
		);

		const { result } = await renderHook(() =>
			useProgressSync({ bookId: "book_chaos", canQuery: true }),
		);
		for (let step = 1; step <= 30; step++) {
			const roll = rand();
			if (roll < 0.5) {
				await result.current.saveProgress({
					sectionIndex: step,
					blockIndex: step % 4,
					blockOffset: 0,
				});
			} else if (roll < 0.7) {
				foreignWrite();
			} else {
				wake();
			}
			await wait(5 + rand() * 30);
		}

		// Phase 2a: quiesce — no more lost acks or foreign writes; drain until
		// every dirty row settled (acceptance or foreign-conflict adoption).
		chaos = false;
		await expect
			.poll(
				async () => {
					wake();
					return (await db.progress.get("book_chaos"))?.dirty;
				},
				{ timeout: 15_000, interval: 200 },
			)
			.toBe(0);

		// Phase 2b: one final edit on a fully-synced row must win cleanly.
		await result.current.saveProgress({
			sectionIndex: 777,
			blockIndex: 1,
			blockOffset: 0,
		});
		await expect
			.poll(
				async () => {
					wake();
					return (await db.progress.get("book_chaos"))?.dirty;
				},
				{ timeout: 15_000, interval: 200 },
			)
			.toBe(0);
		const row = await db.progress.get("book_chaos");
		expect(server.sectionIndex).toBe(777);
		expect(row?.sectionIndex).toBe(777);
		expect(row?.syncedServerTime).toBe(server.time);
	});
});
