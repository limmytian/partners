# Partners Brand Guidelines & Visual Identity Specification

**Version:** 1.0.0 (Release v0.1.3)  
**Status:** Approved & Official  
**Core Design Direction:** Concept 7 — The Interlocking Link Crest (紧凑互扣双环勋章)

---

## 1. Brand Concept & Strategic Positioning

**Partners** is a high-performance execution gateway and multi-runtime agent sandbox control plane engineered for autonomous AI software engineers (SWE agents), code interpreters, and LLM orchestration systems.

### Core Value Pillars
- **Provider-Agnostic Architecture:** Connect seamlessly to local micro-VMs, CubeSandbox clusters, unprivileged Kubernetes Pods, gVisor, or Kata Containers without vendor lock-in.
- **MicroVM Isolation & Security:** High-density, memory-safe ephemeral isolation designed to run untrusted agent-generated code safely at enterprise scale.
- **The Partnership Metaphor:** The brand represents the mission-critical link connecting autonomous cognitive agents (the intelligence layer) to safe, durable execution infrastructure (the computing plane).

---

## 2. The Brandmark: The Interlocking Link Crest

The Partners symbol is composed of two precision rounded rhombuses woven into a continuous topological interlock:

```
      Cyan Loop (Agent Plane)        Indigo Loop (Security Plane)
          [ #00f0ff ]                     [ #7982ff ]
                 \                           /
                  \                         /
                   [ Top Crossing: Indigo Over Cyan ]
                  /                         \
                 /                           \
          [ Bottom Crossing: Cyan Over Indigo ]
                 \                           /
          [ #007ae8 ]                     [ #4338ca ]
```

### Visual Semantics
1. **Cyan Loop (`#00f0ff` -> `#007ae8`):** Represents the dynamic, agile, forward-looking AI Agent execution space.
2. **Indigo Loop (`#7982ff` -> `#4338ca`):** Represents the hardened, reliable, enterprise security control plane.
3. **Dual 3D Interlock:** Two physical crossings with directional micro drop shadows signify deep mutual trust, stability, and zero-compromise boundary enforcement.
4. **Three Resonant Apertures:** The negative space reveals three distinct chambers (Left Agent Chamber, Central Gateway Junction, Right Control Chamber), embodying the tri-part architecture of Agent, Gateway, and Sandbox Runtime.

---

## 3. Official Color Palette

| Token | Name | HEX Code | RGB | Usage |
|---|---|---|---|---|
| `brand-cyan-light` | Cyber Cyan Flare | `#00f0ff` | `rgb(0, 240, 255)` | Agent loop highlight & primary glow |
| `brand-cyan-mid` | Electric Aqua | `#00c4ff` | `rgb(0, 196, 255)` | Agent loop body & UI accents |
| `brand-cyan-deep` | Deep Ocean Blue | `#007ae8` | `rgb(0, 122, 232)` | Agent loop base shadow |
| `brand-indigo-light` | Digital Violet | `#7982ff` | `rgb(121, 130, 255)` | Security loop highlight |
| `brand-indigo-mid` | Royal Indigo | `#6366f1` | `rgb(99, 102, 241)` | Security loop body & badge secondary |
| `brand-indigo-deep` | Dark Nebula | `#4338ca` | `rgb(67, 56, 202)` | Security loop base shadow |
| `surface-dark-bg` | Obsidian Dark | `#090d16` | `rgb(9, 13, 22)` | Dark mode background & banners |
| `surface-card-bg` | Slate Midnight | `#0f172a` | `rgb(15, 23, 42)` | Console background & card surfaces |
| `text-primary-dark`| Pure Frost | `#f8fafc` | `rgb(248, 250, 252)`| Dark mode logotype & primary headings |

---

## 4. Typography System

### Logotype
- **Primary Wordmark Font:** Geometric Bold / Modern Neo-Grotesque (`SF Pro Display`, `Inter`, `system-ui`)
- **Wordmark Weight:** `800 (ExtraBold)`
- **Wordmark Tracking:** `-1.5px`
- **Subtitle Tracking:** `+5px` (All-caps: `AI AGENT EXECUTION GATEWAY`)

### Console & Code UI
- **Body & Headings:** Inter / SF Pro / system-ui
- **Monospace Elements (Tokens, IDs, Logs):** SFMono-Regular, Menlo, Monaco, Consolas, monospace

---

## 5. Asset Library Inventory

All official assets are committed directly in `assets/brand/` and mirrored in `console/public/brand/`:

| File Path | Description | Recommended Usage |
|---|---|---|
| `assets/brand/partners-mark.svg` | Master Vector Mark (512x512) | App icon, avatar, header mark |
| `assets/brand/partners-mark.png` | Master Retina Raster Mark (1024x1024) | High-DPI displays & app stores |
| `assets/brand/partners-mark-mono-dark.svg` | Monochrome Slate/White Mark | Dark backgrounds, monochrome printing |
| `assets/brand/partners-mark-mono-light.svg`| Monochrome Charcoal Mark | White documents, mono printing |
| `assets/brand/partners-logo-horizontal-dark.svg` | Horizontal Dark Logotype (1200x360) | Dark README headers, portals |
| `assets/brand/partners-logo-horizontal-dark.png` | Horizontal Dark Retina PNG (1200x360)| GitHub Camo Proxy compatible README |
| `assets/brand/partners-logo-horizontal-light.svg`| Horizontal Light Logotype (1200x360) | White docs & slide presentations |
| `assets/brand/partners-logo-horizontal-light.png`| Horizontal Light Retina PNG (1200x360)| Light theme README rendering |
| `assets/brand/partners-logo-vertical-dark.svg` | Stacked Square Logotype (800x800) | Social media profiles, posters |
| `assets/brand/partners-social-card.png` | OpenGraph / Twitter Card (1200x630) | Link previews on Slack, X, Discord |
| `assets/brand/favicon.ico` | Multi-resolution Favicon (16x16, 32x32) | Browser tabs & bookmarks |
| `assets/brand/favicon.svg` | Scalable Vector Favicon | Modern browser tabs |
| `assets/brand/apple-touch-icon.png` | Apple Touch Icon (180x180) | iOS Home Screen bookmarks |
| `assets/brand/badge-agnostic.svg` | Shields-style Badge: `provider: agnostic` | Markdown repo headers |
| `assets/brand/badge-microvm.svg` | Shields-style Badge: `sandbox: MicroVM` | Markdown repo headers |
| `assets/brand/terminal-banner.txt` | ASCII Art Terminal Banner | CLI boot greetings & daemon startup |

---

## 6. Clear Space & Usage Rules

1. **Do not alter the interlocking topology:** The cyan loop must weave under the indigo loop at the top and over the indigo loop at the bottom.
2. **Preserve aspect ratio:** The symbol must scale with uniform 1:1 aspect ratio.
3. **High contrast requirement:** On backgrounds darker than `#334155`, use the standard or dark monochrome mark. On light backgrounds, use the light horizontal logo or light monochrome mark.
4. **GitHub Markdown compatibility:** When embedding in READMEs, always specify high-res PNG fallback images alongside `<picture>` tags to prevent GitHub Camo Proxy SVG rendering degradation.
