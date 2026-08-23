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
        sort: { key: "name", direction: "ascending" },
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
      { path: "", sortKey: "name" },
      { path: "", sortDirection: "ascending" },
      { path: "", sortKey: "unknown", sortDirection: "ascending" },
      { path: "", sortKey: "name", sortDirection: "sideways" },
    ]) {
      assert.throws(
        () => parseWorkspaceTreeQuery(query),
        (error: unknown) => error instanceof WorkspaceTreeBadRequestError
      );
    }
  });

  test("parses the supported sort fields and defaults absent sort", () => {
    assert.deepStrictEqual(
      parseWorkspaceTreeQuery({
        path: "",
        sortKey: "modifiedAt",
        sortDirection: "descending",
      }),
      {
        path: "",
        includeGitIgnored: false,
        sort: { key: "modifiedAt", direction: "descending" },
      }
    );
    const defaultRequest = parseWorkspaceTreeQuery({ path: "" });
    assert.ok(!("listingId" in defaultRequest));
    assert.deepStrictEqual(defaultRequest.sort, {
      key: "name",
      direction: "ascending",
    });
  });

  test("rejects sort fields on range requests", () => {
    assert.throws(
      () =>
        parseWorkspaceTreeQuery({
          listingId: "00000000-0000-4000-8000-000000000001",
          offset: "0",
          sortKey: "name",
          sortDirection: "ascending",
        }),
      (error: unknown) => error instanceof WorkspaceTreeBadRequestError
    );
  });
});
