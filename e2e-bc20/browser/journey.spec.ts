/**
 * Browser journey — BC2.0 happy path through the REAL FE (kepabeanan-smart-form).
 *
 * Purpose: FE-side validation for a FEW concurrent users — measure real page/render
 * timing and catch client-side breakage (JS errors, slow bundles, broken steps).
 * This is NOT a load test; you can't run thousands of browsers. For load, use the
 * k6 API-replay journeys one level up (journey_excel.js / journey_ocr.js).
 *
 * Setup:
 *   npm install
 *   npm run install:browsers
 *   FE_URL=<fe base url> SSO_TOKEN=<bearer> USERS=3 npm test
 *
 * Auth: the FE (src/services/api.ts) reads the bearer token from
 * `sessionStorage.token`, falling back to `localStorage.token` — there is no
 * cookie-based auth in the FE app itself. We seed both storages before
 * navigating so the app treats us as logged in without going through the SSO
 * login UI. We also set a `_aid` cookie just in case a host-shell app in
 * front of this micro-frontend relies on it; it's harmless if unused.
 *
 * Scope: this journey goes all the way to the "Review & Submit" step and
 * asserts it renders with a completeness status, but deliberately does NOT
 * click the final "Submit" button — that would create a finalized submission
 * in dev on every run. Reaching Review & Submit already creates a draft
 * permohonan (same data-writing caveat as the k6 journeys — dev/throwaway
 * env only).
 */
import { test, expect, type Page } from '@playwright/test';

const SSO_TOKEN = process.env.SSO_TOKEN || '';
const FE_URL = process.env.FE_URL || 'http://localhost:3000';

// Seed SSO session so the FE skips the login UI.
async function seedSession(page: Page) {
  const url = new URL(FE_URL);
  if (SSO_TOKEN) {
    await page.context().addCookies([
      { name: '_aid', value: SSO_TOKEN, domain: url.hostname, path: '/' },
    ]);
    await page.addInitScript((tok) => {
      try {
        localStorage.setItem('token', tok as string);
        sessionStorage.setItem('token', tok as string);
      } catch { /* ignore */ }
    }, SSO_TOKEN);
  }
}

// Capture client-side errors so a "green" journey with JS errors still fails.
function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

test('BC2.0 — buka daftar pengajuan, mulai dokumen baru, sampai Review & Submit', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await seedSession(page);

  const t0 = Date.now();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const domLoaded = Date.now() - t0;
  console.log(`[timing] DOMContentLoaded: ${domLoaded} ms`);

  // App shell should render
  await expect(page.locator('body')).toBeVisible();

  // 1) Go to "Data Pengajuan"
  await page.getByRole('link', { name: 'Data Pengajuan' }).click();
  await expect(page).toHaveURL(/\/data/);

  // 2) Start a new submission: "Pengajuan" -> "Buat Manual" -> "Buat Baru" -> pick BC 2.0
  await page.getByRole('button', { name: 'Pengajuan' }).click();
  await page.getByRole('button', { name: 'Buat Manual' }).click();
  await page.getByRole('button', { name: 'Buat Baru' }).click();
  await page.getByText('BC 2.0 - PIB Impor').click();

  // 3) Skip the upload step (no real file needed for this validation journey)
  await page.getByRole('button', { name: 'Lewati Upload' }).click();
  await expect(page).toHaveURL(/\/form/);

  // 4) Open Review & Submit and assert the completeness status renders
  await page.getByText('Review & Submit').click();
  await expect(page.getByRole('heading', { name: 'Review & Submit' })).toBeVisible();
  await expect(page.getByText(/Siap submit|Ada data yang perlu dilengkapi/)).toBeVisible();

  // Deliberately NOT clicking "Submit" -> "Ya, Simpan": that would finalize
  // a real submission in dev on every run. Reaching this page already
  // exercises the full FE journey and creates a draft permohonan.

  const total = Date.now() - t0;
  console.log(`[timing] journey wall time: ${total} ms`);

  // Fail the test if the FE logged client-side errors during the journey.
  expect(errors, `console errors:\n${errors.join('\n')}`).toHaveLength(0);
});
