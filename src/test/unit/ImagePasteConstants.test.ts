import * as assert from "assert";
import { suite, test } from "mocha";
import {
  mimeTypeToImageExtension,
  imageExtensionToMimeType,
  isImageRefPath,
  PASTED_IMAGE_MIME_EXTENSIONS,
} from "../../types/DashboardConstants";

suite("Image paste constants", () => {
  suite("mimeTypeToImageExtension", () => {
    test("maps accepted MIME types to extensions", () => {
      assert.strictEqual(mimeTypeToImageExtension("image/png"), "png");
      assert.strictEqual(mimeTypeToImageExtension("image/jpeg"), "jpg");
      assert.strictEqual(mimeTypeToImageExtension("image/gif"), "gif");
      assert.strictEqual(mimeTypeToImageExtension("image/webp"), "webp");
    });

    test("is case-insensitive on the MIME type", () => {
      assert.strictEqual(mimeTypeToImageExtension("IMAGE/PNG"), "png");
    });

    test("returns undefined for unsupported or missing types", () => {
      assert.strictEqual(mimeTypeToImageExtension("image/bmp"), undefined);
      assert.strictEqual(
        mimeTypeToImageExtension("application/pdf"),
        undefined
      );
      assert.strictEqual(mimeTypeToImageExtension(""), undefined);
      assert.strictEqual(mimeTypeToImageExtension(undefined), undefined);
    });

    test("every accepted MIME type resolves to a non-empty extension", () => {
      for (const [mime, ext] of Object.entries(PASTED_IMAGE_MIME_EXTENSIONS)) {
        assert.strictEqual(mimeTypeToImageExtension(mime), ext);
        assert.ok(ext.length > 0);
      }
    });
  });

  suite("imageExtensionToMimeType", () => {
    test("maps extensions to MIME types (jpg and jpeg both → image/jpeg)", () => {
      assert.strictEqual(imageExtensionToMimeType("png"), "image/png");
      assert.strictEqual(imageExtensionToMimeType("jpg"), "image/jpeg");
      assert.strictEqual(imageExtensionToMimeType("jpeg"), "image/jpeg");
      assert.strictEqual(imageExtensionToMimeType("gif"), "image/gif");
      assert.strictEqual(imageExtensionToMimeType("webp"), "image/webp");
    });

    test("is case-insensitive and rejects unknown extensions", () => {
      assert.strictEqual(imageExtensionToMimeType("PNG"), "image/png");
      assert.strictEqual(imageExtensionToMimeType("bmp"), undefined);
      assert.strictEqual(imageExtensionToMimeType(""), undefined);
    });

    test("round-trips with mimeTypeToImageExtension for pasted formats", () => {
      for (const mime of Object.keys(PASTED_IMAGE_MIME_EXTENSIONS)) {
        const ext = mimeTypeToImageExtension(mime);
        assert.ok(ext);
        assert.strictEqual(imageExtensionToMimeType(ext), mime);
      }
    });
  });

  suite("isImageRefPath", () => {
    test("true for image extensions (any case)", () => {
      assert.ok(
        isImageRefPath(".ctrlyoke/attachments/flow/pasted-image-abc.png")
      );
      assert.ok(isImageRefPath("docs/diagram.JPG"));
      assert.ok(isImageRefPath("a.jpeg"));
      assert.ok(isImageRefPath("a.gif"));
      assert.ok(isImageRefPath("a.webp"));
    });

    test("false for non-image or extensionless paths", () => {
      assert.ok(!isImageRefPath("src/index.ts"));
      assert.ok(!isImageRefPath("notes.md"));
      assert.ok(!isImageRefPath("README"));
      assert.ok(!isImageRefPath(""));
    });
  });
});
