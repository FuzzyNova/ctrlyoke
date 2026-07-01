# FlightPath Rebrand — Naming Options & Decisions

**Created:** June 27, 2026
**Context:** Trademark clearance found **"FlightPath" is a high-risk mark** — an attorney would not clear it, and the search turned up a crowded field of live `FLIGHTPATH` software/SaaS marks in the relevant classes (IC 009 downloadable software, IC 042 SaaS). Decision: **rebrand before marketplace launch.** See `trademark-search-results.csv` for the clearance data.

---

## ✅ Decision — Decouple the workflow file extension from the product name

Workflow files move **from** `*.flightpath.yml` / `*.flightpath.json` **to** `*.workflow.yml` / `*.workflow.json`.

**Why:**

- **Most source-accurate name** — the engine is `WorkflowOrchestrator` / `WorkflowInstance` / `WorkflowExecutor` / `WorkflowStateMachine`; the schema models a _workflow of steps_.
- **Self-documenting** — the file literally says what it is.
- **Future-proof** — a later product rename never has to touch workflow files; they stay `workflow.yml/json` regardless of the brand.

> Note: the legacy `.flightpath/` runtime dir, log filenames, config keys, and `package.json` metadata still need migration as part of the overall rename — tracked separately from this extension decision.

---

## Legend

- ⭐ **Top contender** — user-verified available (no USPTO / domain conflict found)
- ~~strikethrough~~ — **clear conflict** (reason noted)
- plain — candidate, not fully vetted
- ⚠️ — available but flagged for a non-conflict reason (pronunciation, association, etc.)

---

## ⭐ Top contenders (verified available)

| Name              | Origin                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ⭐ **yokerun**    | yoke (harness) + run; runny-yolk pun; CLI-friendly short form of yokerunner (fallback)                                       |
| ⭐ **harpsicode** | harpsichord + code                                                                                                           |
| ⭐ **harnesser**  | one who harnesses (the AI harnesses)                                                                                         |
| ⭐ **sequince**   | misspelled "sequence" (runs a sequence of steps); also evokes "sequins" — **close second / fallback; weaker mark, see note** |
| ⭐ **ctrlyoke**   | "control yoke" = an aircraft's steering control (aviation heritage) + yoke/harness metaphor; `ctrl`-key styling              |

> **ctrlyoke note:** `ctrlyoke.dev/.com` **and** `controlyoke.dev/.com` all available — grab all four, redirect the full-word/`.com` forms to `.dev` (kills the typo/phonetic leak that sank ctrlpath). No TM. "Control yoke" is generic only for _aircraft parts_; for **software** it's an **arbitrary** mark → strongly protectable (Apple-for-computers logic), no need to rely on stylization. Unifies both core metaphors: aviation control (yoke = flight control) + harness (yoke = team harness). **Now the front-runner** — also wins on CLI ergonomics: `ctrlyoke run` / `validate` / `commit` all read cleanly, whereas `yokerun run` stutters and `yokerun validate/commit` fights the "run" in the name.

> **Eliminated since last pass (June 27):** ~~coductor~~ (coductor.com taken) · ~~codeyoke~~ (popular YouTube channel — brand/SEO collision) · ~~sequincer~~ (taken — MIDI music software).

> **sequince note (close second):** `.com`/`.dev` available, no direct TM hit. **But weaker than ctrlyoke as a mark:** USPTO treats an intentional misspelling of a _descriptive_ term as still descriptive (TMEP 1209.03(j); cf. "Lite"/"Kwik"), and "sequence" describes a sequence-runner → likely descriptive, hard to protect without acquired distinctiveness. Also revives the **spell-on-hearing leak** that sank flowCMD — the natural spelling "sequence" is taken/crowded, so word-of-mouth traffic bleeds away. ctrlyoke avoids both (arbitrary = strong mark; owns `controlyoke.*` too). Note: proper-spelled "sequence" is taken with many marks.

---

## Original name

- ~~**FlightPath**~~ — high-risk mark; reason for the rebrand. Attorney would not clear.

---

## First batch — distinctive/coined (all found taken)

- ~~Agentry~~ (taken)
- ~~Vela~~ (taken)
- ~~Apogee~~ (taken)
- ~~Maestral~~ (taken; also an OSS Dropbox client)
- ~~Tarmac~~ (taken; Tarmac PLC TM)
- ~~Slipstream~~ (taken)
- ~~Apron~~ (taken)
- ~~Hangar~~ (taken)
- ~~Outpost~~ (taken)
- ~~Ground Control~~ (taken / weak as a mark)

---

## Fuzz / Nova family

**Available / candidates:**

- FuzzControl (available; set aside)
- FuzzFlow (available)
- Workfuzz (available)
- FuzzDeck, FuzzBridge, FuzzTower, FuzzHelm
- FuzzFleet, FuzzCrew
- FuzzDrive, FuzzRun
- NovaDeck, NovaControl, NovaPilot, Novacast
- Fuzzlane, Fuzzworks, Fuzzwise, Fuzzline, Fuzzara, Fuzzika, Fuzzix, Fuzzly, Fuzzify
- Fuzzpath, Novapath
- ⚠️ Fuzzter (available but **sounds identical to "fuzzer"** — avoid)

**Conflicts:**

- ~~FuzzCode~~ (USPTO + domain available, BUT near-collision with **fuzzycode.dev** — an active kids' coding platform — plus a strong "fuzzer" association; abandoned)
- ~~NovaCode~~ (not available)
- ~~Fuzzo~~ ~~Fuzzon~~ ~~Fuzzar~~ ~~Fuzzova~~ (all taken)
- ~~Fuzzit~~ (real fuzzing-as-a-service company, acquired by GitLab)

---

## Control / flow / path / plan (direction mostly abandoned)

**Candidates:**

- flowCMD / FlowController / FlowCommander (available) — ⚠️ rejected: "C-M-D vs command" pronunciation ambiguity; "sounds like a plumbing product"
- stepctrl, stepcontrol (available) — ⚠️ `control` is a recurring crowded/near-miss word
- Path coinages: Volopath, Avipath, Arcpath, Trekpath, Lumapath, Cuepath, Steerpath, Relaypath, Fuzzpath, Novapath

**Conflicts:**

- ~~ctrlpath~~ (phonetic collision with **controlpath.dev** — an active TypeScript dev tool; "ctrl path" = "control path")
- ~~ctrlplan / controlplan~~ ("control plane" — ubiquitous devops term, many TMs; `plan` vs `plane` too close)
- ~~flowctrl~~ (flowctrl.dev owned)
- ~~xpath~~ (XML) ~~classpath~~ (Java) ~~glidepath~~ (finance/aviation) ~~datapath~~ / ~~fastpath~~ / ~~hotpath~~ (CS/CPU terms) ~~syspath~~ (Python)

---

## Plan / map / route / navigation

**Candidates:**

- Novaplan, Cueplan, Voloplan, Planweave, Planforge
- Cuemap, Cueroute, Coursemap, Runmap
- Cairn, Sextant, Lodestar, Rhumb (single-word, navigation theme)

**Conflicts:**

- ~~arcplan~~ (BI software) ~~arcmap~~ (Esri GIS) ~~roadmap~~ ~~mindmap~~ ~~compass~~ (MongoDB +) ~~atlas~~ ~~pathfinder~~ ~~waypoint~~ (HashiCorp) — all taken

---

## Step / sequence

**Candidates:**

- stepctrl, stepcontrol (available)
- Stepwright, Stepforge, Steplane, Steprunner
- Ordo, Sequon, Seqforge, Seqplan, Runsteps
- Rung, Gait (single-word)
- Trajix

**Conflicts:**

- ~~cadence~~ (Temporal/Uber workflow engine) ~~stepwise~~ ~~stepladder~~ (fintech) ~~stepway~~ (Dacia) ~~stride~~ (Atlassian/health) ~~codex~~ (OpenAI) ~~echelon~~ (Peloton rival) ~~loom~~ (Loom video) ~~stanza~~ — all taken

---

## Harness / agent / driver — single words

**Candidates:**

- Harnix, Agentwright, Operative, Handler, Tradecraft
- Tack, Bridle, Musher, Teamster, Drover, Mahout, Jockey, Dray
- Yokova, Harnova, Coharness, Harnessworks

**Conflicts:**

- ~~Yoke~~ (alone — many collisions incl. an IaC tool)
- ~~Wrangler~~ (Jeep TM + data-wrangler tools) ~~Conductor / Conduktor~~ (Netflix Conductor workflow engine / Kafka tool) ~~Maestro~~ (mobile-testing framework) ~~Agentforce~~ (Salesforce) ~~AgentKit~~ (OpenAI) ~~Agency~~ ~~Rig~~ — all taken / generic

---

## Yoke compounds

- ⭐ **yokerun** (top contender) — CLI-friendly short form of yokerunner
- ~~codeyoke~~ (popular YouTube channel — eliminated)
- yokesmith, yokewright, yokeup, yokeworks, yokeforge, yokeline, yokedeck, yokeflow
- doubleyoke, goldenyoke, softyoke, yoker, yoken, yokely

---

## Blends / portmanteaus

**Cue:** cuemmand, cuequence, cuestrate, cueductor, cuechestra, cuelay, cuevo
**Harness:** harnestrate, harnestro, harnova, harnduct, harnsemble
**Code:** codestro, codestrate, codemand, coduct, codeography, codenza, ~~codeyoke~~, ⭐harpsicode
**Command / reins:** reigncode, coachmand, commandence, reinstra, batonix, conductr, ~~coductor~~ (coductor.com taken)
**Sequence / queue / flow:** quemand, flowstrate, seqestra, workestra, relayquence
**Single coined:** Reignix, Codessa, Orcada, Maestrix

---

## Orchestral / conductor + code / driver blends

**Orchestral / conductor:** Impresa, Syncode, Maestrun, Batorun, Navestro, Scoreflow, Crescend, Rondex, Overtura, Tuttify, Virtuo, Symphagent, Podiom
**Code / driver:** Navcode, Navrun, Governode, Helmrun, Helmestro, Coxrun, Coxcode, Steerun, Steercode, Chariot, Chariorun, Drovecode, Enginode, Railman

---

## Agent recommendation pass — June 27, 2026

**Current-list favorites:**

- **coductor** — strongest overall fit; short, CLI-friendly, and maps to conducting multi-step AI coding workflows across harnesses.
- **codeyoke** — distinctive and harness-relevant, though "yoke" is less immediately familiar.
- **Harnix** — good coined single-word shape; less descriptive than coductor.
- **Agentwright** — strong AI-agent/workflow signal; a bit long.
- **Yokewright** — stronger than yokerunner because it suggests crafting/controlling workflows.
- **Seqforge** — good sequence/workflow signal; maybe slightly generic.
- **Planforge** — works if the product leans more into planning/workflow authoring.
- **Runsteps** — plain and understandable; less premium.
- **Workfuzz** — viable if tying tightly to Fuzzy Nova parent branding.
- **FuzzFlow** — workable, but "flow" remains crowded and less distinctive.

**Current-list names to down-rank:**

- **harpsicode** — clever but too whimsical and hard to explain.
- **harnesser** — awkward as a product name.
- **yokerunner** — memorable but too punny; the "yoke" metaphor has to carry too much.
- **FuzzControl / NovaControl / FlowController / FlowCommander** — control/flow terms feel crowded and less ownable.
- **Path / route / map / pilot / helm / compass / waypoint variants** — too close to the FlightPath naming problem space.

---

## New candidates — made-up single word coinage

- Codemuster
- Promptwright
- Queuewright
- Runwright
- Taskwright
- Agentloom
- Codebraid
- Promptbraid
- Runbraid
- Queueforge
- Taskforge
- Stepmark
- Runmark
- Runloop
- Codestack
- Agentstack
- Promptstack
- Workqueue
- Codemarshal
- Agentmarshal
- Promptmill
- Codemill
- Runmill
- Workmill
- Taskmill
- Codemotive
- Promptmotive
- Runmotive
- Codetandem
- Agenttandem
- Tasktandem
- Promptlane
- Codelane
- Aistral
- Agentra
- Cuestra
- Codaxis
- Promptix
- Runvex
- Stepra
- Quevora
- Taskora
- Orqestra
- Codora
- Promptiq
- Runexa
- Tasken
- Agentive
- Codelyn
- Routiq
- Sequora

---

## New candidates — two words merged / portmanteaus

- queuemmander (queue + commander)
- promptductor (prompt + conductor)
- codeductor (code + conductor)
- taskductor (task + conductor)
- agentductor (agent + conductor)
- runstructor (run + orchestrator/instructor)
- promptchestrate (prompt + orchestrate)
- codechestrate (code + orchestrate)
- taskchestrate (task + orchestrate)
- queuechestrate (queue + orchestrate)
- stepchestrate (step + orchestrate)
- agentchestrate (agent + orchestrate)
- queuence (queue + sequence)
- promptquence (prompt + sequence)
- codequence (code + sequence)
- taskquence (task + sequence)
- runquence (run + sequence)
- workquence (work + sequence)
- stepqueue (step + queue)
- promptqueue (prompt + queue)
- codequeue (code + queue)
- taskqueue (task + queue)
- agentqueue (agent + queue)
- queuerunner (queue + runner)
- promptrunner (prompt + runner)
- coderunner (code + runner)
- taskrunner (task + runner)
- agentrunner (agent + runner)
- promptpilot (prompt + pilot) ⚠️ navigation-adjacent
- codepilot (code + pilot) ⚠️ crowded / navigation-adjacent
- agentpilot (agent + pilot) ⚠️ navigation-adjacent
- stepmarshal (step + marshal)
- promptmarshal (prompt + marshal)
- taskmarshal (task + marshal)
- codemarshal (code + marshal)
- runmarshal (run + marshal)
- promptweave (prompt + weave)
- codeweave (code + weave)
- taskweave (task + weave)
- queueweave (queue + weave)

---

## New candidates — double word options

- Code Muster
- Prompt Wright
- Queue Wright
- Run Wright
- Task Wright
- Agent Loom
- Code Braid
- Prompt Braid
- Run Braid
- Queue Forge
- Task Forge
- Step Mark
- Run Mark
- Prompt Dock
- Agent Dock
- Code Relay
- Prompt Relay
- Task Relay
- Agent Stack
- Prompt Stack
- Work Queue
- Task Queue
- Code Marshal
- Agent Marshal
- Prompt Mill
- Code Mill
- Run Mill
- Work Mill
- Task Mill
- Code Motive
- Prompt Motive
- Run Motive
- Code Tandem
- Agent Tandem
- Task Tandem
- Prompt Lane
- Code Lane
- Queue Loom
- Task Loom
- Run Loom
