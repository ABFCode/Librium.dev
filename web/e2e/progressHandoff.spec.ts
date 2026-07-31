import { expect, type Page, test } from "@playwright/test";
import { buildFixtureEpub } from "./fixtureEpub";

const email = `e2e-progress-handoff-${Date.now()}@test.local`;
const password = "e2e-password-123";
const title = "Progress Handoff Fixture";

const cardFor = (page: Page) => page.locator(".book-card", { hasText: title });
const readerTitle = (page: Page) => page.locator(".reader-topbar-title");

const openBook = async (page: Page) => {
	await page.goto("/library");
	await expect(cardFor(page)).toBeVisible({ timeout: 20_000 });
	await cardFor(page).getByRole("link").first().click();
	await expect(readerTitle(page)).toHaveText(/Chapter I/, { timeout: 20_000 });
};

test("a long-lived stale reader cannot overwrite newer progress from another device", async ({
	page: computer,
	browser,
}) => {
	test.setTimeout(180_000);

	await computer.goto("/sign-up");
	await computer.getByPlaceholder("Name").fill("Progress Reader");
	await computer.getByPlaceholder("Email").fill(email);
	await computer.getByPlaceholder("Password").fill(password);
	await computer.getByRole("button", { name: "Create account" }).click();
	await computer.waitForURL("**/library", { timeout: 20_000 });

	await computer.goto("/import");
	await computer.locator('input[type="file"][accept*="epub"]').setInputFiles({
		name: "progress-handoff.epub",
		mimeType: "application/epub+zip",
		buffer: Buffer.from(buildFixtureEpub(title)),
	});
	await computer.getByRole("button", { name: /Import 1 book/ }).click();
	await expect(computer.locator(".queue-status")).toHaveText("Ready", {
		timeout: 30_000,
	});
	await openBook(computer);

	// Reproduce a tab that has remained open at chapter 1 long enough to fall
	// outside the former four-second handoff window, then gets suspended.
	await computer.waitForTimeout(4_500);
	await computer.context().setOffline(true);

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

	await phone.locator('button[data-tooltip="Chapters"]').click();
	await phone.locator('.reader-drawer [data-index="2"]').click();
	await expect(readerTitle(phone)).toHaveText(/^Chapter III\./, {
		timeout: 20_000,
	});
	await phone.waitForTimeout(1_500);

	// Leaving and reopening proves the phone's chapter reached the server, not
	// merely its own in-memory reader state.
	await phone.goto("/library");
	await cardFor(phone).getByRole("link").first().click();
	await expect(readerTitle(phone)).toHaveText(/^Chapter III\./, {
		timeout: 20_000,
	});

	// The already-open computer must converge even though it is an old page.
	// If it remains on chapter 1, its next page-hide save can erase the phone.
	await computer.context().setOffline(false);
	await expect(readerTitle(computer)).toHaveText(/^Chapter III\./, {
		timeout: 20_000,
	});
	await computer.goto("/library");

	// Hiding the formerly stale page must not roll the phone back.
	await phone.reload();
	await expect(readerTitle(phone)).toHaveText(/^Chapter III\./, {
		timeout: 20_000,
	});

	// The reverse direction remains intentional: a real chapter choice on the
	// computer is a new edit and should hand off to the still-open phone.
	await cardFor(computer).getByRole("link").first().click();
	await expect(readerTitle(computer)).toHaveText(/^Chapter III\./, {
		timeout: 20_000,
	});
	await computer.locator('button[data-tooltip="Chapters"]').click();
	await computer.locator('.reader-drawer [data-index="1"]').click();
	await expect(readerTitle(computer)).toHaveText(/^Chapter II\./, {
		timeout: 20_000,
	});
	await expect(readerTitle(phone)).toHaveText(/^Chapter II\./, {
		timeout: 20_000,
	});

	await phoneContext.close();
});
