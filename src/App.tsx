import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { CutMode, GeneratedOutputs, LoadedEpub, LogLevel, LogLine } from './types';
import { copyTextRobust } from './lib/copy';
import { createObjectUrl, triggerDownload } from './lib/download';
import { generateOutputs } from './lib/generator';
import { loadEpubFile, selectedRange } from './lib/epubUtils';

const cutModes: { value: CutMode; label: string }[] = [
  { value: 'before-exclusive', label: 'Up to selected chapter, not inclusive' },
  { value: 'before-inclusive', label: 'Up to selected chapter, inclusive' },
  { value: 'after-inclusive', label: 'From selected chapter, inclusive' },
  { value: 'after-exclusive', label: 'From after selected chapter' },
  { value: 'range-exclusive-end', label: 'From start chapter inclusive to end chapter not inclusive' },
  { value: 'range-inclusive-end', label: 'From start chapter inclusive to end chapter inclusive' },
];

const summaryPrompt = `Act as an expert reader and produce a deep summary of the attached file, which contains a novel cut up to a certain chapter.

Goal: I need to remember everything important before continuing to read.

Instructions:
1. Summarize chronologically everything that has happened up to the point included in the file.
2. Split the summary by arcs, characters, and main conflicts.
3. Include motivations, relationships, revealed secrets, major twists, and each character's state changes.
4. Highlight loose ends, unresolved mysteries, and open questions at the end of the fragment.
5. Do not invent anything that is not present in the attached file.
6. Do not reveal anything after the attached content, even if you know the work.
7. Clearly state where the fragment ends if you can infer it from the last included chapter.
8. Write the answer in clear Spanish, with enough detail for me to resume reading without getting lost.

Desired format:
- Executive summary of 10-15 lines.
- Timeline of events.
- Characters and evolution.
- Open conflicts.
- Details worth remembering.
- Last known situation at the end of the fragment.`;

function nowTime(): string {
  return new Date().toLocaleTimeString('es-ES', { hour12: false });
}

function App() {
  const [epub, setEpub] = useState<LoadedEpub | null>(null);
  const [mode, setMode] = useState<CutMode>('before-exclusive');
  const [startIndex, setStartIndex] = useState(0);
  const [endIndex, setEndIndex] = useState(0);
  const [outputName, setOutputName] = useState('book-cut.epub');
  const [pruneToc, setPruneToc] = useState(true);
  const [exportText, setExportText] = useState(true);
  const [progress, setProgressValue] = useState(0);
  const [progressText, setProgressText] = useState('Esperando EPUB');
  const [status, setStatus] = useState('Load an EPUB to begin.');
  const [statusKind, setStatusKind] = useState<'info' | 'ok' | 'err'>('info');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [outputs, setOutputs] = useState<GeneratedOutputs | null>(null);
  const [downloadUrls, setDownloadUrls] = useState<{ epub?: string; markdown?: string; txt?: string }>({});
  const [copyFallback, setCopyFallback] = useState<{ visible: boolean; label: string; text: string; reason?: string }>({
    visible: false,
    label: '',
    text: '',
  });

  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);

  const log = (message: string, level: LogLevel = 'info') => {
    setLogs((prev) => [...prev, { time: nowTime(), message, level }]);
  };

  const setProgress = (percent: number, label: string) => {
    setProgressValue(Math.max(0, Math.min(100, percent)));
    setProgressText(label);
  };

  const currentRange = useMemo(() => {
    if (!epub) return null;
    return selectedRange(mode, startIndex, endIndex, epub.spine.length);
  }, [epub, mode, startIndex, endIndex]);

  const kept = useMemo(() => {
    if (!epub || !currentRange) return [];
    return epub.spine.slice(currentRange.start, currentRange.end);
  }, [epub, currentRange]);

  const clearObjectUrls = () => {
    Object.values(downloadUrls).forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
    setDownloadUrls({});
  };

  const loadFile = async (file: File) => {
    clearObjectUrls();
    setOutputs(null);
    setLogs([]);
    setStatusKind('info');
    setStatus('Loading EPUB…');
    setProgress(0, 'Starting load');

    try {
      const loaded = await loadEpubFile(file, setProgress, log);
      setEpub(loaded);

      const cap30 = Math.min(29, loaded.spine.length - 1);
      const firstChapter30 = loaded.spine.findIndex((entry) => /(cap[ií]tulo|chapter)\s+30/i.test(entry.title));
      const inferredEnd = firstChapter30 >= 0 ? firstChapter30 : Math.min(cap30 + 1, loaded.spine.length - 1);

      setStartIndex(0);
      setEndIndex(inferredEnd);

      const safe = file.name
        .replace(/\.epub$/i, '')
        .replace(/[^\w\-.áéíóúüñÁÉÍÓÚÜÑ ]+/g, '')
        .trim() || 'libro';

      setOutputName(`${safe} - cut.epub`);
      setStatusKind('ok');
      setStatus(`EPUB loaded successfully. Spine documents: ${loaded.spine.length}.`);
    } catch (error) {
      setStatusKind('err');
      setStatus(`Error: ${(error as Error).message}`);
      setProgress(100, 'Error');
      log(`Error loading EPUB: ${(error as Error).message}`, 'err');
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void loadFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  };

  const handleGenerate = async () => {
    if (!epub || !currentRange) {
      setStatusKind('err');
      setStatus('Load an EPUB first.');
      return;
    }

    clearObjectUrls();
    setOutputs(null);
    setLogs([]);
    setStatusKind('info');
    setStatus('Validating cut selection…');
    setProgress(1, 'Validating cut');

    const modeText = cutModes.find((candidate) => candidate.value === mode)?.label || mode;
    const selectedKept = epub.spine.slice(currentRange.start, currentRange.end);

    log('===== EPUB CUT START =====');
    log(`Original file: ${epub.file.name}`);
    log(`OPF: ${epub.opfPath}`);
    log(`Base OPF: ${epub.opfBase || '(raíz)'}`);
    log(`Total spine documents: ${epub.spine.length}`);
    log(`Mode elegido: ${modeText}`);
    log(`Start/main selector: ${startIndex + 1}. ${epub.spine[startIndex]?.title || epub.spine[startIndex]?.href || '(no disponible)'}`);
    log(`Boundary/end selector: ${endIndex + 1}. ${epub.spine[endIndex]?.title || epub.spine[endIndex]?.href || '(no disponible)'}`);

    if (mode.startsWith('before-')) {
      log('Applied rule: "Up to..." mode ⇒ the boundary/end selector is used as the cut chapter.');
      log(`Boundary chapter used: ${(currentRange.cutoffIndex ?? 0) + 1}. ${epub.spine[currentRange.cutoffIndex ?? 0]?.title || '(no disponible)'}`);
    }

    if (mode.startsWith('after-')) {
      log('Applied rule: "From..." mode ⇒ the start/main selector is used as the cut chapter.');
      log(`Start chapter used: ${(currentRange.cutoffIndex ?? 0) + 1}. ${epub.spine[currentRange.cutoffIndex ?? 0]?.title || '(no disponible)'}`);
    }

    log(`Computed JS index range: [${currentRange.start}, ${currentRange.end})`);
    log(`Human-readable kept range: ${selectedKept.length ? `${currentRange.start + 1} → ${currentRange.end}` : 'empty'}`);
    log(`Documents removed before range: ${currentRange.start}`);
    log(`Documents removed after range: ${epub.spine.length - currentRange.end}`);

    if (!selectedKept.length) {
      setStatusKind('err');
      setStatus('The cut is empty. Choose another chapter or mode.');
      setProgress(100, 'Corte empty');
      log('RESULT: empty cut. No file is generated.', 'err');
      return;
    }

    log(`First kept document: ${currentRange.start + 1}. ${selectedKept[0]?.title || selectedKept[0]?.href}`);
    log(`Last kept document: ${currentRange.end}. ${selectedKept[selectedKept.length - 1]?.title || selectedKept[selectedKept.length - 1]?.href}`);

    try {
      const generated = await generateOutputs({
        epub,
        kept: selectedKept,
        start: currentRange.start,
        end: currentRange.end,
        modeText,
        outputName,
        pruneToc,
        exportText,
        log,
        onProgress: setProgress,
      });

      const urls = {
        epub: createObjectUrl(generated.epubBlob),
        markdown: generated.markdownBlob ? createObjectUrl(generated.markdownBlob) : undefined,
        txt: generated.txtBlob ? createObjectUrl(generated.txtBlob) : undefined,
      };

      setOutputs(generated);
      setDownloadUrls(urls);
      setStatusKind('ok');
      setStatus(`Generation completed. Kept ${selectedKept.length} spine documents.`);
      setProgress(100, 'EPUB + text files generated');

      log(`EPUB link prepared: ${generated.epubName}`, 'ok');
      if (generated.markdownName) log(`Markdown link prepared: ${generated.markdownName}`, 'ok');
      if (generated.txtName) log(`TXT link prepared: ${generated.txtName}`, 'ok');
      log('Trying to automatically start the EPUB download…');

      if (urls.epub) {
        try {
          triggerDownload(urls.epub);
          log('Automatic EPUB download requested.', 'ok');
        } catch (error) {
          log(`Could not start automatic download: ${(error as Error).message}`, 'warn');
        }
      }

      log('If the browser blocks automatic download, click the download buttons manually.', 'warn');
      log('===== EPUB CUT END =====', 'ok');
    } catch (error) {
      setStatusKind('err');
      setStatus(`Generation error: ${(error as Error).message}`);
      setProgress(100, 'Error');
      log(`ERROR during cut: ${(error as Error).message}`, 'err');
      log('===== EPUB CUT ABORTED =====', 'err');
    }
  };

  const handleCopy = async (text: string, label: string) => {
    const result = await copyTextRobust(text);
    if (result.ok) {
      setCopyFallback({ visible: false, label: '', text: '' });
      return;
    }

    setCopyFallback({ visible: true, label, text, reason: result.reason });
    setTimeout(() => {
      fallbackRef.current?.focus();
      fallbackRef.current?.select();
      try {
        fallbackRef.current?.setSelectionRange(0, text.length);
      } catch {
        // Ignore mobile selection limitations.
      }
    }, 0);
  };

  const selectorHint = useMemo(() => {
    if (!epub || !currentRange) return 'No EPUB loaded yet.';

    if (mode.startsWith('before-')) {
      return `En este modo se usa como límite “End chapter”: ${endIndex + 1}. ${epub.spine[endIndex]?.title || epub.spine[endIndex]?.href || '—'}.`;
    }

    if (mode.startsWith('after-')) {
      return `En este modo se usa como inicio “Reference / start chapter”: ${startIndex + 1}. ${epub.spine[startIndex]?.title || epub.spine[startIndex]?.href || '—'}.`;
    }

    return `In this mode, the range is from ${startIndex + 1} to ${endIndex + 1}.`;
  }, [epub, currentRange, mode, startIndex, endIndex]);

  const logText = logs.map((line) => `[${line.time}] ${line.message}`).join('\n');

  return (
    <div className="wrap">
      <header className="hero">
        <section className="card heroText">
          <p className="eyebrow">EPUB → EPUB / Markdown / TXT</p>
          <h1>epub-cutter2sum <span>React + Vite</span></h1>
          <p>
            Cut an EPUB by chapter, generate a readable EPUB copy, and extract clean Markdown/TXT for AI summarization.
            Everything is processed locally in your browser.
          </p>
        </section>

        <section className="card">
          <label
            className="drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <input type="file" accept=".epub,application/epub+zip" onChange={handleFileChange} />
            <strong>Drop an EPUB here</strong>
            <span>or click to select it</span>
          </label>
          <div className={`status ${statusKind}`}>{status}</div>
          <div className="progress">
            <div className="progressTop">
              <span>{progressText}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="bar">
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
        </section>
      </header>

      <main className="grid">
        <section className="panel card">
          <h2>Cut settings</h2>

          <label htmlFor="mode">Mode</label>
          <select id="mode" value={mode} disabled={!epub} onChange={(event) => setMode(event.target.value as CutMode)}>
            {cutModes.map((candidate) => (
              <option key={candidate.value} value={candidate.value}>{candidate.label}</option>
            ))}
          </select>

          <div className="two">
            <div>
              <label htmlFor="startChapter">Reference / start chapter</label>
              <select id="startChapter" value={startIndex} disabled={!epub} onChange={(event) => setStartIndex(Number(event.target.value))}>
                {epub?.spine.map((entry, index) => (
                  <option key={entry.fullPath + index} value={index}>{index + 1}. {entry.title || entry.href}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="endChapter">End chapter</label>
              <select id="endChapter" value={endIndex} disabled={!epub} onChange={(event) => setEndIndex(Number(event.target.value))}>
                {epub?.spine.map((entry, index) => (
                  <option key={entry.fullPath + index} value={index}>{index + 1}. {entry.title || entry.href}</option>
                ))}
              </select>
            </div>
          </div>

          <label htmlFor="outName">Output filename</label>
          <input id="outName" type="text" value={outputName} disabled={!epub} onChange={(event) => setOutputName(event.target.value)} />

          <label className="check">
            <input type="checkbox" checked={pruneToc} disabled={!epub} onChange={(event) => setPruneToc(event.target.checked)} />
            <span>Try to prune NCX/NAV indexes so they only point to kept chapters.</span>
          </label>

          <label className="check">
            <input type="checkbox" checked={exportText} disabled={!epub} onChange={(event) => setExportText(event.target.checked)} />
            <span>Also generate clean Markdown and TXT files for AI summarization.</span>
          </label>

          <div className="btns">
            <button className="btn primary" disabled={!epub} onClick={handleGenerate}>Generate EPUB + Markdown + TXT</button>
            <button className="btn secondary" onClick={() => void handleCopy(summaryPrompt, 'Summary prompt')}>Copy summary prompt</button>
          </div>

          {outputs && (
            <div className="exportGrid">
              {downloadUrls.epub && <a className="download" href={downloadUrls.epub} download={outputs.epubName}>📖 EPUB: {outputs.epubName}</a>}
              {downloadUrls.markdown && outputs.markdownName && <a className="download" href={downloadUrls.markdown} download={outputs.markdownName}>🤖 Markdown IA: {outputs.markdownName}</a>}
              {downloadUrls.txt && outputs.txtName && <a className="download" href={downloadUrls.txt} download={outputs.txtName}>📝 TXT: {outputs.txtName}</a>}
              <p className="exportMeta">For ChatGPT summarization, preferably use the Markdown file. The EPUB is useful to verify the cut in an EPUB reader.</p>
            </div>
          )}

          <p className="footer warn">Note: some readers cache the table of contents. If you see stale entries, remove the old book from the reader and import it again.</p>
        </section>

        <section className="panel card">
          <h2>Preview</h2>
          <div className="preview">
            <p>{selectorHint}</p>
            {epub && currentRange ? (
              <>
                <p><strong>{kept.length}</strong> reading documents kept, out of <strong>{epub.spine.length}</strong> total.</p>
                <p><strong>First:</strong> {kept[0]?.title || '—'}</p>
                <p><strong>Last:</strong> {kept[kept.length - 1]?.title || '—'}</p>
                {kept.length === 0 && <p className="danger">The cut is empty. Change the selected chapter.</p>}
              </>
            ) : (
              <p>Load an EPUB to see the preview.</p>
            )}
          </div>

          <h2>Detected chapters</h2>
          <div className="chapterList">
            {epub?.spine.map((entry, index) => (
              <div className="chapterRow" key={entry.fullPath + index}>
                <span className="idx">{index + 1}</span>
                <span className="name" title={entry.fullPath}>{entry.title || entry.href}</span>
                <span className="tag">{entry.linear}</span>
              </div>
            )) || <p className="muted">No chapters loaded yet.</p>}
          </div>
        </section>
      </main>

      <section className="card promptCard">
        <div className="sectionHeader">
          <h2>Prompt for ChatGPT</h2>
          <button className="btn secondary" onClick={() => void handleCopy(summaryPrompt, 'Summary prompt')}>Copy prompt</button>
        </div>
        <textarea value={summaryPrompt} readOnly />
      </section>

      <section className="card logCard">
        <div className="sectionHeader">
          <h2>Log</h2>
          <div className="btns compact">
            <button className="btn secondary" onClick={() => void handleCopy(logText, 'Generation log')}>Copy log</button>
            <button className="btn secondary" onClick={() => setLogs([])}>Clear log</button>
          </div>
        </div>
        <div className="log">
          {logs.length ? logs.map((line, index) => (
            <div key={`${line.time}-${index}`} className={`logLine ${line.level}`}>
              <span>[{line.time}]</span> {line.message}
            </div>
          )) : <p className="muted">No events yet.</p>}
        </div>
      </section>

      {copyFallback.visible && (
        <section className="card copyFallback">
          <h2>Manual copy</h2>
          <p>
            {copyFallback.label}: the browser did not allow automatic copy
            {copyFallback.reason ? ` (${copyFallback.reason})` : ''}. Long-press the text, select all, and copy.
          </p>
          <textarea ref={fallbackRef} value={copyFallback.text} readOnly />
          <p className="copyNote">On Android/Chrome this may happen when the app is opened from an insecure origin. Locally with Vite, clipboard copy should usually work.</p>
        </section>
      )}
    </div>
  );
}

export default App;
