import * as assert from "assert";
import { suite, test } from "mocha";
import {
  QUEUE_POSITION,
  resolveQueueInsertIndex,
  IMAGE_REF_EXTENSIONS,
  imageExtensionToMimeType,
  isImageRefPath,
  WORKSPACE_MEDIA_INFO_BY_EXTENSION,
  WORKSPACE_MEDIA_KINDS,
  workspaceMediaInfoForPath,
} from "../../types/DashboardConstants";

suite("resolveQueueInsertIndex", () => {
  test("places parallelWithCurrent after the current live group", () => {
    const parallelGroups = [
      { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
    ];

    assert.strictEqual(
      resolveQueueInsertIndex(
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
        2,
        7,
        parallelGroups
      ),
      4
    );
  });

  test("keeps next as an ordinary insertion inside a live group", () => {
    const parallelGroups = [
      { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
    ];

    assert.strictEqual(
      resolveQueueInsertIndex(QUEUE_POSITION.NEXT, 2, 7, parallelGroups),
      3
    );
  });
});

suite("workspace media classification", () => {
  test("classifies every allowlisted extension with its expected MIME type", () => {
    const expected: Record<string, { mediaKind: string; mimeType: string }> = {
      mp4: { mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO, mimeType: "video/mp4" },
      m4v: { mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO, mimeType: "video/mp4" },
      webm: { mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO, mimeType: "video/webm" },
      ogv: { mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO, mimeType: "video/ogg" },
      mov: { mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO, mimeType: "video/quicktime" },
      mp3: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/mpeg" },
      m4a: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/mp4" },
      aac: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/aac" },
      wav: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/wav" },
      flac: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/flac" },
      ogg: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/ogg" },
      oga: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/ogg" },
      opus: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/ogg" },
      pdf: { mediaKind: WORKSPACE_MEDIA_KINDS.PDF, mimeType: "application/pdf" },
    };
    for (const [extension, info] of Object.entries(expected)) {
      assert.deepStrictEqual(workspaceMediaInfoForPath(`asset.${extension}`), info);
      assert.deepStrictEqual(WORKSPACE_MEDIA_INFO_BY_EXTENSION[extension], info);
    }
    for (const extension of IMAGE_REF_EXTENSIONS) {
      const mimeType = imageExtensionToMimeType(extension);
      assert.ok(mimeType);
      const imageInfo = workspaceMediaInfoForPath(`asset.${extension}`);
      assert.deepStrictEqual(imageInfo, {
        mediaKind: WORKSPACE_MEDIA_KINDS.IMAGE,
        mimeType,
      });
    }
    assert.strictEqual(Object.keys(WORKSPACE_MEDIA_INFO_BY_EXTENSION).length,
      Object.keys(expected).length + IMAGE_REF_EXTENSIONS.length);
  });

  test("leaves isImageRefPath behavior intact", () => {
    for (const extension of IMAGE_REF_EXTENSIONS) {
      assert.strictEqual(isImageRefPath(`asset.${extension}`), true);
      assert.strictEqual(isImageRefPath(`asset.${extension.toUpperCase()}`), true);
    }
    for (const path of ["asset.svg", "asset.mp4", "asset", "asset.jpg.txt"]) {
      assert.strictEqual(isImageRefPath(path), false);
    }
  });
});
