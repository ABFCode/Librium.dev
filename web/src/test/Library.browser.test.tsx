import { getFunctionName } from "convex/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { api } from "../../convex/_generated/api";
import { Library } from "../components/LibraryView";
import { db } from "../lib/db";

const books = [
	{
		_id: "book1",
		title: "Alice in Wonderland",
		author: "Lewis Carroll",
		series: "Wonder Saga",
		seriesIndex: "1",
		createdAt: 1,
		updatedAt: 1,
	},
	{
		_id: "book2",
		title: "Zen and the Art",
		author: "Robert Pirsig",
		createdAt: 2,
		updatedAt: 2,
	},
];

const progressEntries = [
	{
		bookId: "book1",
		lastSectionId: null,
		lastSectionTitle: null,
		lastSectionIndex: 0,
		totalSections: 10,
		progress: 0.1,
		status: "abandoned",
		statusEditedAt: 5,
		updatedAt: 10,
	},
	{
		bookId: "book2",
		lastSectionId: null,
		lastSectionTitle: null,
		lastSectionIndex: 9,
		totalSections: 10,
		progress: 1,
		status: null,
		statusEditedAt: null,
		updatedAt: 20,
	},
];

const recentEntries = [
	{
		entryId: "entry2",
		book: books[1],
		lastSectionId: null,
		updatedAt: 20,
	},
	{
		entryId: "entry1",
		book: books[0],
		lastSectionId: null,
		updatedAt: 10,
	},
];

const coverUrls = {
	book1: null,
	book2: null,
};

const remoteCollections = [
	{
		_id: "colA",
		clientKey: "ck-colA",
		name: "Favorites",
		createdAt: 1,
		updatedAt: 1,
	},
];

const remoteMemberships = [
	{
		_id: "memA",
		collectionId: "colA",
		bookId: "book1",
		clientKey: "ck-memA",
		createdAt: 1,
		updatedAt: 1,
	},
];

// `api` is a proxy (anyApi); references aren't identity-stable across accesses,
// so match on the resolved function name instead of `===`.
const nameOf = (ref: unknown) => getFunctionName(ref as never);
const useQueryMock = vi.fn((query: unknown) => {
	const name = nameOf(query);
	if (name === nameOf(api.books.listByOwner)) {
		return books;
	}
	if (name === nameOf(api.userBooks.listByUser)) {
		return progressEntries;
	}
	if (name === nameOf(api.userBooks.listRecentByUser)) {
		return recentEntries;
	}
	if (name === nameOf(api.books.getCoverUrls)) {
		return coverUrls;
	}
	if (name === nameOf(api.collections.listByUser)) {
		return remoteCollections;
	}
	if (name === nameOf(api.collections.listMembershipsByUser)) {
		return remoteMemberships;
	}
	return undefined;
});

vi.mock("convex/react", () => ({
	useConvexAuth: () => ({ isAuthenticated: true }),
	useQuery: (query: unknown) => useQueryMock(query),
	useMutation: () => vi.fn(),
	useAction: () => vi.fn(),
	useConvex: () => ({ mutation: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, ...props }: { children: ReactNode }) => (
		<a {...props}>{children}</a>
	),
	createFileRoute: () => () => ({}),
}));

vi.mock("../components/RequireAuth", () => ({
	RequireAuth: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const cardTitles = (screen: { container: HTMLElement }) =>
	[...screen.container.querySelectorAll(".book-title")].map(
		(el) => el.textContent,
	);

describe("Library", () => {
	beforeEach(async () => {
		localStorage.clear();
		useQueryMock.mockClear();
		// The component's sync hooks and reconcile pass write to the real
		// (per-origin, shared across test files) IndexedDB — start clean.
		await Promise.all([
			db.books.clear(),
			db.progress.clear(),
			db.bookStatus.clear(),
			db.collections.clear(),
			db.collectionBooks.clear(),
		]);
	});

	it("filters the library by search query", async () => {
		const screen = await render(<Library />);
		await screen.getByPlaceholder("Search titles, authors…").fill("alice");

		const cards = screen.container.querySelectorAll(".book-card");
		expect(cards.length).toBe(1);
		// The title renders in both the no-cover placeholder and the meta line —
		// assert on the meta line specifically.
		expect(screen.container.querySelector(".book-title")?.textContent).toBe(
			"Alice in Wonderland",
		);
	});

	it("exposes the full title on hover for the clamped card title", async () => {
		// The two-line clamp itself is stylesheet-driven (library.css) and is
		// checked against real CSS in e2e; here we pin the hover affordance.
		const screen = await render(<Library />);
		const title = screen.container.querySelector(".book-title");
		expect(title?.getAttribute("title")).toBe(title?.textContent);
	});

	it("persists sort selection", async () => {
		const screen = await render(<Library />);
		await screen.getByText("Title").click();
		expect(localStorage.getItem("library:sort")).toBe("title");
	});

	it("filters by status shelf tabs", async () => {
		const screen = await render(<Library />);

		// book1 has an explicit "abandoned"; book2 derives "finished" (100%).
		await screen.getByRole("button", { name: "Abandoned" }).click();
		expect(cardTitles(screen)).toEqual(["Alice in Wonderland"]);

		await screen.getByRole("button", { name: "Finished" }).click();
		expect(cardTitles(screen)).toEqual(["Zen and the Art"]);

		await screen.getByRole("button", { name: "All", exact: true }).click();
		expect(screen.container.querySelectorAll(".book-card").length).toBe(2);
		// The active tab persists.
		expect(
			JSON.parse(localStorage.getItem("library:filters") ?? "{}").status,
		).toBe("all");
	});

	it("filters to books stored on this device", async () => {
		await db.books.put({
			bookId: "book1",
			title: "Alice in Wonderland",
			author: "Lewis Carroll",
			sectionCount: 10,
			parserVersion: "0.1.1",
			addedAt: Date.now(),
		});
		const screen = await render(<Library />);

		await screen.getByRole("button", { name: "On this device" }).click();
		await expect
			.poll(() => screen.container.querySelectorAll(".book-card").length)
			.toBe(1);
		expect(cardTitles(screen)).toEqual(["Alice in Wonderland"]);
	});

	it("groups by series under the Series sort", async () => {
		const screen = await render(<Library />);
		await screen.getByRole("button", { name: "Series" }).click();

		const headings = [...screen.container.querySelectorAll("h2")].map((el) =>
			el.textContent?.replace(/\d+$/, "").trim(),
		);
		expect(headings).toEqual(["Wonder Saga", "Other books"]);
	});

	it("opens per-book reading history from the card menu", async () => {
		const screen = await render(<Library />);
		const targetCard = Array.from(
			screen.container.querySelectorAll<HTMLElement>(".book-card"),
		).find((card) => card.textContent?.includes("Alice in Wonderland"));
		expect(targetCard).toBeDefined();
		await targetCard
			?.querySelector<HTMLButtonElement>(".book-menu-shell > button")
			?.click();
		await screen.getByRole("button", { name: "Reading history…" }).click();

		await expect
			.element(screen.getByRole("dialog", { name: "Reading history" }))
			.toBeVisible();
		await expect
			.element(
				screen
					.getByRole("dialog", { name: "Reading history" })
					.getByText("Alice in Wonderland"),
			)
			.toBeVisible();
	});

	it("filters by collection", async () => {
		const screen = await render(<Library />);

		// The merge pass adopts the remote collection + membership into Dexie —
		// an async reconcile, so poll generously (the default ~1s races under
		// the parallel browser suite and flaked in CI).
		await screen.getByRole("button", { name: /Collection/ }).click();
		await expect
			.poll(() => !!screen.container.textContent?.includes("Favorites"), {
				timeout: 5000,
			})
			.toBe(true);
		await screen.getByRole("button", { name: /Favorites/ }).click();

		await expect
			.poll(() => screen.container.querySelectorAll(".book-card").length, {
				timeout: 5000,
			})
			.toBe(1);
		expect(cardTitles(screen)).toEqual(["Alice in Wonderland"]);
	});
});
