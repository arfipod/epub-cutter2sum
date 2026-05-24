# epub-cutter2sum

React + Vite + TypeScript web application to cut an EPUB before/after/between chapters and generate three outputs:

- A cut EPUB, useful for human reading.
- A clean Markdown file, recommended for AI summarization.
- A clean TXT file, useful as a plain-text fallback.

Everything runs locally in the browser. No book content is uploaded to any server.

## Run locally

```bash
npm install
npm run dev
```

Then open the URL printed by Vite, usually:

```bash
http://localhost:5173
```

## Build

```bash
npm run build
npm run preview
```

## Usage

1. Drag and drop or select an `.epub` file.
2. Choose the cut mode.
3. For `Up to selected chapter, not inclusive`, select the boundary chapter in **End chapter**.
4. Click **Generate EPUB + Markdown + TXT**.
5. For ChatGPT or another AI assistant, preferably upload the generated `.md` file.

## Technical notes

The EPUB cut is performed by rewriting the OPF `spine` and optionally pruning `NAV`/`NCX` navigation files.

The app intentionally keeps the original ZIP resources to maximize EPUB-reader compatibility. The important reading flow is controlled by the OPF `spine`.

For AI summarization, the Markdown export is extracted from the kept spine documents and removes styles, navigation, scripts, metadata noise, and other EPUB-specific boilerplate.


## Repository name

```text
epub-cutter2sum
```

The name reflects the main workflow:

```text
EPUB → cut fragment → clean Markdown/TXT → AI summary
```
