/**
 * Visual Verification Runner — captures screenshots of the target app
 * after an agent pushes changes, using Playwright.
 *
 * Supports Firebase password auth via in-page login dialog:
 *   1. Navigate to app
 *   2. Click login button → dialog appears
 *   3. Fill email + password in dialog
 *   4. Submit → dialog closes, user is authenticated
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  VerifyConfig,
  VerifyResult,
  VerifyScreenshot,
  VerifyAuthConfig,
  LoginSelectors,
} from "./types.js";

// ── Default selectors (sensible fallbacks) ──────────────────────────────────

const DEFAULT_SELECTORS: Required<LoginSelectors> = {
  loginButton:
    'button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), [data-testid="login-button"]',
  emailInput:
    'input[type="email"], input[name="email"], input[placeholder*="email" i]',
  passwordInput:
    'input[type="password"], input[name="password"]',
  submitButton:
    'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Submit")',
  successIndicator: "",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve ${ENV_VAR} placeholders in a string. */
function resolveEnvVars(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\$\{([^}]+)\}/g, (_match, envKey: string) => {
    return process.env[envKey] ?? "";
  });
}

/** Merge user selectors with defaults. */
function mergeSelectors(custom?: LoginSelectors): Required<LoginSelectors> {
  if (!custom) return DEFAULT_SELECTORS;
  return {
    loginButton: custom.loginButton || DEFAULT_SELECTORS.loginButton,
    emailInput: custom.emailInput || DEFAULT_SELECTORS.emailInput,
    passwordInput: custom.passwordInput || DEFAULT_SELECTORS.passwordInput,
    submitButton: custom.submitButton || DEFAULT_SELECTORS.submitButton,
    successIndicator: custom.successIndicator || DEFAULT_SELECTORS.successIndicator,
  };
}

// ── Playwright page type (avoiding hard dep on @playwright/test) ────────────

interface PlaywrightPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, opts?: { state?: string; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run visual verification — launch browser, authenticate, capture screenshots.
 *
 * Playwright is dynamically imported so this module doesn't hard-depend on it.
 * The caller (CLI / orchestrator) should ensure playwright is installed.
 */
export async function runVerification(
  config: VerifyConfig,
  outputDir: string,
): Promise<VerifyResult> {
  const screenshots: VerifyScreenshot[] = [];

  // Dynamic import — playwright may not be installed in core
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any;
  try {
    playwright = await (Function('return import("playwright")')() as Promise<unknown>);
  } catch {
    return {
      success: false,
      screenshots: [],
      error: "Playwright is not installed. Run: npx playwright install chromium",
    };
  }

  await mkdir(outputDir, { recursive: true });

  const { width = 1280, height = 900 } = config.viewport ?? {};

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height } });
    const page: PlaywrightPage = await context.newPage();

    // Navigate to the app first (needed for button-based login)
    const startUrl = config.auth.loginUrl || config.baseUrl;
    await page.goto(startUrl, { waitUntil: "networkidle", timeout: 30_000 });

    // Authenticate if needed
    await authenticate(page, config.auth);

    // Capture each configured page
    for (const pageConfig of config.paths) {
      const url = `${config.baseUrl}${pageConfig.url}`;
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

        if (pageConfig.waitForSelector) {
          await page.waitForSelector(pageConfig.waitForSelector, { timeout: 10_000 });
        }

        const delay = pageConfig.delayMs ?? 2000;
        if (delay > 0) {
          await page.waitForTimeout(delay);
        }

        const fileName = `${pageConfig.name.replace(/[^a-zA-Z0-9_-]/g, "-")}.png`;
        const filePath = join(outputDir, fileName);
        await page.screenshot({ path: filePath, fullPage: true });

        screenshots.push({ name: pageConfig.name, url, filePath });
      } catch (err) {
        screenshots.push({ name: pageConfig.name, url, filePath: "" });
        console.error(
          `Failed to capture ${pageConfig.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      success: true,
      screenshots: screenshots.filter((s) => s.filePath !== ""),
    };
  } catch (err) {
    return {
      success: false,
      screenshots,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// ── Authentication ──────────────────────────────────────────────────────────

/**
 * Authenticate with the target app.
 *
 * firebase-password flow:
 *   1. Page is already loaded (navigated before this call)
 *   2. Click login button → in-page dialog/modal appears
 *   3. Fill email + password in the dialog
 *   4. Click submit → dialog closes, Firebase auth completes
 *   5. Wait for success indicator or a short delay
 */
async function authenticate(
  page: PlaywrightPage,
  authConfig: VerifyAuthConfig,
): Promise<void> {
  switch (authConfig.strategy) {
    case "none":
      return;

    case "firebase-password": {
      const username = resolveEnvVars(authConfig.username);
      const password = resolveEnvVars(authConfig.password);

      if (!username || !password) {
        throw new Error("firebase-password auth requires username and password");
      }

      const sel = mergeSelectors(authConfig.selectors);

      // Step 1: Click the login button to open the dialog
      try {
        await page.waitForSelector(sel.loginButton, { timeout: 10_000 });
        await page.click(sel.loginButton);
      } catch {
        // Login button not found — maybe the login form is already visible
        // (e.g. redirected to a login page). Continue to fill the form.
      }

      // Step 2: Wait for the email input to appear (dialog is open)
      await page.waitForSelector(sel.emailInput, { timeout: 10_000 });

      // Step 3: Fill credentials
      await page.fill(sel.emailInput, username);
      await page.fill(sel.passwordInput, password);

      // Step 4: Submit
      await page.click(sel.submitButton);

      // Step 5: Wait for auth to complete
      if (sel.successIndicator) {
        // Wait for a specific element that only appears after login
        await page.waitForSelector(sel.successIndicator, { timeout: 15_000 });
      } else {
        // Fallback: wait for Firebase auth token to settle + dialog to close
        await page.waitForTimeout(3000);
      }

      return;
    }

    case "stored":
      // storageState was loaded into the browser context by the caller
      return;

    default:
      throw new Error(`Unknown auth strategy: ${authConfig.strategy as string}`);
  }
}
