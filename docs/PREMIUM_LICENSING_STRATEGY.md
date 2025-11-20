# Premium Licensing Strategy for VS Code Extensions

## Overview

This document outlines best practices and implementation strategies for adding premium/pro licensing to VS Code extensions, based on industry research and real-world implementations.

## Table of Contents

- [Key Challenge: No Native Paywall Support](#key-challenge-no-native-paywall-support)
- [Licensing Approaches](#licensing-approaches)
- [Recommended Architecture](#recommended-architecture)
- [Implementation Options](#implementation-options)
- [Security Considerations](#security-considerations)
- [Payment Processing Options](#payment-processing-options)
- [Real-World Examples](#real-world-examples)
- [Implementation Roadmap](#implementation-roadmap)
- [FlightPath-Specific Recommendations](#flightpath-specific-recommendations)

---

## Key Challenge: No Native Paywall Support

**Critical Issue**: VS Code does not natively support premium extensions or license enforcement.

- **Open Issue**: [microsoft/vscode#90648](https://github.com/microsoft/vscode/issues/90648) - "Add support for premium extensions"
- **Fundamental Problem**: All VS Code extensions are distributed as plain JavaScript/TypeScript code that can be:
  - Decompiled and read (even when minified)
  - Modified and republished
  - Bypassed with simple code edits
  - Cloned without paywalls

**Implication**: License validation must be **server-side** with client-side enforcement being treated as a deterrent, not a security measure.

---

## Licensing Approaches

### 1. **License Key Validation (Most Common)**

**Flow**:

1. User purchases license → receives license key via email
2. User enters license key in extension settings/command
3. Extension validates key against server API
4. License status stored securely in `vscode.SecretStorage`
5. Periodic re-validation (daily/weekly) to check for revocations

**Pros**:

- Simple user experience
- Works offline after initial activation
- Industry-standard approach
- No complex OAuth flows

**Cons**:

- Keys can be shared/pirated
- Requires server infrastructure
- Can be bypassed by determined users

**Best For**: Individual developer tools, single-user licenses

---

### 2. **Account-Based Authentication (OAuth)**

**Flow**:

1. User creates account on your website
2. User purchases subscription → account upgraded to Pro
3. Extension uses OAuth to authenticate user
4. Server validates subscription status
5. Access token cached in `vscode.SecretStorage`

**Pros**:

- Harder to share accounts (can detect multiple IPs/devices)
- Better for subscription models
- Can track user analytics
- Enables cross-device license management

**Cons**:

- More complex implementation
- Requires always-online connection (or periodic checks)
- More friction for users
- Requires user account management

**Best For**: Team/enterprise tools, SaaS subscriptions

---

### 3. **VS Code Authentication Provider (Custom)**

**Flow**:

1. Implement `AuthenticationProvider` interface
2. Register custom authentication provider
3. Use `vscode.authentication.getSession()` to manage sessions
4. Validate against your backend

**Pros**:

- Native VS Code integration
- Familiar UX (same as GitHub/Microsoft login)
- Handles token refresh automatically
- Can leverage existing OAuth providers (Auth0, GitHub, etc.)

**Cons**:

- Most complex to implement
- Still requires backend validation
- OAuth setup complexity

**Best For**: Extensions already using authentication for API access

---

### 4. **Hybrid: Free Public Repos, Paid Private Repos (GitLens Model)**

**Flow**:

1. Extension works fully for public repositories (free tier)
2. Advanced features require Pro license for private repos
3. Detect repo visibility via Git API
4. Validate license when accessing private repo features

**Pros**:

- Natural tier differentiation
- Free tier drives adoption
- Clear value proposition

**Cons**:

- Only works for Git-related extensions
- Requires Git integration

**Best For**: Git/GitHub-focused extensions

---

## Recommended Architecture

### **Server-Side Components**

**Required**:

1. **License API Server**
   - Validate license keys
   - Check subscription status
   - Handle activations/deactivations
   - Track usage analytics

2. **Database**
   - Store license keys
   - Link licenses to customers
   - Track activations (device limits)
   - Store subscription metadata

**Technology Options**:

- **Serverless**: AWS Lambda + DynamoDB, Cloudflare Workers + D1
- **Traditional**: Node.js/Express + PostgreSQL on Railway/Render/Fly.io
- **Firebase**: Firestore + Cloud Functions (simple, scales automatically)
- **Supabase**: PostgreSQL + Auth + Edge Functions (all-in-one)

---

### **Client-Side Components (VS Code Extension)**

**Required**:

1. **License Manager**
   - Handle license key input
   - Validate against API
   - Cache validation results
   - Periodic re-validation

2. **Secure Storage**
   - Use `vscode.SecretStorage` API for license keys/tokens
   - **Never** store in `settings.json` (publicly readable)
   - **Never** use environment variables (accessible to all extensions)

3. **Feature Gates**
   - Check license status before enabling Pro features
   - Graceful degradation to free tier
   - Clear messaging about upgrade requirements

---

## Implementation Options

### Option 1: **Simple License Key (Recommended for FlightPath)**

**Stack**:

- **Payment**: Gumroad or LemonSqueezy
- **Storage**: `vscode.SecretStorage` for license key
- **Validation**: Gumroad/LemonSqueezy License API
- **Backend**: None needed (use payment platform's API directly)

**Implementation**:

```typescript
// src/licensing/LicenseManager.ts
import * as vscode from "vscode";

export class LicenseManager {
  private static readonly LICENSE_KEY_STORAGE = "flightpath_license_key";
  private static readonly VALIDATION_CACHE_KEY = "flightpath_license_valid";
  private static readonly VALIDATION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(private context: vscode.ExtensionContext) {}

  async setLicenseKey(key: string): Promise<boolean> {
    // Validate key with payment platform API
    const isValid = await this.validateWithAPI(key);

    if (isValid) {
      await this.context.secrets.store(LicenseManager.LICENSE_KEY_STORAGE, key);
      await this.context.globalState.update(
        LicenseManager.VALIDATION_CACHE_KEY,
        {
          valid: true,
          timestamp: Date.now(),
        }
      );
      return true;
    }

    return false;
  }

  async getLicenseKey(): Promise<string | undefined> {
    return await this.context.secrets.get(LicenseManager.LICENSE_KEY_STORAGE);
  }

  async isProUser(): Promise<boolean> {
    // Check cache first (avoid API calls on every check)
    const cache = this.context.globalState.get<{
      valid: boolean;
      timestamp: number;
    }>(LicenseManager.VALIDATION_CACHE_KEY);

    if (
      cache &&
      Date.now() - cache.timestamp < LicenseManager.VALIDATION_INTERVAL
    ) {
      return cache.valid;
    }

    // Validate with API if cache expired
    const licenseKey = await this.getLicenseKey();
    if (!licenseKey) {
      return false;
    }

    const isValid = await this.validateWithAPI(licenseKey);

    await this.context.globalState.update(LicenseManager.VALIDATION_CACHE_KEY, {
      valid: isValid,
      timestamp: Date.now(),
    });

    return isValid;
  }

  private async validateWithAPI(licenseKey: string): Promise<boolean> {
    try {
      // LemonSqueezy example
      const response = await fetch(
        "https://api.lemonsqueezy.com/v1/licenses/validate",
        {
          method: "POST",
          headers: { Accept: "application/json" },
          body: JSON.stringify({ license_key: licenseKey }),
        }
      );

      const data = await response.json();

      // Verify product ID matches (prevent cross-product key usage)
      const validProduct = data.meta?.product_id === YOUR_PRODUCT_ID;
      const keyValid = data.valid && data.license_key?.status === "active";

      return validProduct && keyValid;
    } catch (error) {
      console.error("License validation failed:", error);
      // Fail open: if API is down, allow cached validation to persist
      return false;
    }
  }

  async removeLicense(): Promise<void> {
    await this.context.secrets.delete(LicenseManager.LICENSE_KEY_STORAGE);
    await this.context.globalState.update(
      LicenseManager.VALIDATION_CACHE_KEY,
      undefined
    );
  }
}
```

**Usage in FlightPath**:

```typescript
// src/flightpath/FlightPathManager.ts
export class FlightPathManager {
  private licenseManager: LicenseManager;

  constructor(context: vscode.ExtensionContext) {
    this.licenseManager = new LicenseManager(context);
  }

  async executeWorkflow(filePath: string): Promise<void> {
    const config = await this.loadConfig(filePath);

    // Check if dynamic queue is enabled and requires Pro
    if (config.enableDynamicQueue || config.unlimitedMode) {
      const isPro = await this.licenseManager.isProUser();

      if (!isPro) {
        const action = await vscode.window.showWarningMessage(
          "Dynamic queue features require FlightPath Pro. Upgrade to unlock unlimited workflows.",
          "Upgrade",
          "Continue with Free"
        );

        if (action === "Upgrade") {
          vscode.env.openExternal(
            vscode.Uri.parse("https://flightpath.dev/pricing")
          );
          return;
        }

        // Disable Pro features
        config.enableDynamicQueue = false;
        config.unlimitedMode = false;
      }
    }

    // Continue execution...
  }
}
```

**Commands to Register**:

```typescript
// package.json
{
  "contributes": {
    "commands": [
      {
        "command": "flightpath.activateLicense",
        "title": "FlightPath: Activate Pro License"
      },
      {
        "command": "flightpath.checkLicenseStatus",
        "title": "FlightPath: Check License Status"
      },
      {
        "command": "flightpath.removeLicense",
        "title": "FlightPath: Remove License"
      }
    ]
  }
}
```

```typescript
// src/extension.ts
vscode.commands.registerCommand("flightpath.activateLicense", async () => {
  const licenseKey = await vscode.window.showInputBox({
    prompt: "Enter your FlightPath Pro license key",
    password: true,
    placeHolder: "XXXX-XXXX-XXXX-XXXX",
  });

  if (licenseKey) {
    const isValid = await licenseManager.setLicenseKey(licenseKey);

    if (isValid) {
      vscode.window.showInformationMessage(
        "✅ FlightPath Pro activated successfully!"
      );
    } else {
      vscode.window.showErrorMessage(
        "❌ Invalid license key. Please check and try again."
      );
    }
  }
});
```

---

### Option 2: **OAuth Authentication (More Complex)**

**Stack**:

- **Auth Provider**: Auth0, Firebase Auth, Supabase Auth
- **Payment**: Stripe (webhook to upgrade account)
- **Backend**: Node.js API or Firebase Functions
- **Storage**: `vscode.SecretStorage` for access tokens

**Implementation**:

```typescript
// src/licensing/AuthenticationProvider.ts
import {
  authentication,
  AuthenticationProvider,
  AuthenticationSession,
} from "vscode";

export class FlightPathAuthProvider implements AuthenticationProvider {
  private static readonly AUTH_TYPE = "flightpath";
  private static readonly AUTH_NAME = "FlightPath";

  onDidChangeSessions = this._sessionChangeEmitter.event;
  private _sessionChangeEmitter =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();

  async getSessions(): Promise<readonly AuthenticationSession[]> {
    const token = await this.context.secrets.get("flightpath_access_token");
    if (!token) return [];

    // Return cached session
    return [
      {
        id: "flightpath-session",
        accessToken: token,
        account: { id: "user", label: "FlightPath User" },
        scopes: [],
      },
    ];
  }

  async createSession(scopes: string[]): Promise<AuthenticationSession> {
    // Open browser for OAuth flow
    const authUrl = "https://your-auth-server.com/oauth/authorize";
    vscode.env.openExternal(vscode.Uri.parse(authUrl));

    // Start local server to receive callback
    // (Complex - see full OAuth implementation examples)

    // Store token in SecretStorage
    await this.context.secrets.store("flightpath_access_token", accessToken);

    return {
      id: "flightpath-session",
      accessToken,
      account: { id: userId, label: userEmail },
      scopes,
    };
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.context.secrets.delete("flightpath_access_token");
    this._sessionChangeEmitter.fire({
      added: [],
      removed: [{ id: sessionId }],
      changed: [],
    });
  }
}
```

**When to Use**: If you need user accounts for other features (analytics, cloud sync, team management).

---

## Security Considerations

### **What You CANNOT Prevent**

1. ❌ Code inspection (extensions are plain JS)
2. ❌ Local modification (users can edit files)
3. ❌ Republishing without paywall
4. ❌ Determined attackers bypassing checks

### **What You CAN Do**

1. ✅ **Server-side validation** - License checks happen on your server
2. ✅ **Obfuscation** - Minify/uglify code (makes casual inspection harder)
3. ✅ **Periodic re-validation** - Check license daily/weekly
4. ✅ **Device limits** - Limit activations per license
5. ✅ **Revocation support** - Disable stolen/refunded licenses
6. ✅ **Analytics** - Detect suspicious usage patterns
7. ✅ **Legal deterrents** - Terms of Service, DMCA takedowns

### **Best Practices**

#### 1. Use `vscode.SecretStorage` for Sensitive Data

```typescript
// ✅ CORRECT: SecretStorage (encrypted, per-extension)
await context.secrets.store("license_key", key);

// ❌ WRONG: Settings (public, readable by all extensions)
vscode.workspace.getConfiguration().update("flightpath.licenseKey", key);

// ❌ WRONG: Environment variables (accessible to all extensions)
process.env.LICENSE_KEY = key;
```

#### 2. Validate Product ID Server-Side

```typescript
// Prevent license keys from other products being used
const response = await validateLicense(key);

if (response.meta.product_id !== YOUR_HARDCODED_PRODUCT_ID) {
  throw new Error("Invalid license key");
}
```

#### 3. Implement Activation Limits

```typescript
// LemonSqueezy example - track device instances
const activationData = await activateLicense(key, {
  instance_name: vscode.env.machineId, // Unique per VS Code installation
});

if (
  activationData.license_key.activation_usage >
  activationData.license_key.activation_limit
) {
  throw new Error("Activation limit exceeded");
}
```

#### 4. Graceful Degradation

```typescript
async function checkFeatureAccess(
  feature: "dynamicQueue" | "unlimitedMode"
): Promise<boolean> {
  try {
    const isPro = await licenseManager.isProUser();

    if (!isPro) {
      showUpgradePrompt(feature);
      return false;
    }

    return true;
  } catch (error) {
    // If license check fails (network down), allow cached validation
    console.error("License check failed:", error);
    return licenseManager.getCachedStatus();
  }
}
```

#### 5. Clear User Communication

```typescript
// Good: Explain why upgrade is needed
vscode.window.showInformationMessage(
  "Dynamic queue requires FlightPath Pro (unlimited prompts & execution time).",
  "Learn More",
  "Upgrade"
);

// Bad: Just block without explanation
throw new Error("Pro license required");
```

---

## Payment Processing Options

### **1. Gumroad** (Easiest)

**Pros**:

- Simplest setup (5 minutes)
- Built-in license key generation
- Email delivery automatic
- License API included
- No monthly fees (8.5% + 30¢ per sale)

**Cons**:

- Less control over checkout flow
- Limited analytics
- Perceived as "indie" (not enterprise-grade)

**API**:

```bash
curl https://api.gumroad.com/v2/licenses/verify \
  -d "product_id=YOUR_PRODUCT_ID" \
  -d "license_key=CUSTOMER_KEY" \
  -X POST
```

**Best For**: Solo developers, simple licensing, getting started fast

---

### **2. LemonSqueezy** (Recommended)

**Pros**:

- Better UX than Gumroad
- License API with activation tracking
- Subscription support
- Webhook notifications
- EU VAT/tax handling automatic
- Lower fees (5% + payment processor)

**Cons**:

- Newer platform (less established)
- Slightly more complex setup

**API**:

```bash
curl -X POST https://api.lemonsqueezy.com/v1/licenses/validate \
  -H "Accept: application/json" \
  -d "license_key=CUSTOMER_KEY"
```

**Best For**: Professional indie devs, subscription products

---

### **3. Stripe** (Most Flexible)

**Pros**:

- Complete control
- Enterprise-grade
- Subscription management
- Webhooks for everything
- Global payment support

**Cons**:

- Must build license system yourself
- More complex integration
- Requires backend server
- 2.9% + 30¢ per transaction

**Implementation**:

- User buys → Stripe webhook fires
- Your backend creates license key
- Store in database
- Email customer (or auto-deliver via Stripe)

**Best For**: Scaling to enterprise, complex pricing models

---

### **4. Paddle** (SaaS Focused)

**Pros**:

- Merchant of record (handles all tax)
- Subscription billing
- International sales easy

**Cons**:

- Higher fees (5% + payment processing)
- More complex than Gumroad/LemonSqueezy

**Best For**: B2B SaaS, international sales, teams

---

## Real-World Examples

### **1. GitLens (Free + Pro)**

**Model**: Free for public repos, Pro for private repos + advanced features

**Implementation**:

- Uses `vscode.authentication` for GitKraken account
- Server-side validation of subscription status
- Feature gates based on repo visibility
- Graceful prompts to upgrade

**Takeaway**: Freemium with clear value differentiation works well

---

### **2. GitHub Copilot**

**Model**: Subscription-based, requires Microsoft/GitHub account

**Implementation**:

- OAuth via Microsoft authentication provider
- Monthly subscription via GitHub
- Token-based access validation
- Offline grace period (works without connection briefly)

**Takeaway**: Account-based works for established brands

---

### **3. Various Indie Extensions**

**Common Pattern** (from reverse engineering research):

1. License key stored in `SecretStorage`
2. MD5/SHA256 hash validation (client-side only - insecure)
3. No server validation (easily bypassed)

**Takeaway**: Many extensions have weak licensing - don't follow this pattern

---

## Implementation Roadmap

### **Phase 1: Foundation (1-2 weeks)**

**Goal**: Set up payment processing and basic license validation

**Tasks**:

1. Choose payment platform (LemonSqueezy recommended)
2. Create product with license key generation
3. Implement `LicenseManager` class
4. Add `vscode.SecretStorage` integration
5. Create license activation command
6. Test license validation API

**Deliverables**:

- Working license key input
- Server-side validation
- Secure storage

---

### **Phase 2: Feature Gates (1 week)**

**Goal**: Lock Pro features behind license check

**Tasks**:

1. Identify Pro features (dynamic queue, unlimited mode)
2. Add `isProUser()` checks before Pro features
3. Implement graceful degradation (disable Pro features if no license)
4. Add upgrade prompts with clear messaging
5. Update settings schema with Pro badges

**Deliverables**:

- Pro features require valid license
- Clear upgrade CTAs

---

### **Phase 3: UX Polish (1 week)**

**Goal**: Make licensing seamless and user-friendly

**Tasks**:

1. Add license status indicator (status bar item)
2. Create welcome screen for new Pro users
3. Implement periodic re-validation (daily)
4. Add "Check License Status" command
5. Handle edge cases (expired licenses, refunds, revocations)
6. Add analytics (how many Pro vs Free users)

**Deliverables**:

- Polished license management experience
- Clear status visibility

---

### **Phase 4: Documentation & Launch (1 week)**

**Goal**: Prepare for public launch

**Tasks**:

1. Write pricing page
2. Create license activation docs
3. FAQ for common issues
4. Support email setup
5. Monitor first sales and respond to issues

**Deliverables**:

- Complete documentation
- Support infrastructure
- Public launch

---

## FlightPath-Specific Recommendations

### **Proposed Pricing Tiers**

#### **Free Tier**

- Static workflows (no dynamic queue)
- Max 10 prompts per workflow
- Max 1 hour execution time
- All core features

#### **Pro Tier** ($29 one-time or $9/month)

- Dynamic queue expansion (Copilot can add prompts)
- Unlimited prompts per workflow
- Unlimited execution time
- Priority support
- Early access to new features

#### **Enterprise Tier** (Custom pricing)

- Team license (5+ seats)
- SSO integration
- Dedicated support
- Custom feature requests

---

### **Feature Gate Mapping**

| Feature                              | Free        | Pro           |
| ------------------------------------ | ----------- | ------------- |
| Static workflows                     | ✅          | ✅            |
| Dynamic queue (`enableDynamicQueue`) | ❌          | ✅            |
| Unlimited mode (`unlimitedMode`)     | ❌          | ✅            |
| `maxQueueSize`                       | 10          | ∞             |
| `maxExecutionTime`                   | 3600s (1hr) | ∞             |
| End condition scripts                | ✅          | ✅            |
| CLI integration                      | ✅          | ✅            |
| Dashboard                            | ✅          | ✅ (enhanced) |

---

### **Recommended Implementation**

**Stack**:

- **Payment**: LemonSqueezy (license keys + subscriptions)
- **Storage**: `vscode.SecretStorage` (license key)
- **Validation**: LemonSqueezy License API
- **Backend**: None needed (use LemonSqueezy directly)

**Rationale**:

- Simple to implement (no custom backend)
- Professional payment flow
- Works offline after activation
- Easy to maintain
- Can scale to subscriptions later

---

### **Code Changes Required**

**New Files**:

- `src/licensing/LicenseManager.ts` - Core licensing logic
- `src/licensing/ProFeatures.ts` - Feature gate constants

**Modified Files**:

- `src/extension.ts` - Register license commands
- `src/flightpath/FlightPathManager.ts` - Add Pro checks
- `src/flightpath/PromptQueue.ts` - Enforce queue limits
- `package.json` - Add commands and settings
- `README.md` - Document Pro features

**Settings Changes**:

```json
{
  "flightpath.enableDynamicQueue": {
    "type": "boolean",
    "default": false,
    "markdownDescription": "🔒 **Pro Feature**: Allow Copilot to extend workflows dynamically. [Upgrade to Pro](https://flightpath.dev/pricing)",
    "order": 10
  },
  "flightpath.maxQueueSize": {
    "type": "number",
    "default": 10,
    "markdownDescription": "Maximum prompts (Free: 10, Pro: Unlimited)",
    "order": 12
  }
}
```

---

## Conclusion

**Recommended Approach for FlightPath**:

1. ✅ **Use LemonSqueezy** for payment processing (simple, professional)
2. ✅ **License key validation** (server-side, cached locally)
3. ✅ **`vscode.SecretStorage`** for secure key storage
4. ✅ **Feature gates** for dynamic queue and unlimited mode
5. ✅ **Graceful degradation** (free tier still useful)
6. ✅ **Clear upgrade prompts** (explain value, link to pricing)

**Timeline**: 3-4 weeks from start to launch

**Budget**: $0 upfront (LemonSqueezy is pay-as-you-go)

**Risk**: Low (can always pivot to free-only if sales don't materialize)

---

## Additional Resources

**VS Code APIs**:

- [SecretStorage API](https://code.visualstudio.com/api/references/vscode-api#SecretStorage)
- [Authentication API](https://code.visualstudio.com/api/references/vscode-api#authentication)

**Payment Platforms**:

- [LemonSqueezy License API](https://docs.lemonsqueezy.com/guides/tutorials/license-keys)
- [Gumroad License API](https://gumroad.com/help/article/76-license-keys)

**Examples**:

- [VS Code Auth Provider Tutorial](https://www.eliostruyf.com/create-authentication-provider-visual-studio-code/)
- [SecretStorage Tutorial](https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco)

**Security**:

- [VS Code Extension Security](https://code.visualstudio.com/api/references/extension-manifest#security)
- [Reverse Engineering Example](https://hackd.net/posts/reverse-engineering-license-validation-in-a-vs-code-extension/) (learn what NOT to do)

---

**Next Steps**:

1. Review this document
2. Choose payment platform (recommend LemonSqueezy)
3. Define Pro feature set
4. Implement Phase 1 (foundation)
5. Test with beta users
6. Launch Pro tier
