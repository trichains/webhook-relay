import { expect, test } from "@playwright/test";

test("landing page links to the dashboard and the repo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Webhook Relay" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Source on GitHub" })).toHaveAttribute("href", "https://github.com/trichains/webhook-relay");
  await page.getByRole("link", { name: "Open the dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Sandbox: in-memory data")).toBeVisible();
});

test("send a test webhook and watch it get delivered to /api/sink/ok", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText("Events (24h)")).toBeVisible();

  // The HMAC source has a destination on /api/sink/ok for order.paid (the test event type).
  await page.getByRole("link", { name: "Sources", exact: true }).click();
  await page.getByRole("link", { name: "Store checkout" }).click();
  await expect(page.getByTestId("ingest-url")).toHaveValue(/\/api\/ingest\/store-checkout$/);

  await page.getByRole("button", { name: "Send test webhook" }).click();
  await expect(page.getByText(/Ingest answered 202/)).toBeVisible();
  const eventLink = page.getByTestId("test-event-link");
  const href = await eventLink.getAttribute("href");
  expect(href).toMatch(/^\/dashboard\/events\/[0-9a-f-]{36}$/);
  const eventId = href!.split("/").pop()!;

  // The event shows up in the events list.
  await page.getByRole("link", { name: "Events", exact: true }).click();
  const row = page.getByTestId("events-table").locator(`a[href="/dashboard/events/${eventId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveText("order.paid");

  // Detail page: verified signature and a successful attempt against the ok sink.
  await row.click();
  await expect(page.getByRole("heading", { name: "order.paid" })).toBeVisible();
  await expect(page.getByTestId("verification-reason")).toHaveText("valid hmac-sha256 signature");
  await expect(page.getByTestId("payload")).toContainText('"event": "order.paid"');

  const fulfillment = page.locator("section", { has: page.getByRole("heading", { name: /Fulfillment API/ }) });
  await expect(fulfillment).toContainText("/api/sink/ok");
  // The first attempt runs in after(); the page refreshes itself while deliveries are in flight.
  await expect(fulfillment.locator('[data-testid="attempt"][data-ok="true"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(fulfillment).toContainText("succeeded");
  await expect(fulfillment).toContainText("200");
});

test("management API lists the event and rejects bad signatures", async ({ request }) => {
  const list = await request.get("/api/v1/events?page_size=5");
  expect(list.ok()).toBe(true);
  expect(list.headers()["x-relay-auth"]).toBe("open-sandbox");
  const body = await list.json();
  expect(body.data.length).toBeGreaterThan(0);

  const rejected = await request.post("/api/ingest/store-checkout", {
    data: { id: "evt_forged", event: "order.paid" },
    headers: { "x-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
  });
  expect(rejected.status()).toBe(401);
  expect((await rejected.json()).reason).toBe("signature mismatch");
});
