/**
 * BuildConfig - Build-time configuration constants
 *
 * These constants are replaced by esbuild at build time using the `define` option.
 * This enables dead code elimination in production builds.
 *
 * Usage:
 *   import { IS_DEV_MODE } from './utils/BuildConfig';
 *   if (IS_DEV_MODE) {
 *     // This code is removed in production builds
 *   }
 *
 * Build commands:
 *   npm run compile     - Dev build (IS_DEV_MODE = true)
 *   npm run build:prod  - Production build (IS_DEV_MODE = false)
 */

/**
 * Declare the build-time constant that esbuild will replace.
 * The 'declare' tells TypeScript this is defined externally.
 */
declare const __DEV_MODE__: boolean;

/**
 * Whether we're in development mode.
 *
 * - true: Dev commands are registered, verbose logging enabled
 * - false: Dev commands hidden, production-ready
 *
 * In dev builds, esbuild defines __DEV_MODE__ = true
 * In prod builds, esbuild defines __DEV_MODE__ = false
 *
 * The typeof check prevents runtime errors if __DEV_MODE__ is somehow undefined.
 */
export const IS_DEV_MODE: boolean =
  typeof __DEV_MODE__ !== "undefined" ? __DEV_MODE__ : true;

/**
 * Build timestamp - useful for debugging version issues
 */
declare const __BUILD_DATE__: string;
export const BUILD_DATE: string =
  typeof __BUILD_DATE__ !== "undefined"
    ? __BUILD_DATE__
    : new Date().toISOString();
