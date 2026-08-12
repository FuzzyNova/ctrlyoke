/**
 * ESLint rule: a zustand selector must return a stored reference or a primitive,
 * never a freshly allocated object/array.
 *
 * Zustand v5 applies the selector inside `getSnapshot` with no memoization, so a
 * selector that allocates returns a different value on every read.
 * `useSyncExternalStore` then sees the snapshot change in its own mount effect,
 * forces a re-render, reads again, and loops until React throws "Maximum update
 * depth exceeded" (React #185) — taking down the whole component that owns the
 * hook, not just the selector's consumer.
 *
 * The defect is state-gated (a conditional selector only allocates on one
 * branch) and survives component tests that mock the hook, so it is worth
 * catching at author time.
 *
 * Fixes: select the stored value and derive the shape in `useMemo`, or wrap the
 * selector in zustand's `useShallow` (which this rule accepts as sanctioned).
 */

/** Store hooks created by `create(...)`. Matches `useUiStore`, `useWorkflowTemporalStore`, … */
const STORE_HOOK_PATTERN = /^use[A-Z][A-Za-z0-9]*Store$/;

/** React's own hook matches the pattern above but takes no selector. */
const NON_STORE_HOOKS = new Set([
  "useSyncExternalStore",
  "useSyncExternalStoreWithSelector",
]);

/** Zustand's vanilla hook: the selector is the second argument. */
const VANILLA_STORE_HOOKS = new Set(["useStore"]);

/** An explicit equality function makes an allocating selector safe again. */
const EQUALITY_AWARE_HOOKS = new Set([
  "useStoreWithEqualityFn",
  "useShallow",
  "shallow",
]);

/** Instance methods that return a new object/array every call. */
const ALLOCATING_METHODS = new Set([
  "map",
  "filter",
  "slice",
  "concat",
  "flat",
  "flatMap",
  "split",
  "toSorted",
  "toReversed",
  "toSpliced",
  "with",
]);

/** Static helpers that return a new object/array every call. */
const ALLOCATING_STATICS = new Map([
  ["Object", new Set(["keys", "values", "entries", "assign", "fromEntries"])],
  ["Array", new Set(["from", "of"])],
  ["JSON", new Set(["parse"])],
]);

const ALLOCATING_GLOBALS = new Set(["structuredClone"]);

const ALLOCATING_CONSTRUCTORS = new Set([
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  "Array",
  "Object",
  "Date",
]);

const FUNCTION_NODE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

/** Unwraps TS-only wrappers so `({...}) as Foo` is analyzed as the object literal. */
const TRANSPARENT_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

/**
 * @param {import("estree").Node | null | undefined} node
 * @returns {{ node: import("estree").Node, kind: string } | null}
 */
function findAllocation(node) {
  if (!node) {
    return null;
  }

  if (TRANSPARENT_WRAPPERS.has(node.type)) {
    return findAllocation(node.expression);
  }

  switch (node.type) {
    case "ObjectExpression":
      return { node, kind: "object literal" };
    case "ArrayExpression":
      return { node, kind: "array literal" };
    // A conditional/logical selector still loops — but only once execution
    // reaches the branch that allocates, which is why these ship unnoticed.
    case "ConditionalExpression":
      return findAllocation(node.consequent) ?? findAllocation(node.alternate);
    case "LogicalExpression":
      return findAllocation(node.left) ?? findAllocation(node.right);
    case "SequenceExpression":
      return findAllocation(node.expressions[node.expressions.length - 1]);
    case "NewExpression":
      return node.callee.type === "Identifier" &&
        ALLOCATING_CONSTRUCTORS.has(node.callee.name)
        ? { node, kind: `new ${node.callee.name}()` }
        : null;
    case "CallExpression":
      return findAllocatingCall(node);
    default:
      return null;
  }
}

/**
 * @param {import("estree").CallExpression} node
 * @returns {{ node: import("estree").Node, kind: string } | null}
 */
function findAllocatingCall(node) {
  const callee = node.callee;

  if (callee.type === "Identifier" && ALLOCATING_GLOBALS.has(callee.name)) {
    return { node, kind: `${callee.name}()` };
  }

  if (callee.type !== "MemberExpression" || callee.computed) {
    return null;
  }
  if (callee.property.type !== "Identifier") {
    return null;
  }

  const method = callee.property.name;

  if (callee.object.type === "Identifier") {
    const statics = ALLOCATING_STATICS.get(callee.object.name);
    if (statics?.has(method)) {
      return { node, kind: `${callee.object.name}.${method}()` };
    }
  }

  return ALLOCATING_METHODS.has(method) ? { node, kind: `.${method}()` } : null;
}

/**
 * Collects every value the selector can return, without descending into nested
 * functions — a callback's `return` belongs to that callback, not the selector.
 *
 * @param {import("estree").Node} node
 * @param {import("estree").Node[]} results
 */
function collectReturnedExpressions(node, results) {
  for (const key of Object.keys(node)) {
    if (key === "parent") {
      continue;
    }
    const value = node[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!child || typeof child.type !== "string") {
        continue;
      }
      if (FUNCTION_NODE_TYPES.has(child.type)) {
        continue;
      }
      if (child.type === "ReturnStatement") {
        if (child.argument) {
          results.push(child.argument);
        }
        continue;
      }
      collectReturnedExpressions(child, results);
    }
  }
}

/**
 * Resolves the selector argument for a store-hook call, or null when the call
 * is not a selector read this rule should judge.
 *
 * @param {import("estree").CallExpression} node
 */
function getSelectorArgument(node) {
  if (node.callee.type !== "Identifier") {
    return null;
  }
  const name = node.callee.name;

  if (NON_STORE_HOOKS.has(name) || EQUALITY_AWARE_HOOKS.has(name)) {
    return null;
  }

  if (VANILLA_STORE_HOOKS.has(name)) {
    // useStore(store, selector) — a third argument is an equality function.
    return node.arguments.length === 2 ? node.arguments[1] : null;
  }

  if (!STORE_HOOK_PATTERN.test(name)) {
    return null;
  }

  // A second argument is an equality function, which re-stabilizes the read.
  return node.arguments.length === 1 ? node.arguments[0] : null;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow zustand selectors that allocate a new object or array on every read",
    },
    schema: [],
    messages: {
      unstableSelector:
        "Zustand selector allocates on every read ({{kind}}), so useSyncExternalStore re-renders until React throws 'Maximum update depth exceeded' (React #185). Select the stored value and derive this with useMemo, or wrap the selector in useShallow.",
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const selector = getSelectorArgument(node);
        if (!selector) {
          return;
        }

        // `useShallow((s) => ({ … }))` is the sanctioned escape hatch.
        if (
          selector.type === "CallExpression" &&
          selector.callee.type === "Identifier" &&
          EQUALITY_AWARE_HOOKS.has(selector.callee.name)
        ) {
          return;
        }

        if (!FUNCTION_NODE_TYPES.has(selector.type)) {
          return;
        }

        const returned = [];
        if (selector.body.type === "BlockStatement") {
          collectReturnedExpressions(selector.body, returned);
        } else {
          returned.push(selector.body);
        }

        for (const expression of returned) {
          const allocation = findAllocation(expression);
          if (allocation) {
            context.report({
              node: allocation.node,
              messageId: "unstableSelector",
              data: { kind: allocation.kind },
            });
            return;
          }
        }
      },
    };
  },
};
