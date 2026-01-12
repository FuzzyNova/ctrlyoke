# FlightPath Release Guide

This document covers how to build, test, and publish FlightPath as a VS Code extension.

## Table of Contents

1. [Local Testing with VSIX](#local-testing-with-vsix)
2. [Pre-Release Checklist](#pre-release-checklist)
3. [Publishing to VS Code Marketplace](#publishing-to-vs-code-marketplace)
4. [Getting the Verified Publisher Badge](#getting-the-verified-publisher-badge)
5. [Open VSX Registry (Optional)](#open-vsx-registry-optional)
6. [Automated Publishing with CI/CD](#automated-publishing-with-cicd)
7. [Version Management](#version-management)
8. [Troubleshooting](#troubleshooting)

---

## Local Testing with VSIX

Testing a "production" build locally before publishing is essential. This lets you test the extension outside of the debug Extension Development Host.

### Step 1: Install vsce

The `vsce` (Visual Studio Code Extensions) CLI tool is required for packaging:

```powershell
npm install -g @vscode/vsce
```

### Step 2: Build the Extension

Ensure your extension compiles without errors:

```powershell
# Development build (for testing)
npm run compile

# Production build (strips dev commands, minified)
npm run build:prod
```

### Step 3: Package as VSIX

Create a `.vsix` file:

```powershell
vsce package
```

This generates a file like `flightpath-0.1.0.vsix` in the project root.

**Note:** If you see warnings about missing fields (like `repository`, `license`, etc.), you can either:

- Add those fields to `package.json`
- Or use `vsce package --allow-missing-repository` to bypass

### Step 4: Install the VSIX Locally

**Option A: Via VS Code UI**

1. Open VS Code
2. Go to Extensions view (`Ctrl+Shift+X`)
3. Click the `...` menu (top-right of Extensions view)
4. Select **Install from VSIX...**
5. Navigate to and select your `.vsix` file

**Option B: Via Command Line**

```powershell
code --install-extension flightpath-0.1.0.vsix
```

### Step 5: Verify the Installation

1. Reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window")
2. Check the Extensions view - FlightPath should appear as installed
3. Test all functionality manually

### Uninstalling Test Builds

To remove the locally installed extension:

- Via UI: Right-click the extension in Extensions view → Uninstall
- Via CLI: `code --uninstall-extension nhickster.flightpath`

---

## Pre-Release Checklist

Before publishing, ensure:

### Required package.json Fields

```json
{
  "name": "flightpath",
  "displayName": "FlightPath",
  "description": "Automate GitHub Copilot with structured prompt workflows",
  "version": "0.1.0",
  "publisher": "YOUR_PUBLISHER_ID",
  "icon": "images/icon.png",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/nhickster/flightpath"
  },
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other", "Machine Learning"]
}
```

### Required Files

- [ ] `README.md` - Displayed on Marketplace page
- [ ] `CHANGELOG.md` - Version history
- [ ] `LICENSE` - License file (MIT, Apache-2.0, etc.)
- [ ] `images/icon.png` - Extension icon (at least 128x128px, PNG format, NOT SVG)
  - **Note:** Currently only SVG files exist in `images/`. A PNG icon must be created before publishing.
  - See `images/README.md` for design recommendations

### Content Requirements

- [ ] No SVG images in icon
- [ ] All image URLs in README/CHANGELOG use HTTPS
- [ ] Maximum 30 keywords in `package.json`
- [ ] No sensitive data or API keys in source

### Create .vscodeignore

Add a `.vscodeignore` file to exclude unnecessary files from the package:

```
.vscode/**
.vscode-test/**
out/**
!out/extension.js
!out/templates/**
!out/schemas/**
node_modules/**
src/**
.gitignore
.yarnrc
esbuild.js
vsc-extension-quickstart.md
**/tsconfig.json
**/eslint.config.mjs
**/*.map
**/*.ts
**/.vscode-test.*

# Development files
docs/**
manual-test/**
logs/**
prompts/**
.github/**
DEVELOPMENT.md
images/README.md
```

**Note:** The actual `.vscodeignore` file already exists in the project root.

---

## Publishing to VS Code Marketplace

### Step 1: Create an Azure DevOps Organization

1. Go to [Azure DevOps](https://dev.azure.com/)
2. Sign in with your Microsoft account
3. Create a new organization if you don't have one

### Step 2: Create a Personal Access Token (PAT)

1. In Azure DevOps, click your profile icon → **Personal access tokens**
2. Click **New Token**
3. Configure:
   - **Name**: `vscode-marketplace-publish` (or any name)
   - **Organization**: Select **All accessible organizations**
   - **Expiration**: Set as needed (max 1 year)
   - **Scopes**: Click "Show all scopes", then find **Marketplace** → select **Manage**
4. Click **Create**
5. **Copy the token immediately** - you won't see it again!

### Step 3: Create a Publisher

1. Go to the [VS Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
2. Sign in with the same Microsoft account
3. Click **Create publisher**
4. Fill in:
   - **ID**: Unique identifier (e.g., `nhickster`) - **cannot be changed later**
   - **Name**: Display name (e.g., `Nathan Hickey`)
   - **Description**: Optional
   - **Website**: Optional (helps with verification later)
5. Click **Create**

### Step 4: Add Publisher to package.json

```json
{
  "publisher": "nhickster"
}
```

### Step 5: Login with vsce

```powershell
vsce login nhickster
```

Paste your PAT when prompted.

### Step 6: Publish

**Option A: Publish directly**

```powershell
vsce publish
```

**Option B: Publish with version bump**

```powershell
# Bump patch version (0.1.0 → 0.1.1)
vsce publish patch

# Bump minor version (0.1.0 → 0.2.0)
vsce publish minor

# Bump major version (0.1.0 → 1.0.0)
vsce publish major

# Or specify exact version
vsce publish 1.0.0
```

**Option C: Publish manually via web**

1. Run `vsce package` to create the `.vsix`
2. Go to [Publisher Management](https://marketplace.visualstudio.com/manage)
3. Click your publisher
4. Click **New Extension** → **Visual Studio Code**
5. Upload the `.vsix` file

### Step 7: Wait for Processing

The extension typically appears on the Marketplace within 5-10 minutes.

---

## Getting the Verified Publisher Badge

The blue checkmark badge indicates a verified publisher and increases user trust.

### Prerequisites

Before applying for verification, you must meet **all** of these requirements:

1. **Extension age**: Have at least one extension published for **minimum 6 months**
2. **Domain age**: Your verification domain must be registered for **minimum 6 months**
3. **Domain eligibility**:
   - You must control the DNS settings
   - Cannot be a subdomain (e.g., `username.github.io` is NOT eligible)
   - Must use HTTPS
   - Must respond with HTTP 200 to a HEAD request

### Verification Process

1. Go to [Publisher Management](https://marketplace.visualstudio.com/manage)
2. Select your publisher
3. Click the **Details** tab
4. In the **Verified domain** section, enter your eligible domain
5. Click **Save**, then **Verify**
6. A dialog will show you a TXT record to add to your DNS

### Adding the DNS TXT Record

Add a TXT record to your domain's DNS configuration:

- **Host/Name**: `@` or leave blank (depends on your DNS provider)
- **Value**: The verification code provided by Microsoft

Example for common providers:

- **Cloudflare**: DNS → Add Record → TXT
- **GoDaddy**: DNS Management → Add → TXT
- **Namecheap**: Advanced DNS → Add New Record → TXT Record

### Complete Verification

1. Wait for DNS propagation (can take 5 minutes to 48 hours)
2. Return to Publisher Management
3. Click **Verify** again
4. Microsoft reviews within **5 business days**

### Verification Criteria

Microsoft reviews:

- Domain legitimacy
- Extension content eligibility
- Publisher track record
- Trust and positive reputation

### Important Notes

- Changing your publisher **display name** revokes the badge
- Terms of Use violations revoke the badge
- The badge appears in VS Code and on the Marketplace

---

## Open VSX Registry (Optional)

[Open VSX](https://open-vsx.org/) is an alternative marketplace used by:

- VS Codium
- Eclipse Theia
- Gitpod
- Cursor (uses Open VSX)

### Why Publish to Open VSX?

- Reach users of VS Code alternatives
- Required for some enterprise environments
- Broader ecosystem presence

### Publishing to Open VSX

1. Create an account at [open-vsx.org](https://open-vsx.org/)
2. Generate an access token in your account settings
3. Install the ovsx tool:
   ```powershell
   npm install -g ovsx
   ```
4. Publish:
   ```powershell
   ovsx publish -p YOUR_OVSX_TOKEN
   ```
   Or publish a specific VSIX:
   ```powershell
   ovsx publish flightpath-0.1.0.vsix -p YOUR_OVSX_TOKEN
   ```

---

## Automated Publishing with CI/CD

### GitHub Actions Example

Create `.github/workflows/publish.yml`:

```yaml
name: Publish Extension

on:
  release:
    types: [created]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Install dependencies
        run: npm ci

      - name: Build extension
        run: npm run compile

      - name: Package extension
        run: npx vsce package

      - name: Publish to VS Marketplace
        run: npx vsce publish -p ${{ secrets.VSCE_TOKEN }}

      - name: Publish to Open VSX (optional)
        run: npx ovsx publish -p ${{ secrets.OVSX_TOKEN }}
```

### Required Secrets

Add these to your GitHub repository secrets:

- `VSCE_TOKEN`: Your Azure DevOps PAT
- `OVSX_TOKEN`: Your Open VSX token (if publishing there)

---

## Version Management

### Semantic Versioning

FlightPath follows [SemVer](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Pre-Release Versions

For beta testing before official release:

```powershell
vsce publish --pre-release
```

Pre-release recommendations:

- Use `major.ODD.patch` for pre-release (e.g., `0.3.0`)
- Use `major.EVEN.patch` for stable (e.g., `0.2.0`)

Pre-release extensions require VS Code `>= 1.63.0`.

### Platform-Specific Packages

If needed for native dependencies (not currently required for FlightPath):

```powershell
vsce publish --target win32-x64 win32-arm64 darwin-x64 darwin-arm64 linux-x64
```

---

## Troubleshooting

### Common Errors

**"403 Forbidden" or "401 Unauthorized"**

- Ensure PAT has **All accessible organizations** selected
- Verify **Marketplace > Manage** scope is enabled
- Check PAT hasn't expired

**"The extension 'name' already exists"**

- Extension names must be globally unique
- Change the `name` field in `package.json`

**"You exceeded the number of allowed tags of 30"**

- Reduce keywords in `package.json` to 30 or fewer

**Missing required fields**

- Add `publisher`, `repository`, `license` to `package.json`
- Create required files: README.md, CHANGELOG.md, LICENSE

### Debugging Package Contents

Preview what's included in your VSIX:

```powershell
vsce ls
```

Or extract and inspect:

```powershell
# Rename to .zip and extract
Rename-Item flightpath-0.1.0.vsix flightpath-0.1.0.zip
Expand-Archive flightpath-0.1.0.zip -DestinationPath ./extracted
```

### Getting Help

- [VS Marketplace Support](https://marketplace.visualstudio.com/manage) → "Contact Microsoft" (top right)
- [vsce GitHub Issues](https://github.com/microsoft/vscode-vsce/issues)
- [VS Code Extension Documentation](https://code.visualstudio.com/api)

---

## Quick Reference

### Essential Commands

```powershell
# Install vsce
npm install -g @vscode/vsce

# Development build
npm run compile

# Production build (strips dev commands, minified)
npm run build:prod

# Package (runs build:prod automatically via vscode:prepublish)
vsce package

# Install locally
code --install-extension flightpath-0.1.0.vsix

# Login to marketplace
vsce login YOUR_PUBLISHER_ID

# Publish
vsce publish

# Publish with version bump
vsce publish minor

# Unpublish (use with caution)
vsce unpublish YOUR_PUBLISHER_ID.flightpath
```

### Important URLs

- [VS Code Marketplace](https://marketplace.visualstudio.com/vscode)
- [Publisher Management](https://marketplace.visualstudio.com/manage)
- [Azure DevOps (for PAT)](https://dev.azure.com/)
- [Open VSX Registry](https://open-vsx.org/)
- [Publishing Documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
