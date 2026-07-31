import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

// Device-aware stale-base acceptance, end to end through the real mutations:
// a write whose base is stale only because this same device's earlier write
// was never acknowledged (frozen tab, dead websocket, reload mid-flight) must
// be accepted — rejecting it lets a device's own echo roll back its newer
// edit. A stale write from ANOTHER device must still reject (server-wins).

const modules = import.meta.glob("../../convex/**/*.{js,ts}");

const SUBJECT = "user-device-rule";
const DEVICE_A = "device-a";
const DEVICE_B = "device-b";

async function seed() {
	const t = convexTest(schema, modules);
	const bookId = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", {
			authProvider: "better-auth",
			externalId: SUBJECT,
			createdAt: 1,
		});
		return ctx.db.insert("books", {
			ownerId: userId,
			title: "Device Rule Book",
			createdAt: 1,
			updatedAt: 1,
		});
	});
	return { t, as: t.withIdentity({ subject: SUBJECT }), bookId };
}

describe("updateProgress device rule", () => {
	test("accepts a stale-base push whose current value this device authored", async () => {
		const { as, bookId } = await seed();
		// The applied-but-unacknowledged write: device A landed section 5 but
		// never learned its serverTime.
		const lost = await as.mutation(api.userBooks.updateProgress, {
			bookId,
			lastSectionIndex: 5,
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		expect(lost.accepted).toBe(true);
		// A's re-push of its newer edit still carries base 0.
		const repush = await as.mutation(api.userBooks.updateProgress, {
			bookId,
			lastSectionIndex: 7,
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		expect(repush.accepted).toBe(true);
		const row = await as.query(api.userBooks.getUserBook, { bookId });
		expect(row?.lastSectionIndex).toBe(7);
	});

	test("still rejects a stale-base push against another device's value", async () => {
		const { as, bookId } = await seed();
		const b = await as.mutation(api.userBooks.updateProgress, {
			bookId,
			lastSectionIndex: 11,
			baseServerTime: 0,
			deviceId: DEVICE_B,
		});
		expect(b.accepted).toBe(true);
		const stale = await as.mutation(api.userBooks.updateProgress, {
			bookId,
			lastSectionIndex: 6,
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		expect(stale.accepted).toBe(false);
		expect(stale.lastSectionIndex).toBe(11);
		const row = await as.query(api.userBooks.getUserBook, { bookId });
		expect(row?.lastSectionIndex).toBe(11);
	});

	test("a missing deviceId keeps strict rejection (old clients)", async () => {
		const { as, bookId } = await seed();
		await as.mutation(api.userBooks.updateProgress, {
			bookId,
			lastSectionIndex: 5,
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		const stale = await as.mutation(api.userBooks.updateProgress, {
			bookId,
			lastSectionIndex: 7,
			baseServerTime: 0,
		});
		expect(stale.accepted).toBe(false);
	});
});

describe("updateStatus device rule", () => {
	test("accepts a stale-base status whose current value this device authored", async () => {
		const { as, bookId } = await seed();
		const lost = await as.mutation(api.userBooks.updateStatus, {
			bookId,
			status: "want",
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		expect(lost.accepted).toBe(true);
		const repush = await as.mutation(api.userBooks.updateStatus, {
			bookId,
			status: "finished",
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		expect(repush.accepted).toBe(true);
		const row = await as.query(api.userBooks.getUserBook, { bookId });
		expect(row?.status).toBe("finished");
	});

	test("still rejects a stale-base status against another device's value", async () => {
		const { as, bookId } = await seed();
		await as.mutation(api.userBooks.updateStatus, {
			bookId,
			status: "finished",
			baseServerTime: 0,
			deviceId: DEVICE_B,
		});
		const stale = await as.mutation(api.userBooks.updateStatus, {
			bookId,
			status: "want",
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		expect(stale.accepted).toBe(false);
		expect(stale.status).toBe("finished");
	});
});

describe("userSettings device rule", () => {
	test("accepts a stale-base field whose current value this device authored", async () => {
		const { as } = await seed();
		const lost = await as.mutation(api.userSettings.upsert, {
			theme: "paper",
			baseVersions: { theme: 0 },
			deviceId: DEVICE_A,
		});
		expect(lost.accepted.theme).toBe(true);
		const repush = await as.mutation(api.userSettings.upsert, {
			theme: "sepia",
			baseVersions: { theme: 0 },
			deviceId: DEVICE_A,
		});
		expect(repush.accepted.theme).toBe(true);
		expect(repush.settings.theme).toBe("sepia");
	});

	test("rejects a stale-base field against another device, per field", async () => {
		const { as } = await seed();
		const b = await as.mutation(api.userSettings.upsert, {
			theme: "paper",
			fontScale: 2,
			baseVersions: { theme: 0, fontScale: 0 },
			deviceId: DEVICE_B,
		});
		expect(b.accepted.theme).toBe(true);
		// Device A's stale theme loses; its current-base fontScale write wins.
		const mixed = await as.mutation(api.userSettings.upsert, {
			theme: "sepia",
			fontScale: 3,
			baseVersions: { theme: 0, fontScale: b.serverVersions.fontScale },
			deviceId: DEVICE_A,
		});
		expect(mixed.accepted.theme).toBe(false);
		expect(mixed.settings.theme).toBe("paper");
		expect(mixed.accepted.fontScale).toBe(true);
		expect(mixed.settings.fontScale).toBe(3);
	});

	test("acceptance still normalizes values (echoed back for adoption)", async () => {
		const { as } = await seed();
		const result = await as.mutation(api.userSettings.upsert, {
			fontScale: 99,
			theme: "day",
			baseVersions: { fontScale: 0, theme: 0 },
			deviceId: DEVICE_A,
		});
		expect(result.accepted.fontScale).toBe(true);
		expect(result.settings.fontScale).toBe(10);
		expect(result.settings.theme).toBe("night");
	});
});

describe("collections device rule", () => {
	async function seedCollection(as: Awaited<ReturnType<typeof seed>>["as"]) {
		const created = await as.mutation(api.collections.createCollection, {
			name: "Shelf",
			clientKey: "col-1",
		});
		return created;
	}

	test("rename: accepts a same-device stale base, rejects a foreign one", async () => {
		const { as } = await seed();
		const created = await seedCollection(as);
		const lost = await as.mutation(api.collections.renameCollection, {
			collectionId: created.id,
			name: "Shelf A",
			baseServerTime: created.serverTime,
			deviceId: DEVICE_A,
		});
		expect(lost.accepted).toBe(true);
		// Same device, base never rebased past its own lost rename → accepted.
		const repush = await as.mutation(api.collections.renameCollection, {
			collectionId: created.id,
			name: "Shelf A2",
			baseServerTime: created.serverTime,
			deviceId: DEVICE_A,
		});
		expect(repush.accepted).toBe(true);
		expect(repush.name).toBe("Shelf A2");
		// Foreign device with the same stale base → rejected.
		const foreign = await as.mutation(api.collections.renameCollection, {
			collectionId: created.id,
			name: "Shelf B",
			baseServerTime: created.serverTime,
			deviceId: DEVICE_B,
		});
		expect(foreign.accepted).toBe(false);
		expect(foreign.name).toBe("Shelf A2");
	});

	test("membership add/remove: same-device stale base is accepted", async () => {
		const { as, bookId } = await seed();
		const created = await seedCollection(as);
		// Device A adds, then removes — but imagine the remove's ack was lost:
		// A's next write still carries the pre-remove base.
		const added = await as.mutation(api.collections.addBookMembership, {
			collectionId: created.id,
			bookId,
			clientKey: "mem-1",
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		if (!added) {
			throw new Error("collection unexpectedly deleted");
		}
		expect(added.accepted).toBe(true);
		const removed = await as.mutation(api.collections.removeBookMembership, {
			membershipId: added.id as never,
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		expect(removed?.accepted).toBe(true);
		// Re-add with the stale base (own remove unacknowledged) → accepted.
		const readd = await as.mutation(api.collections.addBookMembership, {
			collectionId: created.id,
			bookId,
			clientKey: "mem-1b",
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		if (!readd) {
			throw new Error("collection unexpectedly deleted");
		}
		expect(readd.accepted).toBe(true);
		expect(readd.deleted).toBe(false);
	});

	test("membership: a foreign stale-base add is still rejected", async () => {
		const { as, bookId } = await seed();
		const created = await seedCollection(as);
		const added = await as.mutation(api.collections.addBookMembership, {
			collectionId: created.id,
			bookId,
			clientKey: "mem-2",
			baseServerTime: 0,
			deviceId: DEVICE_A,
		});
		if (!added) {
			throw new Error("collection unexpectedly deleted");
		}
		const removed = await as.mutation(api.collections.removeBookMembership, {
			membershipId: added.id as never,
			baseServerTime: added.serverTime,
			deviceId: DEVICE_A,
		});
		expect(removed?.accepted).toBe(true);
		// Device B never observed the remove; its stale re-add must lose.
		const foreign = await as.mutation(api.collections.addBookMembership, {
			collectionId: created.id,
			bookId,
			clientKey: "mem-2b",
			baseServerTime: added.serverTime,
			deviceId: DEVICE_B,
		});
		if (!foreign) {
			throw new Error("collection unexpectedly deleted");
		}
		expect(foreign.accepted).toBe(false);
		expect(foreign.deleted).toBe(true);
	});
});
