import JSZip from 'jszip';
import type { GeneratedOutputs, LoadedEpub, SpineEntry } from '../types';
import { parseXml, pruneNav, pruneNcx, qsa, serializeXml, joinPath } from './epubUtils';
import { extractTextExports } from './textExport';
import { safeFilename } from './download';

interface GenerateOptions {
  epub: LoadedEpub;
  kept: SpineEntry[];
  start: number;
  end: number;
  modeText: string;
  outputName: string;
  pruneToc: boolean;
  exportText: boolean;
  log: (message: string, level?: 'info' | 'ok' | 'warn' | 'err') => void;
  onProgress: (percent: number, label: string) => void;
}

export async function generateOutputs(options: GenerateOptions): Promise<GeneratedOutputs> {
  const {
    epub,
    kept,
    start,
    end,
    modeText,
    outputName,
    pruneToc,
    exportText,
    log,
    onProgress,
  } = options;

  const newZip = new JSZip();
  const allFiles = Object.keys(epub.zip.files);
  const mimetypeFile = epub.zip.file('mimetype');

  onProgress(5, 'Preparando ZIP nuevo');
  log('Creating new EPUB ZIP…');

  if (mimetypeFile) {
    const mimetypeText = await mimetypeFile.async('string');
    newZip.file('mimetype', mimetypeText, { compression: 'STORE' });
    log('mimetype copied as the first entry without compression, as required by EPUB.', 'ok');
  } else {
    log('Warning: no mimetype file was found at the EPUB root.', 'warn');
  }

  log(`Copying entries from original EPUB: ${allFiles.length}`);
  let copiedFiles = mimetypeFile ? 1 : 0;
  let copiedDirs = 0;

  for (const name of allFiles) {
    if (name === 'mimetype') continue;

    const file = epub.zip.files[name];
    if (file.dir) {
      newZip.folder(name);
      copiedDirs += 1;
      continue;
    }

    const data = await file.async('uint8array');
    newZip.file(name, data, { binary: true });
    copiedFiles += 1;

    if (copiedFiles % 8 === 0 || copiedFiles === allFiles.length) {
      onProgress(8 + Math.round((copiedFiles / allFiles.length) * 38), `Copying files (${copiedFiles}/${allFiles.length})`);
      log(`Copied ${copiedFiles}/${allFiles.length} files…`);
    }
  }

  log(`Copy completed. Files: ${copiedFiles}. Folders: ${copiedDirs}.`, 'ok');

  onProgress(50, 'Rewriting OPF/spine');
  log('Rewriting the OPF spine: itemrefs outside the selected range are removed.');

  const opfDoc = parseXml(epub.opfText);
  const spineElement = opfDoc.querySelector('spine');
  if (!spineElement) throw new Error('Could not find elemento <spine> dentro del OPF al generar.');

  const oldItemRefs = qsa(opfDoc, 'spine > itemref');
  log(`Original OPF itemrefs: ${oldItemRefs.length}`);
  oldItemRefs.forEach((node) => node.parentNode?.removeChild(node));

  kept.forEach((spineItem, localIndex) => {
    const old = epub.spineItems[spineItem.idx];
    if (!old) throw new Error(`Could not find itemref original para spine index ${spineItem.idx}.`);

    const item = opfDoc.createElementNS(old.namespaceURI || 'http://www.idpf.org/2007/opf', 'itemref');
    Array.from(old.attributes).forEach((attribute) => item.setAttribute(attribute.name, attribute.value));
    spineElement.appendChild(item);

    log(`Kept itemref ${localIndex + 1}/${kept.length}: idref="${spineItem.idref}" href="${spineItem.href}"`);
  });

  const metadata = opfDoc.querySelector('metadata');
  if (metadata) {
    const meta = opfDoc.createElementNS('http://www.idpf.org/2007/opf', 'meta');
    meta.setAttribute('name', 'generator');
    meta.setAttribute('content', 'EPUB Chapter Cutter React/Vite');
    metadata.appendChild(meta);
  }

  newZip.file(epub.opfPath, serializeXml(opfDoc));
  onProgress(64, 'OPF updated');
  log(`OPF updated y escrito en: ${epub.opfPath}`, 'ok');

  if (pruneToc) {
    onProgress(68, 'Pruning indexes');
    log('Option enabled: prune NAV/NCX so the table of contents does not point to discarded chapters.');

    const keptPaths = new Set(kept.map((spineItem) => spineItem.fullPath.split('#')[0]));
    log(`Kept reading paths: ${keptPaths.size}`);

    if (epub.ncxItem) {
      const ncxPath = joinPath(epub.opfBase, epub.ncxItem.getAttribute('href') || '');
      const file = epub.zip.file(ncxPath);
      if (file) {
        const text = await file.async('text');
        const beforeCount = (text.match(/<navPoint\b/g) || []).length;
        const pruned = pruneNcx(text, ncxPath, keptPaths);
        const afterCount = (pruned.match(/<navPoint\b/g) || []).length;
        newZip.file(ncxPath, pruned);
        log(`NCX pruned: ${ncxPath}. navPoint before=${beforeCount}, after=${afterCount}.`, 'ok');
      } else {
        log(`NCX declared but not found in ZIP: ${ncxPath}`, 'warn');
      }
    } else {
      log('No NCX declared in manifest.');
    }

    if (epub.navItem) {
      const navPath = joinPath(epub.opfBase, epub.navItem.getAttribute('href') || '');
      const file = epub.zip.file(navPath);
      if (file) {
        const text = await file.async('text');
        const beforeLinks = (text.match(/href=/g) || []).length;
        const pruned = pruneNav(text, navPath, keptPaths);
        const afterLinks = (pruned.match(/href=/g) || []).length;
        newZip.file(navPath, pruned);
        log(`NAV pruned: ${navPath}. links before=${beforeLinks}, after=${afterLinks}.`, 'ok');
      } else {
        log(`NAV declared but not found in ZIP: ${navPath}`, 'warn');
      }
    } else {
      log('No EPUB3 NAV declared in manifest.');
    }
  } else {
    log('Option disabled: NAV/NCX will not be pruned.');
  }

  let markdown: string | undefined;
  let txt: string | undefined;
  const rangeLabel = `${kept.length ? `${start + 1} → ${end}` : 'empty'} / modo: ${modeText}`;

  if (exportText) {
    onProgress(78, 'Extracting Markdown/TXT');
    const textExports = await extractTextExports(epub, kept, rangeLabel, log, onProgress);
    markdown = textExports.markdown;
    txt = textExports.txt;
  } else {
    log('Markdown/TXT export disabled by the user.');
  }

  onProgress(88, 'Compressing EPUB');
  log('Generating final EPUB Blob with JSZip…');

  const epubBlob = await newZip.generateAsync(
    {
      type: 'blob',
      mimeType: 'application/epub+zip',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      const percent = Math.round(metadata.percent || 0);
      onProgress(88 + Math.round(percent * 0.1), `Compressing EPUB (${percent}%)`);
      if (percent % 20 === 0) log(`Compression: ${percent}%`);
    },
  );

  const epubName = safeFilename(outputName || 'libro-cortado.epub');
  const stem = epubName.replace(/\.epub$/i, '') || 'libro-cortado';

  const outputs: GeneratedOutputs = {
    epubBlob,
    epubName,
  };

  if (markdown !== undefined) {
    outputs.markdownBlob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    outputs.markdownName = `${stem}.md`;
  }

  if (txt !== undefined) {
    outputs.txtBlob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    outputs.txtName = `${stem}.txt`;
  }

  log(`EPUB Blob generated successfully: ${(epubBlob.size / 1024 / 1024).toFixed(2)} MB`, 'ok');

  if (outputs.markdownBlob) {
    log(`Markdown prepared: ${outputs.markdownName} (${(outputs.markdownBlob.size / 1024).toFixed(1)} KB)`, 'ok');
  }

  if (outputs.txtBlob) {
    log(`TXT prepared: ${outputs.txtName} (${(outputs.txtBlob.size / 1024).toFixed(1)} KB)`, 'ok');
  }

  return outputs;
}
