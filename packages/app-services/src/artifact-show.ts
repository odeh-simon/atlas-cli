import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getArtifactRecord } from "@atlas/persistence";

import { closeAtlasRuntime, openAtlasRuntime } from "./runtime.js";

export interface ShowArtifactContentResult {
  readonly artifactId: string;
  readonly type: string;
  readonly mediaType: string;
  readonly content: string;
}

export async function showArtifactContent(input: {
  readonly artifactId: string;
}): Promise<ShowArtifactContentResult | undefined> {
  const runtime = await openAtlasRuntime();
  try {
    const artifact = getArtifactRecord(runtime.db, input.artifactId);
    if (artifact === undefined) {
      return undefined;
    }

    return {
      artifactId: artifact.artifactId,
      type: artifact.type,
      mediaType: artifact.mediaType,
      content: readFileSync(join(runtime.paths.artifactRoot, artifact.storageUri), "utf8")
    };
  } finally {
    closeAtlasRuntime(runtime, false);
  }
}
