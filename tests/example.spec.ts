import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
  await page.goto('https://www.inmuebles24.com/locales-comerciales-en-renta-en-monterrey.html');

  // Case-insensitive
  await expect(page.locator("[data-qa='l-button-location'] p")).toHaveText(/monterrey/i);

  // Solo que sea visible
  await expect(page.locator("[data-qa='l-button-location']")).toBeVisible();

  // Que el ul contenga el texto (más flexible)
  await expect(page.locator(".searchbox-module__appliedTags")).toContainText("Monterrey");
});


