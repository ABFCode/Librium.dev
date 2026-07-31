// Serializes sync push passes and recovers from a wedged in-flight pass.
//
// The pre-queue pattern (`tail = tail.then(pass)`) had a failure mode observed
// on mobile: a mutation promise that never settles (tab frozen mid-flight, or
// a half-dead websocket the client has not noticed) blocks the chain forever.
// Every later wake appended behind the stuck promise, so no dirty row pushed
// again until a full page reload — devices silently diverged.
//
// Rules:
// - Passes serialize: at most one pass of the current generation runs, and
//   passes scheduled while one is in flight queue behind it (a liveQuery
//   emission landing mid-pass must enqueue, not drop).
// - A pass in flight longer than stallTimeoutMs of apparently-online,
//   apparently-awake time is abandoned: a new generation starts and the next
//   pass runs immediately. Passes still queued behind the abandoned one
//   no-op, and the abandoned pass's heartbeat() returns false so multi-row
//   loops stop instead of replaying stale rows against the new generation.
// - Stall detection is both lazy (every schedule() call) and timer-driven: a
//   timer armed while a pass is in flight abandons a wedge even when no edit
//   or wake event ever calls schedule() again, then notifies onStallAbandon
//   so the owner can arm a wake that schedules the fresh pass.
// - While offline, a pending pass is never stalled — the Convex client
//   legitimately holds mutations until reconnect. Reconnect ('online') and
//   resume ('pageshow', tab becoming visible) refresh a shared grace anchor,
//   so a mutation held through an offline gap or a frozen/suspended tab gets
//   a full timeout of awake-online time before being called wedged.
// - Multi-row passes call heartbeat() per row; a pass demonstrably advancing
//   is not stalled no matter how long it runs in total.
//
// Abandonment never cancels the old pass, so an abandoned mutation MAY have
// been applied server-side without this client ever seeing the ack. That
// ambiguity is resolved SERVER-side, not here: versioned mutations accept a
// stale-base write when the current server value was authored by the same
// device (convex/syncVersion.ts rejectsStaleBase) — a device's own
// unacknowledged write is never a conflict. Client response handlers can
// therefore treat every rejection as a genuine foreign conflict and adopt
// the echoed server state.

export const SYNC_PUSH_STALL_TIMEOUT_MS = 15_000;

// heartbeat() refreshes the stall clock and reports whether this pass is
// still current — abandoned passes must stop work when it returns false.
export type SyncPushPass = (heartbeat: () => boolean) => Promise<void>;

const apparentlyOnline = () =>
	typeof navigator === "undefined" || navigator.onLine !== false;

// Shared grace anchor: the last moment the page reconnected or resumed from
// a frozen/suspended state. Time before this moment must not count toward a
// stall — held mutations deserve a full timeout of awake-online time first.
let lastResumeAt = 0;
if (typeof window !== "undefined") {
	const refresh = () => {
		lastResumeAt = Date.now();
	};
	window.addEventListener("online", refresh);
	window.addEventListener("pageshow", refresh);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			refresh();
		}
	});
}

export class SyncPushQueue {
	private tail: Promise<void> = Promise.resolve();
	private generation = 0;
	private inFlightSince: number | null = null;
	private stallTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly stallTimeoutMs: number = SYNC_PUSH_STALL_TIMEOUT_MS,
		// Fired when the stall TIMER abandons a wedged pass. Unlike the
		// schedule() path (where a fresh pass is being scheduled anyway), the
		// timer path has nothing queued — the owner should arm a sync wake so
		// a fresh pass follows.
		private readonly onStallAbandon?: () => void,
	) {}

	private isStalled(): boolean {
		return (
			this.inFlightSince !== null &&
			apparentlyOnline() &&
			Date.now() - Math.max(this.inFlightSince, lastResumeAt) >=
				this.stallTimeoutMs
		);
	}

	private abandon(): void {
		this.generation += 1;
		this.tail = Promise.resolve();
		this.inFlightSince = null;
		this.clearStallTimer();
	}

	private clearStallTimer(): void {
		if (this.stallTimer !== null) {
			clearTimeout(this.stallTimer);
			this.stallTimer = null;
		}
	}

	private armStallTimer(): void {
		this.clearStallTimer();
		this.stallTimer = setTimeout(() => {
			this.stallTimer = null;
			if (this.inFlightSince === null) {
				return;
			}
			if (!this.isStalled()) {
				// Offline, resumed recently, or the heartbeat moved — check again
				// after another full grace period.
				this.armStallTimer();
				return;
			}
			this.abandon();
			try {
				this.onStallAbandon?.();
			} catch {
				// Never let a wake callback break the queue.
			}
		}, this.stallTimeoutMs);
	}

	schedule(pass: SyncPushPass): void {
		if (this.isStalled()) {
			this.abandon();
		} else if (this.inFlightSince !== null && !apparentlyOnline()) {
			// Pending while offline is expected; only count apparently-online
			// time toward the stall.
			this.inFlightSince = Date.now();
		}
		const gen = this.generation;
		this.tail = this.tail
			.then(async () => {
				if (gen !== this.generation) {
					return;
				}
				this.inFlightSince = Date.now();
				this.armStallTimer();
				const heartbeat = () => {
					if (gen !== this.generation) {
						return false;
					}
					this.inFlightSince = Date.now();
					return true;
				};
				try {
					await pass(heartbeat);
				} finally {
					if (gen === this.generation) {
						this.inFlightSince = null;
						this.clearStallTimer();
					}
				}
			})
			.catch(() => {});
	}
}
