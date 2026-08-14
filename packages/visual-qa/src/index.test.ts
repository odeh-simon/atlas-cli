import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { comparePngImages } from "./index.js";

describe("visual QA", () => {
  it("passes identical PNG images", () => {
    const image = solidPng(4, 3, [20, 40, 60, 255]);

    const result = comparePngImages({ reference: image, actual: image });

    expect(result).toMatchObject({ status: "passed", mismatchedPixels: 0, totalPixels: 12, diffRatio: 0 });
    expect(result.diffPng).toBeDefined();
  });

  it("fails when changed pixels exceed the configured ratio", () => {
    const reference = solidPng(2, 2, [0, 0, 0, 255]);
    const actual = solidPng(2, 2, [255, 255, 255, 255]);

    const result = comparePngImages({ reference, actual, allowedDiffRatio: 0.25 });

    expect(result).toMatchObject({ status: "failed", mismatchedPixels: 4, diffRatio: 1 });
  });

  it("reports dimension mismatches without invoking pixel comparison", () => {
    const result = comparePngImages({
      reference: solidPng(2, 2, [0, 0, 0, 255]),
      actual: solidPng(3, 2, [0, 0, 0, 255])
    });

    expect(result).toMatchObject({
      status: "dimension-mismatch",
      reference: { width: 2, height: 2 },
      actual: { width: 3, height: 2 },
      diffRatio: 1
    });
    expect(result.diffPng).toBeUndefined();
  });

  it("validates thresholds", () => {
    const image = solidPng(1, 1, [0, 0, 0, 255]);
    expect(() => comparePngImages({ reference: image, actual: image, pixelThreshold: 2 })).toThrow(
      "pixelThreshold"
    );
  });
});

function solidPng(width: number, height: number, color: readonly [number, number, number, number]): Uint8Array {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = color[0];
    image.data[offset + 1] = color[1];
    image.data[offset + 2] = color[2];
    image.data[offset + 3] = color[3];
  }
  return PNG.sync.write(image);
}
