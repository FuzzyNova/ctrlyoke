# Custom Icons

This folder contains custom SVG icons for features not available in the VS Code codicon library.

**Location:** `src/ui/icons/` (source assets, not copied to output)

**Output:** Generated CSS is placed in `src/ui/webview/custom-icons.css`

## Icon Source

Icons sourced from [Streamline](https://www.streamlinehq.com/) as needed.

## How It Works

The build system automatically converts all `.svg` files in this folder into CSS classes:

1. **Add SVG file** → Place any SVG in this folder (e.g., `append.svg`)
2. **Run build** → `npm run generate-icons` creates `custom-icons.css`
3. **Use in HTML** → `<i class="custom-icon icon-append"></i>`

**That's it!** No manual copy-paste needed. Just like codicons.

## Usage

### Basic Usage

```html
<!-- Standard 16×16px icon -->
<button>
  <i class="custom-icon icon-append"></i>
  Append
</button>
```

### Size Variants

```html
<!-- Small 14×14px -->
<i class="custom-icon icon-append icon-small"></i>

<!-- Large 20×20px -->
<i class="custom-icon icon-append icon-large"></i>
```

### Multiple Uses

Use the same icon anywhere - the class is reusable:

```html
<button><i class="custom-icon icon-append"></i> Append</button>
<div><i class="custom-icon icon-append"></i> Add to queue</div>
<span><i class="custom-icon icon-append"></i> Attach</span>
```

## Automatic Color Inheritance

Icons use **CSS mask-image** technique:

- Inherits `currentColor` from parent element
- Automatically matches VS Code theme (light/dark/high contrast)
- No color customization needed in SVG files

## SVG Requirements

For best results, use SVGs with:

- **Filled paths** (not strokes) - masks work better with solid shapes
- **Monochrome design** - color will be applied via CSS
- **Simple paths** - cleaner appearance at small sizes
- **24×24 viewBox** - standard icon dimensions

If your SVG uses strokes, the build script will optimize it for mask usage.

## Build Process

```bash
# Generate CSS from all SVG files
npm run generate-icons

# Or run full build (includes icon generation)
npm run compile
```

The script:

1. Reads all `.svg` files from `src/ui/icons/`
2. Optimizes SVGs (removes colors, minifies)
3. Converts to base64 data URIs
4. Generates CSS classes in `src/ui/webview/custom-icons.css`
5. Uses `mask-image` for theme color inheritance

**Note:** SVG source files stay in `src/ui/icons/` and are NOT copied to output. Only the generated CSS (with embedded base64) is copied, keeping the extension package size minimal.

## Current Icons

- `append.svg` - Append to end of queue (when you add it)
- `append-next.svg` - Insert after current prompt (when you add it)

## Example SVG

Here's what a good SVG looks like:

```xml
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 5v14M5 12h14" stroke="#000000" stroke-width="2"/>
</svg>
```

The build script will automatically:

- Remove the `stroke="#000000"` (color)
- Convert to data URI
- Create `.icon-{filename}` class

## Why This Approach?

**Compared to inline SVG:**

- ✅ No copy-paste needed
- ✅ Reusable across multiple locations
- ✅ Automatic build integration
- ✅ Cleaner HTML

**Compared to external files:**

- ✅ Theme color inheritance
- ✅ No additional HTTP requests
- ✅ Works offline/in webviews

**Compared to icon fonts:**

- ✅ No font generation needed
- ✅ Simpler build process
- ✅ Better accessibility

## Debugging

If an icon doesn't appear:

1. Check that SVG file exists in this folder
2. Run `npm run generate-icons` manually
3. Verify `custom-icons.css` was generated
4. Check browser DevTools for CSS mask warnings
5. Ensure parent element has a color (for `currentColor`)
