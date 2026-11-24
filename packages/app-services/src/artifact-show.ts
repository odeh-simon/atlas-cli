import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getArtifactRecord } from "@sigil/persistence";

import { closeSigilRuntime, openSigilRuntime } from "./runtime.js";

export interface ShowArtifactContentResult {
  readonly artifactId: string;
  readonly type: string;
  readonly mediaType: string;
  readonly content: string;
  readonly storagePath: string;
}

export async function showArtifactContent(input: {
  readonly artifactId: string;
}): Promise<ShowArtifactContentResult | undefined> {
  const runtime = await openSigilRuntime();
  try {
    const artifact = getArtifactRecord(runtime.db, input.artifactId);
    if (artifact === undefined) {
      return undefined;
    }

    const storagePath = join(runtime.paths.artifactRoot, artifact.storageUri);
    return {
      artifactId: artifact.artifactId,
      type: artifact.type,
      mediaType: artifact.mediaType,
      content: isTextMediaType(artifact.mediaType)
        ? readFileSync(storagePath, "utf8")
        : `Binary artifact: ${artifact.type}\nMedia type: ${artifact.mediaType}\nBytes: ${artifact.byteLength}\nPath: ${storagePath}\n`,
      storagePath
    };
  } finally {
    closeSigilRuntime(runtime, false);
  }
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType === "text/markdown" || mediaType.startsWith("text/");
}
