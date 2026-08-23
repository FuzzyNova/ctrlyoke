import * as assert from "assert";
import { suite, test } from "mocha";
import { parseWorkspaceTreeQuery } from "../../server/WorkspaceTreeRoute";
import { WorkspaceTreeBadRequestError } from "../../server/WorkspaceTreeErrors";

suite("WorkspaceTreeRoute", () => {
  test("parses an initial request and preserves optional paging fields", () => {
    assert.deepStrictEqual(
      parseWorkspaceTreeQuery({
        path: "src",
        pageSize: "25",
        includeGitIgnored: "true",
        anchorPath: "src/index.ts",
      }),
      {
        path: "src",
        pageSize: 25,
        includeGitIgnored: true,
        anchorPath: "src/index.ts",
      }
    );
  });

  test("parses a range request", () => {
    assert.deepStrictEqual(
      parseWorkspaceTreeQuery({
        listingId: "00000000-0000-4000-8000-000000000001",
        offset: "500",
      }),
      {
        listingId: "00000000-0000-4000-8000-000000000001",
        offset: 500,
      }
    );
  });

  test("rejects mixed initial and range parameters", () => {
    assert.throws(
      () =>
        parseWorkspaceTreeQuery({
          listingId: "00000000-0000-4000-8000-000000000001",
          offset: "0",
          path: "src",
        }),
      (error: unknown) => error instanceof WorkspaceTreeBadRequestError
    );
  });

  test("rejects malformed query values", () => {
    for (const query of [
      { listingId: "bad", offset: "0" },
      { listingId: "00000000-0000-4000-8000-000000000001" },
      { path: "", pageSize: "0" },
      { path: "", includeGitIgnored: "yes" },
    ]) {
      assert.throws(
        () => parseWorkspaceTreeQuery(query),
        (error: unknown) => error instanceof WorkspaceTreeBadRequestError
      );
    }
  });
});
