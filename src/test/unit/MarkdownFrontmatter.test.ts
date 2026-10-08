import * as assert from "assert";
import { suite, test } from "mocha";
import {
  locateMarkdownFrontmatter,
  splitMarkdownFrontmatter,
} from "../../utils/MarkdownFrontmatter";

suite("MarkdownFrontmatter", () => {
  test("splits frontmatter from the body", () => {
    assert.deepStrictEqual(
      splitMarkdownFrontmatter("---\nname: a\n---\nBody\n"),
      { frontmatter: "name: a", body: "Body\n" }
    );
    assert.strictEqual(splitMarkdownFrontmatter("No frontmatter\n"), null);
    assert.strictEqual(splitMarkdownFrontmatter("---\nunclosed\n"), null);
  });

  test("accepts an empty block, CRLF and a leading BOM", () => {
    assert.deepStrictEqual(splitMarkdownFrontmatter("---\n---\nBody"), {
      frontmatter: "",
      body: "Body",
    });
    assert.deepStrictEqual(
      splitMarkdownFrontmatter("\uFEFF---\r\nname: a\r\n---\r\nBody"),
      { frontmatter: "name: a", body: "Body" }
    );
  });

  test("locates ranges as offsets into the original text, BOM included", () => {
    const text = "\uFEFF---\nname: a\n---\nBody";
    const { frontmatter, bodyStart } = locateMarkdownFrontmatter(text);
    assert.ok(frontmatter);
    assert.strictEqual(
      text.slice(frontmatter.start, frontmatter.end),
      "name: a"
    );
    assert.strictEqual(text.slice(bodyStart), "Body");
    assert.deepStrictEqual(locateMarkdownFrontmatter("\uFEFFBody"), {
      bodyStart: 1,
    });
  });
});
