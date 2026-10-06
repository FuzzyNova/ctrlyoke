import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// Temporary: jest-dom 7 still augments Vitest <= 4's one-parameter
// `Assertion<T>`, which no longer merges with Vitest 5's `Assertion<R, T>`, so
// every jest-dom matcher is missing from `expect()`'s type (the matchers still
// work at runtime). Augmenting `Matchers` also reaches `Assertion` and
// `AsymmetricMatchersContaining`. The type parameter list must repeat Vitest's
// own declaration exactly. Delete this file once jest-dom ships Vitest 5 types:
// https://github.com/testing-library/jest-dom/issues/738
// https://github.com/testing-library/jest-dom/pull/742
declare module "vitest" {
  interface Matchers<R, T> extends TestingLibraryMatchers<unknown, R> {}
}
