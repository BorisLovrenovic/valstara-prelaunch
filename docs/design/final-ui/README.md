# Final UI design — local snapshot

This folder is a snapshot of the canvas "Valstara website: final UI design", **version `1793367843-fe69`**, saved 2026-10-30. The live canvas is at <https://claude.ai/artifact/VsdApoe6yfcRRQCpCRmQcD#page-dcb81aee8d83>.

Tickets E11.5-11i to E11.5-11t build from this snapshot. `docs/plan/development-plan.md` ("The final-design tickets") holds the binding rules. **The design sets the direction. It is not the finished design.** Each ticket's Build says what to add on top of it, and what to leave out. If the live canvas has moved past the pinned version, this snapshot still governs until the founder re-pins the plan.

## What is here

| Path | What it is |
|---|---|
| `project/canvas.json` | The board index: titles, positions and sizes, plus the canvas notes (`readme`, `decisions`) |
| `project/*.dc.html` | The 48 boards and the building blocks they import (`Header`, `Hero`, `Rewards`, `Footer`, `Verify`, `Me`, `Leaderboard`, `Doc`, `Task`) |
| `project/valstara.css` | The one shared stylesheet, with every token under its name |
| `project/icons.svg` | The icon sprite the boards reference |
| `project/logos/` | The 34 provider logos. They are byte-identical to `public/images/providers/` |
| `renders/*.png` | A 1× render of each board in its default state (light theme, annotations off), named after the board file. Boards 3, 10 and 11 are the dark frames. A board whose frames run past its canvas box renders larger than the box |
| `SHA256SUMS` | The hash of every file above, as saved |

Board numbers follow the brief's §11.1. `ChangeLog.dc.html` (board 27) holds the change log against the wireframes, the token delta and the copy proposals. `Manifest.dc.html` (board 26) is the image manifest. `Proposals.dc.html` (board 28) holds proposals that need a founder decision first.

## How to read it

- **Read the boards as source, and look at `renders/`.** Each board is HTML with `{{…}}` template values, `<sc-if>` conditions and `<dc-import>` building blocks. Take values from the HTML and CSS, and composition from the renders. The canvas runtime (`support.js`) is not part of this snapshot, so the boards do not render from this folder. For the dark theme or the annotation layer of any other board, open the canvas link above and switch its tweaks.
- Boards load Google Fonts only to render the canvas. The site self-hosts its fonts (ADR-016).
- Blue `#1F5EDB` is the annotation layer. It is never built.
- These files are reference material. Nothing under `src/` imports them, and none of them ships.

To check the snapshot is unchanged, run this from this folder:

```bash
sha256sum -c SHA256SUMS
```
