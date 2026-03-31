# AI Agent CLI Harness Priority Analysis

**Date:** March 19, 2026  
**Status:** Ready for Review  
**Author:** FlightPath Research

---

## Executive Summary

This document analyzes AI agent CLI tool adoption to prioritize future FlightPath harness integrations. Based on GitHub stars, user adoption, growth trajectory, and strategic fit, **Gemini CLI** emerges as the highest-priority next harness, followed by **Qwen Code** for Asia-Pacific markets.

**Key Finding:** While Cline has strong VS Code extension adoption (5M+ installs), its CLI version is nascent. Gemini CLI (98.4k stars in <1 year) and Qwen Code (20.8k stars, strong in Asia) offer better CLI-native opportunities.

---

## Current FlightPath Harness Coverage

As of March 2026, FlightPath supports:

| Harness        | Status        | Integration Date |
| -------------- | ------------- | ---------------- |
| `copilot-cli`  | ✅ Production | Initial release  |
| `copilot-chat` | ✅ Production | Initial release  |
| `claude-cli`   | ✅ Production | Initial release  |
| `codex-cli`    | ✅ Production | Initial release  |
| `opencode-cli` | ✅ Production | v1.1.0           |

**Gap Analysis:** Missing major players: **Gemini CLI**, **Qwen Code**, **Aider**, **Goose**

---

## Market Landscape: AI Agent CLI Tools (March 2026)

### GitHub Stars & User Adoption

| Tool                        | GitHub Stars   | Users/Installs   | Monthly Active  | Launch Date    | Growth Rate               |
| --------------------------- | -------------- | ---------------- | --------------- | -------------- | ------------------------- |
| **Gemini CLI** (Google)     | 98.4k          | -                | ~10% of devs    | June 2025      | 30k stars in 2 days       |
| **Claude Code** (Anthropic) | 80k            | ~200K+ devs      | -               | May 2025       | 0→80k in 10 months        |
| **Codex CLI** (OpenAI)      | 66.3k          | 1M+ (first week) | -               | Jan 2026       | Tripled users in 2 months |
| **Aider**                   | 42.2k          | 4.1M installs    | 15B tokens/week | 2023 (mature)  | Stable growth             |
| **Goose** (Block)           | 33.3k          | -                | -               | 2025           | Linux Foundation backed   |
| **Qwen Code** (Alibaba)     | 20.8k          | -                | -               | Late 2025      | Strong in Asia            |
| **Cline CLI**               | New (CLI only) | 5M+ (VSCode ext) | -               | Feb 2026 (CLI) | Early stage               |

**Note:** Cline's 5M+ installs are for the **VS Code extension**, not the CLI (which launched Feb 2026).

---

### Developer Usage Statistics (Pragmatic Engineer Survey, Jan-Feb 2026, 900+ respondents)

**Most-Used AI Agent Tools:**

| Rank | Tool               | Usage %   | "Loved" % | Notes                         |
| ---- | ------------------ | --------- | --------- | ----------------------------- |
| 1    | **Claude Code**    | 46%       | 46%       | #1 most-used agent            |
| 2    | **Codex**          | 26%       | -         | 60% of Cursor users           |
| 3    | **Gemini CLI**     | ~10%      | -         | 107 mentions                  |
| 4    | **OpenCode**       | ~10%      | -         | Popular with Staff+ engineers |
| 5-10 | Aider, Goose, Qwen | <10% each | -         | Niche but growing             |

**Key Insights:**

- **95%** use AI tools at least weekly
- **55%** regularly use AI agents (63.5% for Staff+ engineers)
- **70%** use 2-4 tools simultaneously
- **Company size drives choice:** Claude Code dominates startups (75% at <50 employees), GitHub Copilot dominates enterprises (56% at 10K+ employees)

---

## Detailed Tool Analysis

### 1. Gemini CLI (Google) — 🥇 **HIGHEST PRIORITY**

**GitHub:** `google-gemini/gemini-cli`  
**Stars:** 98.4k | **Forks:** 12.4k  
**Launch:** June 2025

#### Why Gemini CLI?

**Strengths:**

- ✅ **Explosive adoption:** 30k stars in 2 days (fastest CLI agent launch)
- ✅ **Google backing:** Long-term viability, enterprise trust
- ✅ **Free tier:** 1,000 requests/day free (major adoption driver)
- ✅ **Structured output:** `text`, `json`, `stream-json` modes
- ✅ **Session management:** JSON log files with `messages` array
- ✅ **Mode-based permissions:** `plan`, `default`, `auto_edit`, `yolo`
- ✅ **MCP support:** Native Model Context Protocol integration
- ✅ **Multi-modal:** Image, code, and text understanding

**Output Format:**

```json
{"type":"init","session_id":"UUID","model":"gemini-2.5-pro"}
{"type":"message","role":"assistant","content":"Hello!","delta":true}
{"type":"tool_use","tool_name":"run_shell_command","tool_id":"id_0","parameters":{"command":"ls -la"}}
{"type":"result","status":"success","stats":{"total_tokens":11155}}
```

**Log Location:** `~/.gemini/tmp/<project-name>/chats/session-<timestamp>-<uuid>.json`

**Completion Detection:** Process exit (headless) + log file monitoring (interactive)

**Integration Complexity:** **Low-Medium** (similar to Claude Code architecture)

**Estimated Effort:** 20-30 hours (Phase 1 MVP)

#### Why NOT Higher Priority Before Now?

Gemini CLI launched in **June 2025** — it's relatively new. The 98.4k stars represent <1 year of growth, making it the **fastest-growing CLI agent** by star velocity.

---

### 2. Qwen Code (Alibaba) — 🥈 **SECOND PRIORITY**

**GitHub:** `QwenLM/qwen-code`  
**Stars:** 20.8k | **Forks:** 1.8k  
**Launch:** Late 2025

#### Why Qwen Code?

**Strengths:**

- ✅ **Asia-Pacific dominance:** 17.4k stars in Chinese market (per Chinese docs)
- ✅ **Open-source:** Apache 2.0 license
- ✅ **Structured output:** `text`, `json`, `stream-json` modes
- ✅ **Session management:** JSONL log files (`~/.qwen/projects/<cwd>/chats/<session-id>.jsonl`)
- ✅ **10 lifecycle hooks:** SessionStart, Stop, PreToolUse, PostToolUse, etc.
- ✅ **Mode-based permissions:** `default`, `auto_edit`, `yolo`
- ✅ **MCP support:** Native integration
- ✅ **Qwen3-Coder optimized:** Best performance on Qwen models

**Output Format:**

```json
{"type":"system","subtype":"init","uuid":"UUID","session_id":"UUID","model":"coder-model"}
{"type":"assistant","uuid":"UUID","message":{"content":[{"type":"text","text":"Hi!"}]}}
{"type":"result","subtype":"success","usage":{"total_tokens":16825}}
```

**Hook System:** 10 lifecycle events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd, etc.)

**Integration Complexity:** **Medium** (hooks are experimental, less documented than Claude)

**Estimated Effort:** 25-35 hours (Phase 1 MVP)

#### Strategic Value

- **Geographic expansion:** Strong presence in Asia-Pacific markets
- **Model diversity:** Access to Qwen3-Coder (top open-source coding model)
- **Enterprise adoption:** Alibaba Cloud integration for Chinese enterprises

---

### 3. Aider — 🥉 **THIRD PRIORITY**

**GitHub:** `Aider-AI/aider`  
**Stars:** 42.2k | **Installs:** 4.1M | **Usage:** 15B tokens/week  
**Launch:** 2023 (mature)

#### Why Aider?

**Strengths:**

- ✅ **Mature & stable:** Pioneer of terminal AI pair programming (2023 launch)
- ✅ **Git-native:** Every AI edit = auto-commit (full traceability)
- ✅ **Power-user favorite:** Strong reputation among senior engineers
- ✅ **100+ languages:** Broadest language support
- ✅ **75+ LLM providers:** Maximum model flexibility
- ✅ **Python-based:** Simple architecture, easy to integrate

**Weaknesses:**

- ❌ **Python:** Different from FlightPath's TypeScript stack (minor)
- ❌ **No TUI:** Minimal CLI interface (no fancy terminal UI)
- ❌ **Slower growth:** Mature tool, less hype-driven adoption

**Integration Complexity:** **Low** (Python, well-documented)

**Estimated Effort:** 15-20 hours (Phase 1 MVP)

---

### 4. Goose (Block) — **FOURTH PRIORITY**

**GitHub:** `block/goose`  
**Stars:** 33.3k  
**Launch:** 2025

#### Why Goose?

**Strengths:**

- ✅ **Block (Square) backing:** Corporate support, enterprise viability
- ✅ **Linux Foundation Agentic AI Foundation:** Long-term open-source stewardship
- ✅ **MCP co-designer:** Deep Model Context Protocol integration
- ✅ **TypeScript-based:** Matches FlightPath tech stack
- ✅ **SOC 2 compliance:** Enterprise-ready

**Weaknesses:**

- ❌ **Smaller user base:** 33.3k stars (vs. 98.4k Gemini)
- ❌ **Niche adoption:** Less mainstream than Gemini/Qwen

**Integration Complexity:** **Medium** (TypeScript, MCP-native)

**Estimated Effort:** 20-25 hours (Phase 1 MVP)

---

### 5. Cline CLI — **LOWER PRIORITY**

**GitHub:** `cline/cline` (extension), CLI launched Feb 2026  
**Extension Installs:** 5M+ | **CLI:** Early stage  
**Launch:** Feb 2026 (CLI)

#### Why NOT High Priority?

**Strengths:**

- ✅ **VS Code extension success:** 5M+ installs, 59.1k stars
- ✅ **Fastest-growing AI OSS project 2025:** +4704% YoY (extension)
- ✅ **CLI launched:** `cline task "prompt" --json` (Feb 2026)
- ✅ **Structured JSON output:** JSONL format similar to Claude Code
- ✅ **Task management:** Numeric task IDs, `~/.cline/data/tasks/<id>/` storage

**Weaknesses:**

- ❌ **CLI is nascent:** Launched Feb 2026 (<1 month old as of March 2026)
- ❌ **Unproven CLI adoption:** 5M installs are for VS Code extension, not CLI
- ❌ **Architecture overlap:** Similar to Claude Code/Codex (less differentiation)
- ❌ **Hook system unclear:** `--hooks-dir` flag exists but documentation sparse

**Integration Complexity:** **Medium** (new CLI, less battle-tested)

**Estimated Effort:** 20-30 hours (Phase 1 MVP)

#### Recommendation

**Wait 3-6 months** for Cline CLI to mature. The extension is proven, but the CLI needs time to stabilize and build adoption. Revisit in Q3 2026.

---

## Why Gemini CLI Over Qwen Code?

Both are strong candidates, but **Gemini CLI** edges out for these reasons:

| Factor                  | Gemini CLI                | Qwen Code                     | Winner            |
| ----------------------- | ------------------------- | ----------------------------- | ----------------- |
| **GitHub stars**        | 98.4k                     | 20.8k                         | Gemini (4.7x)     |
| **Star velocity**       | 30k in 2 days             | 10k in 1 month                | Gemini            |
| **Geographic reach**    | Global                    | Asia-Pacific focused          | Gemini            |
| **Corporate backing**   | Google                    | Alibaba                       | Tie (both strong) |
| **Free tier**           | 1,000 requests/day        | Limited                       | Gemini            |
| **Documentation**       | Mature (10 months)        | Emerging (6 months)           | Gemini            |
| **Hook maturity**       | Stable                    | Experimental                  | Gemini            |
| **Model quality**       | Gemini 2.5 Pro (top-tier) | Qwen3-Coder (top open-source) | Tie               |
| **Enterprise adoption** | 75% Google Cloud adoption | Growing in Asia               | Gemini            |

**Verdict:** Gemini CLI has **4.7x more GitHub stars**, **faster adoption velocity**, **better global reach**, and **more mature documentation**. Qwen Code is strong for Asia-Pacific expansion but should be **second priority**.

---

## Why NOT Cline CLI (Yet)?

Despite Cline's VS Code extension success (5M+ installs), the **CLI is too new**:

1. **Launched Feb 2026** — Less than 1 month old (as of March 2026)
2. **No CLI adoption data** — 5M installs are for the extension, not CLI
3. **Unproven architecture** — CLI codebase is separate from extension
4. **Documentation gaps** — Hook system, task storage format still evolving
5. **Overlap with existing harnesses** — Similar to Claude Code/Codex (less differentiation)

**Recommendation:** Wait until **Q3 2026** (6+ months post-launch) to reassess. If Cline CLI gains 10k+ stars and proves stable, revisit integration.

---

## Integration Priority Recommendation

### **Priority 1: Gemini CLI** (Q2 2026)

**Rationale:**

- 98.4k GitHub stars (fastest-growing CLI agent)
- Google backing + free tier = sustained adoption
- Mature documentation (10 months old)
- Structured output (`stream-json`) matches FlightPath architecture
- Mode-based permissions (`plan`, `default`, `auto_edit`, `yolo`)
- MCP support for advanced integrations

**Estimated Effort:** 20-30 hours  
**Files to Create:**

```
src/flightpath/harness/gemini/
├── GeminiCliProvider.ts
├── GeminiResponseParser.ts
├── GeminiNotificationMonitor.ts
├── GeminiToolPermissionMapper.ts
└── GeminiLogParser.ts
```

**Phase 1 MVP:**

- Headless mode with `--output-format stream-json`
- Process-exit completion detection
- Session ID extraction from `init` events
- Mode-based permission mapping

**See:** `docs/research/GEMINI_INTEGRATION_PLAN.md` (full implementation plan)

---

### **Priority 2: Qwen Code** (Q3 2026)

**Rationale:**

- 20.8k GitHub stars (strong in Asia-Pacific)
- Alibaba Cloud enterprise integration
- 10 lifecycle hooks (advanced automation)
- Qwen3-Coder model access (top open-source coding model)

**Estimated Effort:** 25-35 hours  
**Files to Create:**

```
src/flightpath/harness/qwen/
├── QwenCliProvider.ts
├── QwenResponseParser.ts
├── QwenNotificationMonitor.ts
├── QwenToolPermissionMapper.ts
└── QwenLogParser.ts
```

**Phase 1 MVP:**

- Headless mode with `--output-format stream-json`
- Process-exit completion detection
- Session ID extraction from `init` events
- Experimental hook support (optional, Phase 3)

**See:** `docs/research/QWEN_INTEGRATION_RESEARCH.md` (full research)

---

### **Priority 3: Aider** (Q4 2026)

**Rationale:**

- 42.2k GitHub stars, 4.1M installs
- Git-native workflow (unique differentiation)
- Power-user favorite (strong reputation)
- Mature, stable (2023 launch)

**Estimated Effort:** 15-20 hours  
**Files to Create:**

```
src/flightpath/harness/aider/
├── AiderCliProvider.ts
├── AiderResponseParser.ts
├── AiderNotificationMonitor.ts
├── AiderToolPermissionMapper.ts
└── AiderLogParser.ts
```

**Key Differentiator:** Git-auto-commit workflow (every AI edit = reviewable commit)

---

### **Priority 4: Goose** (Q4 2026 or later)

**Rationale:**

- 33.3k GitHub stars
- Linux Foundation backing (long-term viability)
- MCP co-designer (synergy with FlightPath MCP server)
- Enterprise-ready (SOC 2 compliance)

**Estimated Effort:** 20-25 hours

---

### **Priority 5: Cline CLI** (Q3 2026 or later — reassess)

**Rationale:**

- Wait for CLI to mature (launched Feb 2026)
- Need 6+ months of CLI adoption data
- Revisit if CLI reaches 10k+ stars

**Current Status:** Too early to commit resources

---

## Market Trends & Strategic Insights

### 1. CLI Agents Are Winning

**55% of developers** now regularly use AI agents (63.5% for Staff+ engineers). Terminal-based agents (Claude Code, Codex, Gemini CLI) are outpacing IDE extensions for complex tasks because:

- **Better context management:** Full repo access, no IDE limitations
- **Automation-friendly:** Scriptable, CI/CD integration
- **Model flexibility:** Switch between providers easily

### 2. Company Size Drives Tool Choice

| Company Size         | Dominant Tool                        | Why                                |
| -------------------- | ------------------------------------ | ---------------------------------- |
| **<50 employees**    | Claude Code (75%)                    | Free to start, best performance    |
| **50-10K employees** | Mixed (Claude Code, Codex, OpenCode) | Flexibility, cost optimization     |
| **10K+ employees**   | GitHub Copilot (56%)                 | Enterprise procurement, compliance |

**Implication for FlightPath:** Supporting multiple harnesses lets you serve all market segments.

### 3. Open-Source Is Dominating

**OpenCode** (112k stars), **Aider** (42.2k stars), and **Goose** (33.3k stars) prove developers prefer open-source tools they can audit and extend. FlightPath's open-core model aligns well with this trend.

### 4. MCP Is the Future

**Model Context Protocol** is becoming the standard for AI tool integration. Goose (MCP co-designer), Gemini CLI, and Qwen Code all support MCP natively. FlightPath's MCP server (`flightpath-mcp`) positions you well for this shift.

---

## Competitive Landscape

### FlightPath vs. Other AI Orchestrators

| Tool           | Harnesses Supported                        | Workflow Automation    | MCP Support          |
| -------------- | ------------------------------------------ | ---------------------- | -------------------- |
| **FlightPath** | 5 (copilot, claude, codex, opencode, chat) | ✅ YAML/JSON workflows | ✅ Yes               |
| **OpenCode**   | 75+ providers                              | ❌ Single-prompt only  | ✅ Yes               |
| **Aider**      | 75+ providers                              | ❌ Git-native only     | ❌ No                |
| **Goose**      | Multiple (MCP-native)                      | ✅ YAML workflows      | ✅ Yes (co-designer) |
| **Cursor**     | Proprietary models                         | ❌ IDE-only            | ❌ No                |

**FlightPath Differentiation:**

- **Multi-harness orchestration:** Run Claude Code → Codex → Copilot in single workflow
- **End condition validation:** Script-based completion checks with retries
- **Pause/resume support:** Long-running workflow resilience
- **MCP server:** External queue management from CLI harnesses

**Adding Gemini CLI strengthens:** Model diversity, Google ecosystem integration, free tier access

---

## Implementation Roadmap

### Q2 2026 (April-June)

**Focus:** Gemini CLI integration

**Deliverables:**

- ✅ `src/flightpath/harness/gemini/` (5 files)
- ✅ Gemini model constants (`src/utils/ModelConstants.ts`)
- ✅ VS Code settings (`flightpath.geminiCliModel`)
- ✅ Harness enum value (`Harness.GeminiCli`)
- ✅ Integration factory registration
- ✅ Manual test workflows

**Timeline:** 2-3 weeks  
**Risk:** Low (well-documented, similar to Claude Code)

---

### Q3 2026 (July-September)

**Focus:** Qwen Code integration + Cline CLI reassessment

**Deliverables:**

- ✅ `src/flightpath/harness/qwen/` (5 files)
- ✅ Qwen model constants
- ✅ VS Code settings (`flightpath.qwenCliModel`)
- ✅ Harness enum value (`Harness.QwenCli`)
- ✅ **Reassess Cline CLI** (if 10k+ stars, proceed with integration)

**Timeline:** 3-4 weeks  
**Risk:** Medium (experimental hooks, less documentation)

---

### Q4 2026 (October-December)

**Focus:** Aider + Goose (parallel or sequential)

**Deliverables:**

- ✅ `src/flightpath/harness/aider/` (5 files)
- ✅ `src/flightpath/harness/goose/` (5 files)
- ✅ Git-native workflow support (Aider)
- ✅ Enhanced MCP integration (Goose)

**Timeline:** 4-6 weeks  
**Risk:** Low (both mature, well-documented)

---

## Success Metrics

### Adoption Targets (12 months post-integration)

| Harness    | Target Users | Target % of FlightPath Workflows |
| ---------- | ------------ | -------------------------------- |
| Gemini CLI | 10K+         | 20%                              |
| Qwen Code  | 5K+          | 10% (20% in Asia-Pacific)        |
| Aider      | 15K+         | 25%                              |
| Goose      | 5K+          | 10%                              |

### Technical Success Criteria

- ✅ All harnesses pass existing test suite (~7,700 lines, 19 test files)
- ✅ Zero breaking changes to existing harnesses
- ✅ MCP server compatibility with all new harnesses
- ✅ Documentation complete (README, integration guides, troubleshooting)

---

## Risks & Mitigations

### Risk 1: Gemini CLI Deprecates Output Format

**Mitigation:** Abstract output parsing behind `GeminiResponseParser` interface. Monitor Gemini CLI releases for breaking changes.

### Risk 2: Qwen Code Hooks Remain Experimental

**Mitigation:** Phase 1 uses process-exit detection (no hooks). Add hook support in Phase 3 when stable.

### Risk 3: Cline CLI Gains Traction Faster Than Expected

**Mitigation:** Reassess quarterly. If Cline CLI hits 10k+ stars by June 2026, fast-track integration (swap with Qwen Code priority).

### Risk 4: New Competitor Emerges (e.g., Amazon Q CLI, Meta CodeLlama CLI)

**Mitigation:** FlightPath's composition architecture (`CliIntegration` generic class) makes adding new harnesses low-effort (20-30 hours). Monitor quarterly.

---

## Conclusion

**Immediate Action:** Implement **Gemini CLI** in Q2 2026.

**Why Gemini CLI?**

- 98.4k GitHub stars (fastest-growing CLI agent)
- Google backing + free tier = sustained adoption
- Mature documentation (10 months old)
- Architecture aligns with FlightPath (similar to Claude Code)
- Global reach (not geographically limited like Qwen Code)

**Secondary Priority:** Qwen Code in Q3 2026 for Asia-Pacific expansion and model diversity.

**Wait-and-See:** Cline CLI (reassess Q3 2026), Aider/Goose (Q4 2026).

**Strategic Outcome:** By end of 2026, FlightPath will support **9+ harnesses** covering all major AI agent CLIs, positioning it as the **most comprehensive AI workflow orchestration platform**.

---

## Appendix A: Data Sources

1. **GitHub Star Counts** (March 19, 2026):
   - Gemini CLI: 98.4k (github.com/google-gemini/gemini-cli)
   - Claude Code: 80k (github.com/anthropics/claude-code)
   - Codex CLI: 66.3k (github.com/openai/codex)
   - Aider: 42.2k (github.com/Aider-AI/aider)
   - Goose: 33.3k (github.com/block/goose)
   - Qwen Code: 20.8k (github.com/QwenLM/qwen-code)
   - Cline: 59.1k (github.com/cline/cline) — extension only

2. **User Adoption Surveys:**
   - Pragmatic Engineer Survey (Jan-Feb 2026, 900+ respondents)
   - Stack Overflow Developer Survey 2025 (84% AI tool adoption)
   - Morph LLM "15 AI Coding Agents Tested" (March 2026)

3. **Tool Documentation:**
   - Gemini CLI docs (gemini.google.com/docs/cli)
   - Qwen Code docs (qwenlm.github.io/qwen-code-docs/)
   - Aider docs (aider.chat)
   - Goose docs (block.github.io/goose/)

4. **Existing FlightPath Research:**
   - `docs/research/GEMINI_INTEGRATION_PLAN.md` (March 17, 2026)
   - `docs/research/QWEN_INTEGRATION_RESEARCH.md` (March 13, 2026)
   - `docs/research/CLINE_INTEGRATION_PLAN.md` (March 19, 2026)

---

## Appendix B: Quick Reference — Harness Comparison

| Feature                | Gemini CLI         | Qwen Code                | Aider       | Goose          | Cline CLI        |
| ---------------------- | ------------------ | ------------------------ | ----------- | -------------- | ---------------- |
| **Stars**              | 98.4k              | 20.8k                    | 42.2k       | 33.3k          | New (CLI)        |
| **Launch**             | Jun 2025           | Late 2025                | 2023        | 2025           | Feb 2026         |
| **Output Format**      | JSON, stream-json  | JSON, stream-json        | Text, JSON  | JSON           | JSON             |
| **Session Management** | JSON log files     | JSONL log files          | Git commits | MCP sessions   | Task storage     |
| **Hook System**        | Stable (8+ events) | Experimental (10 events) | ❌ No       | ✅ MCP-native  | ⚠️ Unclear       |
| **Permission Model**   | Modes (4 levels)   | Modes (3 levels)         | Git-based   | MCP policies   | Modes (3 levels) |
| **MCP Support**        | ✅ Yes             | ✅ Yes                   | ❌ No       | ✅ Co-designer | ✅ Yes           |
| **Free Tier**          | ✅ 1K requests/day | ❌ Limited               | ✅ BYOK     | ✅ BYOK        | ✅ BYOK          |
| **Integration Effort** | 20-30 hrs          | 25-35 hrs                | 15-20 hrs   | 20-25 hrs      | 20-30 hrs        |
| **Priority**           | 🥇 Q2 2026         | 🥈 Q3 2026               | 🥉 Q4 2026  | 4th Q4 2026    | 5th Reassess     |

---

**Document Version:** 1.0  
**Last Updated:** March 19, 2026  
**Next Review:** June 2026 (post-Gemini CLI integration)
