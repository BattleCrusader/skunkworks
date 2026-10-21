# Admin UI — three directions

Three self-contained mockups for the Skunkworks admin, each a different posture rather than a
different palette. They are static HTML: no build step, no external requests, system fonts only,
one small inline script that switches screens (and reads `#pages`, `#media`, `#editor`,
`#plugins`, `#signin` so a screen can be linked directly).

| File | Direction | Posture |
|---|---|---|
| `01-ops-console.html` | **Ops Console** | Dense, information-first, keyboard-led |
| `02-quiet-editorial.html` | **Quiet Editorial** | Calm, typography-led, the site's aesthetic in the admin |
| `03-guided-cards.html` | **Guided Cards** | Task-led cards and wizards, one job per screen |

Open any file directly in a browser at 1280 px wide. Each shows the same five screens:
Pages (default), Media, Editor, Plugins, Sign in. Pages and Media are stacked in one scroll —
the page list first, then a band that names the media screen, then the library — so a reader can
see the same posture hold across two screens; the tabs jump to either one.

## The three directions

**01 · Ops Console.** A trading-terminal posture for someone who lives in the tool: a 46 px
command bar, a 184 px text rail, a 30 px-row table, a persistent inspector and a status bar of
keyboard hints. Data is monospaced, labels are 9–10 px uppercase, colour is reserved for state
(green published, amber draft, red notice, cyan selection). The page list carries an audit strip
underneath it; the media screen is one dense asset table — thumbnail, dimensions, bytes, pages that
use the key, access — with a facts panel, a focus ring and a key legend; the editor is full-bleed,
with the dark palette and settings panels framing GrapesJS's own light canvas. Nothing
is decorative; every pixel is either a value or an affordance.

**02 · Quiet Editorial.** The admin as a well-set publication: a serif masthead, a 62 px headline,
hairline rules, 56 px gutters and a 64 px margin column. There are almost no boxes — the page index
is a list of titles with paths in mono and states in italic; the media library is a plate section
with the gated PDF given a wide feature row; notices are written as dispatches ("It could not prove
that it had been tested") with the machine code kept as a footnote. It assumes the site itself has a
typographic point of view, and lets that point of view carry into the back office.

**03 · Guided Cards.** Built for the person who did not buy a CMS: a white app bar, soft cards,
one primary action per screen, and copy that explains consequences. Pages opens with a "Pricing is
almost ready" next-step card and rows that say Edit or Finish; Media opens with a drop zone and
plain-language privacy notes; Plugins leads with "SEO isn't running", says what that means for the
site, then offers "Try starting it again" and "Remove plugin". The editor is framed as three steps
(Edit → Check → Publish), with a friendly block palette and a sticky publish bar. Technical detail
is present but demoted to a quotable error code.

## Which one for whom

| Situation | Use | Why |
|---|---|---|
| Agency or in-house operator, daily use, many pages, keyboard | **01 Ops Console** | Highest information density; command bar and j/k flow reward repetition; audit and plugin state are first-class. |
| Design-led studio or brand where the admin is part of the product | **02 Quiet Editorial** | Makes the back office feel like the front of house; typography does the hierarchy work, so the chrome can disappear. |
| Non-technical site owner given the keys | **03 Guided Cards** *(recommended for a non-technical client)* | One job per screen, plain language, visible next step, consequences spelled out before publishing. |
| Mixed team (clients plus an agency operator) | 03 for client accounts, 01 for the operator | The same routes and content support both; only the chrome and copy change. |

For a non-technical client, **03-guided-cards.html** is the recommendation. This is not a pick of an
overall winner: 01 and 02 are stronger for their own users, and the choice between postures is the
product decision this document leaves open.

## Design tokens

### 01 · Ops Console

**Type** — UI sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
sans-serif`. Data, labels and codes: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas`.
Base 12 px / 1.45. Scale: 9 micro-label · 9.5 column head · 10 meta · 10.5 mono value · 11 table
cell · 11.5 control · 12 body · 12.5 toolbar title · 15 inspector title · 16 page title · 18 sign-in
title · 26 sign-in statement. Uppercase labels are 9–10 px at `0.12em`; headings use `1.2`
line-height.

**Colour roles** — canvas `#0B0E13` · panel `#10151C` · raised `#182130` · hairline `#232C38` ·
soft hairline `#1A212B` · text `#CED7E3` · secondary `#9AA7B7` · muted `#6B7787` · selection/primary
`#5CC8FF` (+ soft `#16394B`) · success `#46D19A` · warning `#F2B544` · danger `#FF7070` (+ soft
`#2A1517`). State is always text plus colour, never colour alone.

**Spacing & geometry** — 4 px base: 4 / 6 / 8 / 12 / 14 / 16 / 18 / 22 / 24. Table row 30 px,
top bar 46, status bar 26, rail 184, inspector 300. Radii 2–3 px; 1 px borders throughout.

### 02 · Quiet Editorial

**Type** — display serif: `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua",
Georgia, serif`. Meta: system sans. Keys and code: system mono. Base 15 px / 1.6. Scale: 9.5 small
caps · 10 label · 10.5 meta · 11 path · 12 UI · 13.5 body · 15 base · 18 lede · 24 editor title ·
27 page-row title · 30 dispatch headline · 34 dialog title · 38 canvas h1 · 62 screen headline ·
68 sign-in headline. Display tracking `-0.035em`; small caps tracking `0.18em`.

**Colour roles** — paper `#FAF7F0` · paper-2 `#F4EFE4` · paper-3 `#EFE8DA` · ink `#1C1A16` ·
secondary `#4B463C` · muted `#7D7466` · faint `#A49A89` · rule `#DED6C6` · accent/oxblood
`#7C3529` · green `#33523F` · gold `#A67C3D`. The only saturated colour is the oxblood accent and
the two plugin states.

**Spacing & geometry** — 8 px base: 8 / 10 / 12 / 14 / 16 / 20 / 24 / 26 / 34 / 40 / 44 / 52 / 56 /
64 / 90. Sheet gutters 56 px, column gap 64, section foot 90. Radii 0–5 px; hairline rules do the
separating; the only shadow is under the canvas page.

### 03 · Guided Cards

**Type** — system sans only: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
Arial, sans-serif`. Mono only for error codes. Base 15 px / 1.55. Scale: 9 micro · 9.5/10.5 label ·
11.5 meta · 12.5 small UI · 13.5 body · 14 app · 15 base · 16 row title · 18 alert title · 24 stat
or editor page title · 25 dialog title · 30 page title. Weights 400 / 600 / 650; no letterspacing
except uppercase micro-labels.

**Colour roles** — canvas `#EEF2F8` · card `#FFFFFF` · card-2 `#F7F9FD` · ink `#182130` · secondary
`#3F4B5E` · muted `#66748A` · faint `#93A0B3` · line `#E2E8F1` / `#D3DCE9` · primary `#2563EB`
(hover `#1D4ED8`, soft `#E8F0FF`) · success `#0F9D6E` (+ soft `#E7F7F1`) · warning `#B45309`
(+ soft `#FFF5E6`, line `#F3D7AC`) · danger `#D33A3A` (+ soft `#FDEEEE`, line `#F3CCCC`).

**Spacing & geometry** — 4 px base: 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 22 / 26 / 34 / 40 /
80. Card padding 22, row padding 15/18, page gutter 28. Radii 8 (controls) / 10 (inputs) / 14
(cards) / 20 (dialog) / 999 (pills). Two shadow tokens: `--shadow-sm` for controls, `--shadow` for
hover and the sign-in card.

## What is real, what is illustrative

- Tenant `abc123`, operator `owner@abc123.com`, and the page titles (`ABC123 — hello from
  abc123.com`, `About & Co <ltd>`, `Pricing`) are from the seeded site database.
- Media keys are `banner/home.jpg`, `gallery/one.jpg`, `hero/clinic.jpg`, `team/portrait.jpg`,
  `uploads/scan-2019.png` and `vault/paid.pdf`; the first two and `vault/paid.pdf` are required keys
  in the seed, and `vault/paid.pdf` is shown gated and code-required, which is a real access class in
  `cms_asset`. Sizes and dimensions are the fixture's, not the seed's: `banner/home.jpg` is 1,226 B at
  1600 × 900 and is used on three pages, `gallery/one.jpg` 940 B at 800 × 600 on one, and
  `uploads/scan-2019.png` is deliberately unused so the "can I delete this?" answer is visible.
- Plugin ids, versions, states, activation sequence numbers and notices use the real shapes and
  error codes from `app/plugins` (`SKW_E_PL_TESTS_STALE`, `SKW_E_PL_SIGNATURE`) and the three-column
  notices/loaded/installed model in `app/admin/routes.ts`.
- `/pricing` is shown as a **draft** so the draft state, preview affordance and publish flow are
  visible; in the current seed all three pages are published. The plugin rows are illustrative.
- The editor chrome is designed around GrapesJS, not over it: the canvas stays light, and the blue
  outline and toolbar inside it are the editor's own selection UI. No direction restyles or replaces
  GrapesJS's canvas tools.
- Status is never communicated by colour alone: every state has a word (`Published`, `Draft`,
  `enabled, NOT loaded`, `Private`).

No application code was changed. These are design directions under `docs/design/admin/`.
