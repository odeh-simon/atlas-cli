import pixelmatch from "pixelmatch";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PNG } from "pngjs";

export type VisualBrowserChannel = "auto" | "msedge" | "chrome" | "chromium";

export interface VisualViewport {
  readonly width: number;
  readonly height: number;
}

export interface CapturePageInput {
  readonly url: string;
  readonly viewport: VisualViewport;
  readonly fullPage?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly browserChannel?: VisualBrowserChannel | undefined;
}

export interface CapturedPage {
  readonly png: Uint8Array;
  readonly url: string;
  readonly title: string;
  readonly viewport: VisualViewport;
  readonly fullPage: boolean;
  readonly browserChannel: Exclude<VisualBrowserChannel, "auto">;
}

export interface VisualCaptureAdapter {
  readonly capture: (input: CapturePageInput) => Promise<CapturedPage>;
}

export interface ComparePngInput {
  readonly reference: Uint8Array;
  readonly actual: Uint8Array;
  readonly pixelThreshold?: number | undefined;
  readonly allowedDiffRatio?: number | undefined;
  readonly maxPixels?: number | undefined;
}

export interface PngComparisonResult {
  readonly status: "passed" | "failed" | "dimension-mismatch";
  readonly reference: { readonly width: number; readonly height: number };
  readonly actual: { readonly width: number; readonly height: number };
  readonly mismatchedPixels: number;
  readonly totalPixels: number;
  readonly diffRatio: number;
  readonly pixelThreshold: number;
  readonly allowedDiffRatio: number;
  readonly diffPng?: Uint8Array | undefined;
}

export const playwrightVisualCaptureAdapter: VisualCaptureAdapter = {
  capture: capturePageScreenshot
};

export async function capturePageScreenshot(input: CapturePageInput): Promise<CapturedPage> {
  validateCaptureInput(input);
  const timeoutMs = input.timeoutMs ?? 30_000;
  const channels: Array<Exclude<VisualBrowserChannel, "auto">> =
    input.browserChannel === undefined || input.browserChannel === "auto"
      ? ["msedge", "chrome", "chromium"]
      : [input.browserChannel];
  const failures: string[] = [];

  for (const channel of channels) {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ channel, headless: true, timeout: timeoutMs });
      return await captureWithBrowser(browser, channel, input, timeoutMs);
    } catch (error) {
      failures.push(`${channel}: ${error instanceof Error ? firstLine(error.message) : "launch failed"}`);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  throw new Error(`No supported Chromium browser could capture the page (${failures.join("; ")})`);
}

export function comparePngImages(input: ComparePngInput): PngComparisonResult {
  const pixelThreshold = input.pixelThreshold ?? 0.1;
  const allowedDiffRatio = input.allowedDiffRatio ?? 0.01;
  if (pixelThreshold < 0 || pixelThreshold > 1) throw new TypeError("pixelThreshold must be between 0 and 1");
  if (allowedDiffRatio < 0 || allowedDiffRatio > 1) throw new TypeError("allowedDiffRatio must be between 0 and 1");

  const reference = PNG.sync.read(Buffer.from(input.reference));
  const actual = PNG.sync.read(Buffer.from(input.actual));
  const referencePixels = reference.width * reference.height;
  const actualPixels = actual.width * actual.height;
  const maxPixels = input.maxPixels ?? 20_000_000;
  if (referencePixels > maxPixels || actualPixels > maxPixels) {
    throw new TypeError(`PNG comparison exceeds the ${maxPixels} pixel limit`);
  }
  if (reference.width !== actual.width || reference.height !== actual.height) {
    return {
      status: "dimension-mismatch",
      reference: { width: reference.width, height: reference.height },
      actual: { width: actual.width, height: actual.height },
      mismatchedPixels: Math.max(referencePixels, actualPixels),
      totalPixels: Math.max(referencePixels, actualPixels),
      diffRatio: 1,
      pixelThreshold,
      allowedDiffRatio
    };
  }

  const diff = new PNG({ width: reference.width, height: reference.height });
  const mismatchedPixels = pixelmatch(reference.data, actual.data, diff.data, reference.width, reference.height, {
    threshold: pixelThreshold,
    includeAA: false,
    diffMask: true
  });
  const totalPixels = referencePixels;
  const diffRatio = totalPixels === 0 ? 0 : mismatchedPixels / totalPixels;
  return {
    status: diffRatio <= allowedDiffRatio ? "passed" : "failed",
    reference: { width: reference.width, height: reference.height },
    actual: { width: actual.width, height: actual.height },
    mismatchedPixels,
    totalPixels,
    diffRatio,
    pixelThreshold,
    allowedDiffRatio,
    diffPng: PNG.sync.write(diff)
  };
}

async function captureWithBrowser(
  browser: Browser,
  channel: Exclude<VisualBrowserChannel, "auto">,
  input: CapturePageInput,
  timeoutMs: number
): Promise<CapturedPage> {
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: input.viewport,
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "UTC"
    });
    const page = await context.newPage();
    await preparePage(page, input.url, timeoutMs);
    const png = await page.screenshot({
      type: "png",
      fullPage: input.fullPage ?? false,
      animations: "disabled",
      caret: "hide",
      scale: "css"
    });
    return {
      png,
      url: page.url(),
      title: await page.title(),
      viewport: input.viewport,
      fullPage: input.fullPage ?? false,
      browserChannel: channel
    };
  } finally {
    await context?.close().catch(() => undefined);
  }
}

async function preparePage(page: Page, url: string, timeoutMs: number): Promise<void> {
  await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
  await page.addStyleTag({
    content: "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}"
  });
  await page.evaluate("document.fonts.ready");
}

function validateCaptureInput(input: CapturePageInput): void {
  const url = new URL(input.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Visual capture URL must use HTTP(S)");
  if (!Number.isInteger(input.viewport.width) || input.viewport.width < 240 || input.viewport.width > 7680) {
    throw new TypeError("Visual capture width must be an integer between 240 and 7680");
  }
  if (!Number.isInteger(input.viewport.height) || input.viewport.height < 240 || input.viewport.height > 7680) {
    throw new TypeError("Visual capture height must be an integer between 240 and 7680");
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}
