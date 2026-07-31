import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SYNC_PUSH_STALL_TIMEOUT_MS,
	type SyncPushPass,
	SyncPushQueue,
} from "../lib/syncPushQueue";

// The queue itself uses no timers — stall detection is evaluated lazily at
// schedule() time from Date.now(). Faking only Date keeps real setTimeout
// available for flushing microtasks.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const BASE = 1_000_000;
const advanceTo = (offsetMs: number) => vi.setSystemTime(BASE + offsetMs);

function makePass() {
	const pass = {
		starts: 0,
		settle: () => {},
		fail: () => {},
		beat: (() => true) as () => boolean,
		run: undefined as unknown as SyncPushPass,
	};
	pass.run = (heartbeat) => {
		pass.starts += 1;
		pass.beat = heartbeat;
		return new Promise<void>((resolve, reject) => {
			pass.settle = resolve;
			pass.fail = () => reject(new Error("pass failed"));
		});
	};
	return pass;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(BASE);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("SyncPushQueue serialization", () => {
	it("runs passes serially in schedule order", async () => {
		const queue = new SyncPushQueue();
		const a = makePass();
		const b = makePass();
		queue.schedule(a.run);
		queue.schedule(b.run);
		await flush();
		expect(a.starts).toBe(1);
		expect(b.starts).toBe(0);

		a.settle();
		await flush();
		expect(b.starts).toBe(1);
	});

	it("keeps the chain alive after a pass rejects", async () => {
		const queue = new SyncPushQueue();
		const a = makePass();
		const b = makePass();
		queue.schedule(a.run);
		await flush();
		a.fail();
		await flush();

		queue.schedule(b.run);
		await flush();
		expect(b.starts).toBe(1);
	});
});

describe("SyncPushQueue stall recovery", () => {
	it("abandons a wedged pass after the stall timeout and starts the next pass immediately", async () => {
		const queue = new SyncPushQueue();
		const wedged = makePass();
		const next = makePass();
		queue.schedule(wedged.run);
		await flush();
		expect(wedged.starts).toBe(1);

		advanceTo(SYNC_PUSH_STALL_TIMEOUT_MS + 1);
		queue.schedule(next.run);
		await flush();
		expect(next.starts).toBe(1);
	});

	it("does not abandon a pass before the stall timeout", async () => {
		const queue = new SyncPushQueue();
		const wedged = makePass();
		const next = makePass();
		queue.schedule(wedged.run);
		await flush();

		advanceTo(SYNC_PUSH_STALL_TIMEOUT_MS - 1);
		queue.schedule(next.run);
		await flush();
		expect(next.starts).toBe(0);
	});

	it("never runs passes that were queued behind an abandoned pass", async () => {
		const queue = new SyncPushQueue();
		const wedged = makePass();
		const stranded = makePass();
		const fresh = makePass();
		queue.schedule(wedged.run);
		queue.schedule(stranded.run);
		await flush();

		advanceTo(SYNC_PUSH_STALL_TIMEOUT_MS + 1);
		queue.schedule(fresh.run);
		await flush();
		expect(fresh.starts).toBe(1);

		// The wedged pass finally settles: the stranded pass behind it must
		// no-op, not run concurrently with (or after) the fresh generation.
		wedged.settle();
		await flush();
		expect(stranded.starts).toBe(0);
	});

	it("treats an offline pending pass as waiting, not stalled", async () => {
		vi.stubGlobal("navigator", { onLine: false });
		const queue = new SyncPushQueue();
		const pending = makePass();
		const next = makePass();
		queue.schedule(pending.run);
		await flush();

		// Far past the timeout, but offline: the Convex client legitimately
		// holds mutations until reconnect — never duplicate.
		advanceTo(SYNC_PUSH_STALL_TIMEOUT_MS * 4);
		queue.schedule(next.run);
		await flush();
		expect(next.starts).toBe(0);

		// Back online: the offline schedule() pushed the stall clock forward,
		// so reconnect gets a full timeout of grace before abandonment.
		vi.stubGlobal("navigator", { onLine: true });
		queue.schedule(next.run);
		await flush();
		expect(next.starts).toBe(0);

		advanceTo(SYNC_PUSH_STALL_TIMEOUT_MS * 5 + 1);
		const fresh = makePass();
		queue.schedule(fresh.run);
		await flush();
		expect(fresh.starts).toBe(1);
	});

	it("does not abandon a pass that reports progress via heartbeat", async () => {
		const queue = new SyncPushQueue();
		const long = makePass();
		const next = makePass();
		queue.schedule(long.run);
		await flush();

		advanceTo(10_000);
		long.beat();
		advanceTo(10_000 + SYNC_PUSH_STALL_TIMEOUT_MS - 1);
		queue.schedule(next.run);
		await flush();
		expect(next.starts).toBe(0);

		advanceTo(10_000 + SYNC_PUSH_STALL_TIMEOUT_MS + 1);
		queue.schedule(next.run);
		await flush();
		expect(next.starts).toBe(1);
	});

	it("ignores a late settlement from an abandoned pass", async () => {
		const queue = new SyncPushQueue();
		const wedged = makePass();
		const current = makePass();
		queue.schedule(wedged.run);
		await flush();

		advanceTo(SYNC_PUSH_STALL_TIMEOUT_MS + 1);
		queue.schedule(current.run);
		await flush();
		expect(current.starts).toBe(1);

		// The abandoned pass settles while the current pass is in flight. That
		// must not clear the current pass's stall clock (or the current pass
		// could never itself be abandoned if it wedges).
		wedged.settle();
		await flush();
		advanceTo(2 * (SYNC_PUSH_STALL_TIMEOUT_MS + 1));
		const fresh = makePass();
		queue.schedule(fresh.run);
		await flush();
		expect(fresh.starts).toBe(1);
	});

	it("does not fire onStallAbandon from the schedule path (a fresh pass is already coming)", async () => {
		const onStallAbandon = vi.fn();
		const queue = new SyncPushQueue(SYNC_PUSH_STALL_TIMEOUT_MS, onStallAbandon);
		const clean = makePass();
		queue.schedule(clean.run);
		await flush();
		clean.settle();
		await flush();
		const failed = makePass();
		queue.schedule(failed.run);
		await flush();
		failed.fail();
		await flush();

		const wedged = makePass();
		const next = makePass();
		queue.schedule(wedged.run);
		await flush();
		advanceTo(SYNC_PUSH_STALL_TIMEOUT_MS + 1);
		queue.schedule(next.run);
		await flush();
		expect(next.starts).toBe(1);
		expect(onStallAbandon).not.toHaveBeenCalled();
	});

	it("heartbeat reports whether the pass is still the current generation", async () => {
		const queue = new SyncPushQueue();
		const wedged = makePass();
		const next = makePass();
		queue.schedule(wedged.run);
		await flush();
		expect(wedged.beat()).toBe(true);

		advanceTo(SYNC_PUSH_STALL_TIMEOUT_MS + 1);
		queue.schedule(next.run);
		await flush();
		// The abandoned pass must learn it was superseded and stop replaying
		// its stale snapshot; the fresh pass is current.
		expect(wedged.beat()).toBe(false);
		expect(next.beat()).toBe(true);
	});

	it("ignores a late heartbeat from an abandoned pass", async () => {
		const queue = new SyncPushQueue();
		const wedged = makePass();
		const current = makePass();
		queue.schedule(wedged.run);
		await flush();

		advanceTo(SYNC_PUSH_STALL_TIMEOUT_MS + 1);
		queue.schedule(current.run);
		await flush();
		expect(current.starts).toBe(1);

		// A heartbeat from the abandoned pass must not vouch for the current
		// pass — if the current pass is itself wedged, it must still abandon.
		advanceTo(2 * SYNC_PUSH_STALL_TIMEOUT_MS + 4);
		wedged.beat();
		const fresh = makePass();
		queue.schedule(fresh.run);
		await flush();
		expect(fresh.starts).toBe(1);
	});
});

describe("SyncPushQueue timer-driven stall recovery", () => {
	// These tests need real clocks: the stall timer is a real setTimeout and
	// the queue reads Date.now() when it fires.
	const TIMEOUT = 40;
	const realWait = (ms: number) =>
		new Promise((resolve) => setTimeout(resolve, ms));

	it("abandons a wedged pass with no further schedule() calls and fires onStallAbandon", async () => {
		vi.useRealTimers();
		const onStallAbandon = vi.fn();
		const queue = new SyncPushQueue(TIMEOUT, onStallAbandon);
		const wedged = makePass();
		queue.schedule(wedged.run);
		await flush();
		expect(wedged.starts).toBe(1);

		// No edits, no wakes — only the timer can notice the wedge.
		await realWait(TIMEOUT * 3);
		expect(onStallAbandon).toHaveBeenCalledTimes(1);
		expect(wedged.beat()).toBe(false);

		// The wake armed by onStallAbandon leads to a schedule(); the fresh
		// pass must start immediately, not queue behind the wedge.
		const fresh = makePass();
		queue.schedule(fresh.run);
		await flush();
		expect(fresh.starts).toBe(1);
	});

	it("never fires onStallAbandon for a pass that settles in time", async () => {
		vi.useRealTimers();
		const onStallAbandon = vi.fn();
		const queue = new SyncPushQueue(TIMEOUT, onStallAbandon);
		const pass = makePass();
		queue.schedule(pass.run);
		await flush();
		pass.settle();
		await flush();

		await realWait(TIMEOUT * 3);
		expect(onStallAbandon).not.toHaveBeenCalled();
	});

	it("holds the timer while offline and abandons only after online time", async () => {
		vi.useRealTimers();
		vi.stubGlobal("navigator", { onLine: false });
		const onStallAbandon = vi.fn();
		const queue = new SyncPushQueue(TIMEOUT, onStallAbandon);
		const held = makePass();
		queue.schedule(held.run);
		await flush();

		// Far past the timeout, but offline: the held mutation is the Convex
		// client legitimately waiting for reconnect.
		await realWait(TIMEOUT * 4);
		expect(onStallAbandon).not.toHaveBeenCalled();

		vi.stubGlobal("navigator", { onLine: true });
		await realWait(TIMEOUT * 3);
		expect(onStallAbandon).toHaveBeenCalledTimes(1);
	});
});
