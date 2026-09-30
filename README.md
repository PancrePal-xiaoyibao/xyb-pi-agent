<div align="center">

<img src="docs/image/readme/logo.png" alt="小胰宝" width="108" />

# 小胰宝

### 面向肿瘤患者及家属的本地优先 AI 桌面工作台

**把病例资料、AI 助手、用药/报告/康复流程，装进一个长期可用的桌面环境。**

本地优先 · 模型自由 · 插件驱动 · macOS / Windows / Linux

<br />

[![Release](https://img.shields.io/github/v/release/vastsa/PI-Desktop?label=release)](https://github.com/vastsa/PI-Desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/vastsa/PI-Desktop/total?label=downloads)](https://github.com/vastsa/PI-Desktop/releases)
[![Stars](https://img.shields.io/github/stars/vastsa/PI-Desktop?style=flat\&label=stars)](https://github.com/vastsa/PI-Desktop/stargazers)
[![CI](https://github.com/vastsa/PI-Desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/vastsa/PI-Desktop/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/vastsa/PI-Desktop)](LICENSE)
[![Reddit](https://img.shields.io/badge/Reddit-r%2FAIUO-FF4500?logo=reddit\&logoColor=white)](https://www.reddit.com/r/AIUO/)

<br />

**[Download](https://github.com/vastsa/PI-Desktop/releases/latest)** ·
[Documentation](https://pi-docs.aiuo.net/) ·
[Build a Plugin](docs/plugin-development.md) ·
[Contributing Extensions](XYB-EXTENSIONS.md) ·
[Screenshots](docs/guide/screenshots.md) ·
[简体中文](README.zh-CN.md)

<br />

<img src="docs/image/readme/home.webp" alt="PI-Desktop" width="94%" />

<br />

**Your projects stay local · Your models stay replaceable · Your workspace stays yours**

</div>

> **Current release line: 0.16.x (Early Preview).**

---

## Build for the community: plugins, skills, and MCP

**Start with [`XYB-EXTENSIONS.md`](XYB-EXTENSIONS.md)** — the extension contribution spec for this
fork. It is written so you can hand it to an AI coding agent as-is: how to pick a channel, the
permission red lines, the "out-of-the-box vs. installer size" rules, and the gates a change has to
pass before it lands.

| Channel | Where it lives | Ships in the installer? |
| --- | --- | --- |
| **Skills** (prompt layer) | `apps/desktop/resources/skills/*.md`, or a plugin's `skills/*.md` | **Yes** — a skill is a few KB |
| **Plugins** | `apps/desktop/resources/plugins/**` (bundled), or the plugin market (user-installed) | Bundled baseline only |
| **MCP servers** | declared in a plugin's `manifest.json` → `contributes.mcpServers` | Only the declaration, never the server runtime |

### Which source does what

| Role | Owner | Setup needed | Notes |
| --- | --- | --- | --- |
| Keyword / criteria search (**primary**) | **ClinicalTrials.gov API v2** | none | A real search API: authoritative, live, free |
| Chinese registries | **ChiCTR** (+ the China drug trial registry) | ChiCTR fetches its package on first use; the drug registry needs the user's own browser session | Most Chinese trials are registered there |
| Detail by identifier / cross-check | **Veeva CTV GraphQL** | none | Anonymous (measured ~1s, 37 fields), zero setup |
| Extra fields | Veeva CTV | none (direct detail query) | Eligibility criteria, keywords, arms and MeSH terms the CSV export lacks |
| Change monitoring | Veeva CTV watchlists + the local index | a local index is required | "Is there an update?" needs stored history |
| Local subset search (**supplementary only**) | the Veeva local index | a local index is required, and **coverage must be declared** | Results must state "index covers N studies as of &lt;date&gt;"; zero hits must never be phrased as "there are no such trials" |

Normative upstream specs: [`docs/plugin-development.md`](docs/plugin-development.md) (zero-to-one
guide, §6.2 skills, §6.9 MCP) and [`docs/spec/07-plugins/`](docs/spec/07-plugins/) (contracts;
[`13-plugin-permissions-matrix.md`](docs/spec/07-plugins/13-plugin-permissions-matrix.md) is the
one to read first). Fork-side field notes: [`XYB-SKILLHUB.md`](XYB-SKILLHUB.md),
[`XYB-TRIAL-SOURCES.md`](XYB-TRIAL-SOURCES.md).

## Skills for cancer patients and families

小胰宝 ships a set of skills built around what patients and families actually need — not generic agent demos.

<table>
<tr>

<td width="33%" valign="top">

### My Records

`xyb.records`

Collect pathology, imaging and lab reports into a **local** folder, and turn them into a plain-language summary you can read yourself or hand to someone else.

</td>

<td width="33%" valign="top">

### Find Trials

`xyb.trials`

Search public clinical trials against your own situation — treatment line, drugs already used, biomarkers — and get back the registry ID, recruitment status and a link to the original record.

</td>

<td width="33%" valign="top">

### Track Progress

`xyb.news`

Gather recent drug and research entries. Title, source and date only; every item links back to the original.

</td>

</tr>
</table>

Each of these is a **skill**: a plain Markdown document the agent loads on demand, paired with an optional view in the right-hand work panel. Read it, edit it, or swap in your own.

**What these skills never do:**

- **Local-first** — records stay on your machine. No account, no cloud.
- **Redacted before inference** — names, phone numbers and hospital names are masked before anything reaches a model.
- **Always sourced** — every trial and research item carries a link and a fetch date.
- **No medical judgement** — no diagnosis, no drug recommendations, no hospital or doctor rankings.

---

## Capability guide

The three above work out of the box. 小胰宝 ships **8 plugins, 17 skills and 3 local data-source services**
in total — here is what each one does, when to use it, what it needs, and where it comes from.

### 1. Works out of the box

| Panel | Plugin | What it does | When to use it |
|---|---|---|---|
| My Records | `xyb.records` | Collects pathology, imaging and lab reports into a local folder and writes a plain-language summary | Reports are scattered and you want them in one place |
| Find Trials | `xyb.trials` | Searches ClinicalTrials.gov against treatment line, prior drugs and biomarkers | You want to see what is currently recruiting |
| Track Progress | `xyb.news` | Gathers recent drug and research entries — title, source, date only | You want to know what changed lately |
| Assistants | `xyb.assistants` | 9 patient-facing assistant skills (next section) | See the table below |
| File Manager / Browser | `pi.file-manager` `pi.browser` | The workspace's built-in file and web tools | You need to inspect local files or look something up |

### 2. Assistants: 9 patient-facing skills

| Skill | When to use it |
|---|---|
| Medical record | You have a pathology report or discharge summary and want to understand it |
| Imaging | You are reading a CT / MRI / PET report and want the wording explained |
| Genomics | You have an NGS report and want to know what the variants imply |
| Pathology | You want the IHC and molecular pathology markers explained |
| Decision support | You are weighing several options and want a clear trade-off table |
| Nutrition | Appetite is poor or weight is dropping |
| Psychological support | Things are hard and you want to sort out what you feel |
| Complications | Pain, jaundice, ascites — you want to understand what is happening |
| MDT round prep | You want to organise your material from a multidisciplinary angle before a visit |

> These assistants **structure and explain** — they do not diagnose, do not recommend drugs,
> and do not rank hospitals or doctors. Each one is a plain Markdown document you can read,
> edit, or replace with your own.

### 3. China & regional trial sources (opt-in)

This plugin asks for a **separate grant**: it declares `mcp.server.local`, which allows it to
launch local processes. If you would rather not, leave it disabled — nothing above is affected.

| Source | Coverage | When to use it | What it needs first |
|---|---|---|---|
| ChiCTR | Trials registered in China (including investigator-initiated) | Trials that only exist in the Chinese registry | First run pulls an npm package; depends on Playwright Chromium (~570 MB) |
| Veeva CTV | Global study library, filterable to China | Seeing how multinational sponsors lay out their global studies | `ctv-mcp-server` must be installed locally **and a local index must be built first** |
| China Drug Trials Registry | Drug trials registered in China | CTR numbers and Chinese registration details | Python 3 (the agent can install the dependencies), plus **a session you provide from your own browser** |

> CAPTCHAs and anti-scraping measures are never bypassed. When a session expires we say so
> instead of guessing, and ask you to provide a fresh one.
> If a source is unreachable, we say "this one could not be reached" rather than
> substituting results from another source.

### 4. External skills (from opencare-skillhub)

These 4 are not built in-house; they live in `xyb.skillpack`. **Enabling the plugin is all it takes** —
no further configuration.

| Skill | What it does | Readiness |
|---|---|---|
| Advanced trial matching | 8-dimension search plan, dual-source retrieval, line-by-line eligibility, R1–R5 rules, alternatives when nothing matches | Fully usable |
| Record organiser | 6-step workflow, 11-category taxonomy, timeline, gap detection | Methodology layer (needs local OCR / transcription tools) |
| Distress screening | HADS anxiety and depression screening, grading and referral guidance, self-harm crisis handling | Fully usable (entirely local) |
| Tumour marker trends | Organises CA19-9 / CEA / AFP history into a trend table, with interpretation boundaries | Methodology layer (upstream needs the `xyb` CLI) |

**"Readiness" is an honest label.** Where it says "methodology layer", the skill provides the
process and the method; if a step needs a tool this machine does not have, the agent says so
plainly rather than pretending the work was done.

### 5. Dependencies: what can block you

| Dependency | Affects | How to get it |
|---|---|---|
| None | My Records / Find Trials / Track Progress / Assistants / External skills | Works out of the box |
| Enabling `xyb.trial-sources` | The three China sources | Enable it in the plugin page (this grants the local-process permission) |
| Network + Playwright Chromium (~570 MB) | ChiCTR search | Fetched on first use |
| Local `ctv-mcp-server` + a built index | Veeva CTV search | Install it yourself and build the index, otherwise you get `INDEX_EMPTY` (which is not the same as "no matching studies") |
| Python 3 | China Drug Trials Registry | The agent can install the dependencies; **Python itself is on you** |
| Your own browser session | Same as above | Copy the in-site search request as cURL and hand it to the agent; you will need to refresh it when it expires |

> Scraping runs **record by record** (about 1.5 s apart). With many records it takes minutes —
> this is not a cache lookup.

### Appendix: how these capabilities are layered

This is what decides **when you can just ask, and when something has to be configured**.

<img src="docs/image/readme/xyb-family-scenarios.png" alt="Four questions a family member asks, and which layer each one lands on" width="94%" />

Three of the four things families ask for most need **nothing but a skill** — no network,
no setup, no permission. The execution layer only gets involved when real external data
has to be fetched.

<img src="docs/image/readme/xyb-trial-search-layers.png" alt="What each layer does during one real trial search" width="94%" />

That second one is a real search (B7-H3, recruiting in China). The layer that changed the
outcome most was the lightest one: switching the default condition from pancreatic cancer
to `solid tumor` took the result from 6 trials to 20.

### 6. Upstream & sources

| Part | Source |
|---|---|
| Upstream foundation | [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) (LGPL-3.0) |
| 小胰宝 customisation | [PancrePal-xiaoyibao/xyb-pi-agent](https://github.com/PancrePal-xiaoyibao/xyb-pi-agent) |
| ChiCTR MCP server | [chictr-mcp-server](https://www.npmjs.com/package/chictr-mcp-server) (Apache-2.0) |
| China Drug Trials collector | [PancrePal-xiaoyibao/chinadrugtrials-collector](https://github.com/PancrePal-xiaoyibao/chinadrugtrials-collector) |
| Advanced trial matching | [opencare-skillhub/clinical-trial-matching](https://github.com/opencare-skillhub/clinical-trial-matching) |
| Record organiser | [opencare-skillhub/Medical-Record-Organizer](https://github.com/opencare-skillhub/Medical-Record-Organizer) |
| Distress screening | [opencare-skillhub/skill-HADS-accessment](https://github.com/opencare-skillhub/skill-HADS-accessment) |
| Tumour marker trends | [opencare-skillhub/graphify-xiaoyibao](https://github.com/opencare-skillhub/graphify-xiaoyibao) (**AGPL-3.0**) |
| Veeva CTV service | Not published to npm; bring your own local copy |

External skills are governed by their own repositories' licences. `graphify-xiaoyibao` is
AGPL-3.0 (strong copyleft); the skill here is an independent rewrite with no upstream code
inlined — if the project is ever publicly distributed, AGPL terms will apply.

---

## Why PI-Desktop?

Terminal agents are great at execution. IDE agents are great at living inside an editor.

PI-Desktop goes one step further:

> **Give AI agents a persistent, independent, and extensible desktop workspace of their own.**

<table>
<tr>

<td width="25%" valign="top">

### Independent Workspace

No dependency on a specific IDE or terminal.

Projects, sessions, reviews, previews, and agents all live in their own workspace.

</td>

<td width="25%" valign="top">

### Plugin-Powered

Plugins extend more than the agent.

Add panels, views, widgets, tools, MCP servers, themes, and background services.

</td>

<td width="25%" valign="top">

### Agent Orchestration

One agent is not always enough.

Delegate to Subagents or coordinate full Worker Sessions in parallel.

</td>

<td width="25%" valign="top">

### Model Freedom

Cloud models, local models, custom gateways, compatible APIs.

Switch models without rebuilding your workflow.

</td>

</tr>
</table>

<div align="center">

**It is not a wrapper around one model. It is not another IDE extension.**

### It is a desktop platform for agent workflows.

</div>

---

## Plugins are part of the workspace, not an afterthought

PI-Desktop keeps the Core focused.

**Your actual workflow is assembled through extensions.**

<table>
<tr>

<td width="33%" valign="top">

### Agent

Extend what the agent can do

**Agent Tools**
**Skills**
**Completion**
**pi Extensions**

</td>

<td width="33%" valign="top">

### Workspace

Extend the desktop itself

**Commands**
**Panels**
**Work Panel Views**
**Floating Widgets**
**Themes**

</td>

<td width="33%" valign="top">

### Platform

Extend the runtime

**MCP Servers**
**Resident Services**
**Plugin Message Bus**

</td>

</tr>
</table>

A plugin does not have to be “just another tool.”

It can be an entire product:

```text
Voice Agent
├── Floating Widget
├── Speech Service
├── Agent Tool
└── Commands

GitHub Workspace
├── Work Panel
├── MCP Server
├── Agent Tools
└── Background Service

Session Analytics
├── Dashboard
├── Commands
└── Workspace View
```

### What can a plugin add?

| Capability          | What it enables                                                |
| ------------------- | -------------------------------------------------------------- |
| **Command**         | Add actions to the global command system                       |
| **Panel**           | Open a standalone plugin interface                             |
| **Floating Widget** | Build voice orbs, status lights, timers, and other floating UI |
| **Work Panel View** | Add new views to the right-side workspace                      |
| **Agent Tool**      | Register tools callable by the agent                           |
| **Completion**      | Use the models already configured by the user                  |
| **Skill**           | Add reusable agent capabilities and workflows                  |
| **Theme**           | Customize workspace appearance                                 |
| **MCP Server**      | Connect local or remote MCP servers                            |
| **Service**         | Run persistent background work                                 |
| **Message Bus**     | Let plugins communicate with each other                        |

Plugins can be distributed as `.piplug` packages or installed through the marketplace.

<div align="center">

### [Build your first plugin →](docs/plugin-development.md)

</div>

---

## One foundation, many workflows

```text
                         PI-Desktop
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
        Agent            Workspace           Platform
          │                  │                  │
     Agent Tools           Panels              MCP
       Skills             Widgets            Services
     Subagents             Views            Message Bus
   pi Extensions          Themes
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                       Your Workflow
```

PI-Desktop can simply be your coding agent.

Or you can turn it into:

**AI Development Workspace · Voice Agent · DevOps Console · GitHub Workspace · Data Assistant · Multi-Agent Control Center · Automation Platform**

> **The Core provides the foundation. Plugins decide what your workspace becomes.**

---

## Three ways to work

<table>
<tr>

<td width="33%" valign="top">

### Agent

**Give it a task. Let it work.**

Read code, edit files, run commands, test, and iterate.

Best for day-to-day development.

</td>

<td width="33%" valign="top">

### Plan

**Review the approach before execution.**

The agent studies the project first and produces an implementation plan.

Best for refactors and high-risk changes.

</td>

<td width="33%" valign="top">

### Goal

**Define the outcome. Let the agent choose the path.**

Lock the objective and acceptance criteria, then let the agent drive execution.

Best for complex and long-running tasks.

</td>

</tr>
</table>

Privileged operations still pass through PI-Desktop's permission layer.

---

## When one agent is not enough

Complex work should not be forced into one context window.

PI-Desktop provides two levels of delegation.

### Subagents

Delegate independent work to background agents:

**Code exploration · Implementation · Test analysis · Research · Review**

Each Subagent gets its own context and reports the result back to the parent agent.

### Session Orchestrator

For longer-lived work, delegate to full Worker Sessions.

```text
Main Session
│
├── Worker A
│   └── Frontend
│
├── Worker B
│   └── Backend
│
├── Worker C
│   └── Tests
│
└── Worker D
    └── Review
```

Workers are full PI-Desktop sessions:

**Independent context · Independent execution · Directly inspectable · Reusable · Full transcript**

<table>
<tr>

<td width="50%">

<img src="docs/image/readme/session-orchestrator-overview.png" alt="Session Orchestrator" />

<p align="center"><sub>Coordinate multiple Worker Sessions from one parent Session</sub></p>

</td>

<td width="50%">

<img src="docs/image/readme/session-orchestrator-worker.png" alt="Worker Session" />

<p align="center"><sub>Each Worker remains a full, inspectable Session</sub></p>

</td>

</tr>
</table>

<div align="center">

**Move from “one agent helps me code” to “multiple agents divide and complete the work.”**

</div>

---

## Built for work that lasts

PI-Desktop is organized around:

<div align="center">

### Project → Session → Agent → Work

</div>

—not around disposable chat threads.

You can:

* Manage multiple projects and sessions
* Pin, archive, branch, and search sessions
* Queue prompts while an agent is already running
* Reference project files with `@`
* Use slash commands
* Review diffs
* Inspect command output
* Work with the right-side Work Panel
* Keep streaming checkpoints
* Recover interrupted work whenever possible

**A Session can continue across multiple app launches.**

---

## See what the agent is doing

<table>
<tr>

<td width="50%">

<img src="docs/image/readme/chat_en.png" alt="PI-Desktop Session" />

<p align="center"><sub>Persistent Sessions instead of disposable chats</sub></p>

</td>

<td width="50%">

<img src="docs/image/readme/model_en.png" alt="PI-Desktop Model" />

<p align="center"><sub>Switch models and reasoning levels inside the Session</sub></p>

</td>

</tr>

<tr>

<td width="50%">

<img src="docs/image/readme/plugins_en.png" alt="PI-Desktop Plugins" />

<p align="center"><sub>A plugin marketplace that extends both the agent and the desktop</sub></p>

</td>

<td width="50%">

<img src="docs/image/readme/addmodel_en.png" alt="PI-Desktop Providers" />

<p align="center"><sub>Connect your own provider, gateway, or local model</sub></p>

</td>

</tr>
</table>

<div align="center">

**[Explore more screenshots →](docs/guide/screenshots.md)**

</div>

---

## Swap the model, keep the workflow

PI-Desktop does not tie your workflow to a single model vendor.

Use:

**OpenAI · Anthropic · OpenAI-Compatible APIs · Custom Gateways · Ollama · LM Studio · Local Models**

Configure each model independently:

**Provider · Model ID · Context Window · Output Limit · Reasoning / Thinking · Temperature · OAuth · API Key · Endpoint**

Different Sessions can use different models.

The same Session can switch models at any time.

```text
Planning     → Model A
Coding       → Model B
Review       → Model C
Private Task → Local Model
```

> **The model is a replaceable component of the workflow — not the workflow itself.**

---

## Already using another coding agent?

Keep your existing work.

PI-Desktop can import local sessions from:

**Claude Code · Codex · OpenCode · Pi**

---

## Local-first

PI-Desktop does not require you to move your development environment into our cloud.

| Data                 | Default behavior                          |
| -------------------- | ----------------------------------------- |
| Projects             | Local                                     |
| Sessions             | Local                                     |
| Settings             | Local                                     |
| Logs                 | Local                                     |
| API credentials      | OS Keychain                               |
| PI-Desktop telemetry | None                                      |
| Model requests       | Sent directly to your configured provider |

**No mandatory PI-Desktop account.**

**No mandatory PI-Desktop relay.**

When using a remote model, the context required for the request is sent directly to that provider.

---

## You control the permissions

Agents can read files, edit code, run commands, call tools, use extensions, and delegate work.

Privileged operations still pass through the permission layer:

```text
Agent
  ↓
Tool Request
  ↓
Permission Layer
  ↓
Allow / Ask / Deny
  ↓
Execution
```

**You decide how much autonomy each Session gets.**

---

## Get started

<table>
<tr>

<td width="25%" valign="top">

### 01

**Download**

Install PI-Desktop

</td>

<td width="25%" valign="top">

### 02

**Connect a model**

Configure a Provider

</td>

<td width="25%" valign="top">

### 03

**Open a project**

Choose a local repository

</td>

<td width="25%" valign="top">

### 04

**Start working**

Agent / Plan / Goal

</td>

</tr>
</table>

<div align="center">

### [Download PI-Desktop →](https://github.com/vastsa/PI-Desktop/releases/latest)

**macOS · Windows · Linux**

</div>

### Packages

| Platform | Architecture  | Package                                 |
| -------- | ------------- | --------------------------------------- |
| macOS    | Apple Silicon | `.dmg` / `.zip`                         |
| macOS    | Intel         | `.dmg` / `.zip`                         |
| Windows  | x64           | Installer / `.zip`                      |
| Linux    | x64           | `.AppImage` / `.deb` / `.rpm` / `.asar` |

macOS releases are signed with a Developer ID certificate and notarized by Apple.

<details>
<summary><strong>Linux Compatibility</strong></summary>

<br />

Linux x64 packages require **glibc 2.35+**.

Common supported distributions include:

* Ubuntu 22.04+
* Debian 12+
* Fedora 36+

Check your current version with:

```bash
ldd --version
```

</details>

---

## Built on Pi

PI-Desktop is built on the [pi](https://github.com/badlogic/pi-mono) ecosystem.

The Agent Runtime uses:

* `pi-ai`
* `pi-agent-core`

> **Pi provides the Agent Engine. PI-Desktop builds the persistent desktop workspace, sessions, permissions, plugins, and agent orchestration around it.**

---

## For Developers

PI-Desktop can also serve as a host platform for building agent products.

You can build:

**Plugins · MCP Servers · Skills · Agent Tools · pi Extensions · Themes · Panels · Floating Widgets · Background Services**

### Plugin quick start

Built-in templates include:

* `panel-basic`
* `agent-tool-basic`
* `skill-pack`
* `full-demo`

Plugins can be created and loaded directly as Development Plugins.

**[Plugin Development Guide →](docs/plugin-development.md)**

### Run from source

<details>
<summary><strong>Development Setup</strong></summary>

<br />

#### Requirements

* Node.js `>=22.19`
* pnpm `>=10`
* Stable Rust Toolchain

#### Start

```bash
git clone https://github.com/vastsa/PI-Desktop.git
cd PI-Desktop

pnpm install

cargo build -p host-core
pnpm build:js

pnpm dev
```

#### Validate

```bash
pnpm typecheck
pnpm lint
pnpm test
```

</details>

### Documentation

[Documentation](https://pi-docs.aiuo.net/) ·
[Architecture](docs/spec/02-architecture/01-architecture.md) ·
[Specification](docs/spec/README.md) ·
[Plugin Development](docs/plugin-development.md) ·
[E2E Test Plan](docs/spec/06-delivery/04-e2e-test-plan.md) ·
[Release Runbook](docs/spec/06-delivery/06-release-runbook.md) ·
[AGENTS.md](AGENTS.md)

---

## Contributing

Contributions are welcome:

**Issues · Pull Requests · Plugins · Skills · MCP Integrations · Documentation · Translations**

For standalone capabilities, consider one question first:

> **Would this be better as a Plugin?**

Keep the Core focused. Let the ecosystem grow.

**[Report an Issue](https://github.com/vastsa/PI-Desktop/issues/new/choose)** ·
[Open Issues](https://github.com/vastsa/PI-Desktop/issues) ·
[Build a Plugin](docs/plugin-development.md)

---

## Project Trend

<div align="center">

<a href="https://trendshift.io/repositories/178787?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-178787">
<img src="https://trendshift.io/api/badge/repositories/178787" alt="PI-Desktop on Trendshift" width="230" height="51" />
</a>

</div>

---

## Friends

[Linux.Do](https://linux.do/) — A new ideal community

---

## Model Acknowledgements

> **Not by a lone genius, but by a token-powered construction crew.**

PI-Desktop has been built with the help of models from multiple providers.

More than **27 billion tokens** have been used across development, refactoring, review, design, and debugging.

Thanks to every human contributor — and every model that helped us build it.

---

## License

PI-Desktop is licensed under the **GNU Lesser General Public License v3.0**.

See [LICENSE](LICENSE) for details.

---

<div align="center">

<img src="docs/image/readme/logo.png" alt="小胰宝" width="72" />

## 小胰宝

### Build your own Agent workspace.

**Your models · Your agents · Your plugins · Your workspace**

<br />

**[Download](https://github.com/vastsa/PI-Desktop/releases/latest)** ·
[Documentation](https://pi-docs.aiuo.net/) ·
[Build a Plugin](docs/plugin-development.md)

<br /><br />

<sub>Local-first · Model-agnostic · Plugin-powered</sub>

</div>
