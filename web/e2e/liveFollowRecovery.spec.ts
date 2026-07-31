import { expect, type Page, test } from "@playwright/test";
import { buildFixtureEpub } from "./fixtureEpub";

// The originally-reported sync bug, end to end: a chapter change on one
// device must appear on the other device live (no refresh anywhere), and a
// device that read ahead while disconnected must hand its position off after
// reconnecting WITHOUT a page reload — the historical failure mode was a
// push queue that stayed wedged until the user manually refreshed.

const email = `e2e-live-follow-${Date.now()}@test.local`;
const password = "e2e-password-123";
const title = "Live Follow Fixture";

const cardFor = (page: Page) => page.locator(".book-card", { hasText: title });
const readerTitle = (page: Page) => page.locator(".reader-topbar-title");

const openBook = async (page: Page) => {
	await page.goto("/library");
	await expect(cardFor(page)).toBeVisible({ timeout: 20_000 });
	await cardFor(page).getByRole("link").first().click();
	await expect(readerTitle(page)).toHaveText(/Chapter/, { timeout: 20_000 });
};

const goToChapter = async (page: Page, index: number) => {
	await page.locator('button[data-tooltip="Chapters"]').click();
	await page.locator(`.reader-drawer [data-index="${index}"]`).click();
};

// Optional walkthrough screenshots (LIVE_SHOT_DIR=/path playwright test ...).
const shot = async (page: Page, name: string) => {
	const dir = process.env.LIVE_SHOT_DIR;
	if (dir) {
		await page.screenshot({ path: `${dir}/${name}.png` });
	}
};

test("a chapter change follows live across devices, including reconnect catch-up without reload", async ({
	page: computer,
	browser,
}) => {
	test.setTimeout(180_000);

	await computer.goto("/sign-up");
	await computer.getByPlaceholder("Name").fill("Live Reader");
	await computer.getByPlaceholder("Email").fill(email);
	await computer.getByPlaceholder("Password").fill(password);
	await computer.getByRole("button", { name: "Create account" }).click();
	await computer.waitForURL("**/library", { timeout: 20_000 });

	await computer.goto("/import");
	await computer.locator('input[type="file"][accept*="epub"]').setInputFiles({
		name: "live-follow.epub",
		mimeType: "application/epub+zip",
		buffer: Buffer.from(buildFixtureEpub(title)),
	});
	await computer.getByRole("button", { name: /Import 1 book/ }).click();
	await expect(computer.locator(".queue-status")).toHaveText("Ready", {
		timeout: 30_000,
	});
	await openBook(computer);

	// A second, genuinely distinct device: its own storage, its own deviceId,
	// its own websocket.
	const phoneContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
	});
	const phone = await phoneContext.newPage();
	await phone.goto("/sign-in");
	await phone.getByPlaceholder("Email").fill(email);
	await phone.getByPlaceholder("Password").fill(password);
	await phone.getByRole("button", { name: "Sign in" }).click();
	await phone.waitForURL("**/library", { timeout: 20_000 });
	await openBook(phone);
	await shot(computer, "1-pc-start");
	await shot(phone, "1-phone-start");

	// The original complaint, verbatim: "I switch a chapter on my phone,
	// chapter switches on PC" — with neither page refreshed.
	await goToChapter(phone, 2);
	await expect(readerTitle(phone)).toHaveText(/^Chapter III\./, {
		timeout: 20_000,
	});
	await expect(readerTitle(computer)).toHaveText(/^Chapter III\./, {
		timeout: 20_000,
	});
	await shot(computer, "2-pc-followed-live");
	await shot(phone, "2-phone-chapter-3");

	// The reported failure mode: the phone reads at a different chapter while
	// its connection is gone; the PC must not see it yet — and after the
	// phone reconnects (with NO reload), the queued write must flush and the
	// PC must follow.
	await phoneContext.setOffline(true);
	await goToChapter(phone, 1);
	await expect(readerTitle(phone)).toHaveText(/^Chapter II\./, {
		timeout: 20_000,
	});
	await phone.waitForTimeout(2_000);
	await expect(readerTitle(computer)).toHaveText(/^Chapter III\./);
	await shot(computer, "3-pc-still-chapter-3-while-phone-offline");
	await shot(phone, "3-phone-offline-chapter-2");

	await phoneContext.setOffline(false);
	await expect(readerTitle(computer)).toHaveText(/^Chapter II\./, {
		timeout: 30_000,
	});
	await shot(computer, "4-pc-caught-up-after-reconnect");
	await shot(phone, "4-phone-after-reconnect");

	await phoneContext.close();
});
