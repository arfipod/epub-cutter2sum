import type { LoadedEpub, SpineEntry } from '../types';

export function normalizeTextForExport(text: string): string {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function markdownEscapeTitle(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '');
}

export function plainTextFromHtml(htmlText: string): string {
  const doc = new DOMParser().parseFromString(htmlText || '', 'text/html');
  doc.querySelectorAll('script,style,nav,header,footer,aside,svg').forEach((node) => node.remove());
  doc.querySelectorAll('br').forEach((br) => br.replaceWith(doc.createTextNode('\n')));
  doc.querySelectorAll('p,div,section,article,blockquote,li,h1,h2,h3,h4,h5,h6,tr').forEach((el) => {
    el.appendChild(doc.createTextNode('\n'));
  });
  return normalizeTextForExport(doc.body ? doc.body.innerText : doc.documentElement.textContent || '');
}

export function markdownFromHtml(htmlText: string): string {
  const doc = new DOMParser().parseFromString(htmlText || '', 'text/html');
  doc.querySelectorAll('script,style,nav,header,footer,aside,svg').forEach((node) => node.remove());

  const chunks: string[] = [];
  const emit = (line = '') => chunks.push(line);

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue?.replace(/\s+/g, ' ').trim();
      if (text) emit(text);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(6, Number(tag[1]) + 1);
      const text = normalizeTextForExport(element.textContent || '');
      if (text) emit(`${'#'.repeat(level)} ${markdownEscapeTitle(text)}`);
      emit('');
      return;
    }

    if (tag === 'p') {
      const text = normalizeTextForExport(element.textContent || '');
      if (text) {
        emit(text);
        emit('');
      }
      return;
    }

    if (tag === 'blockquote') {
      const text = normalizeTextForExport(element.textContent || '');
      if (text) {
        emit(text.split('\n').map((line) => `> ${line}`).join('\n'));
        emit('');
      }
      return;
    }

    if (tag === 'li') {
      const text = normalizeTextForExport(element.textContent || '');
      if (text) emit(`- ${text}`);
      return;
    }

    if (tag === 'br') {
      emit('');
      return;
    }

    Array.from(element.childNodes).forEach(walk);
    if (['div', 'section', 'article', 'body'].includes(tag)) emit('');
  }

  walk(doc.body || doc.documentElement);
  const markdown = normalizeTextForExport(chunks.join('\n'));
  return markdown || plainTextFromHtml(htmlText);
}

export async function extractTextExports(
  epub: LoadedEpub,
  kept: SpineEntry[],
  rangeLabel: string,
  log: (message: string, level?: 'info' | 'ok' | 'warn' | 'err') => void,
  onProgress: (percent: number, label: string) => void,
): Promise<{ markdown: string; txt: string }> {
  log('Starting clean text extraction for AI…');

  const baseTitle = epub.file.name.replace(/\.epub$/i, '') || 'Cut EPUB';
  const header = [
    `# ${baseTitle} — cut fragment`,
    '',
    `Range: ${rangeLabel}`,
    `Kept reading documents: ${kept.length}`,
    '',
    'Note: this Markdown was automatically extracted from the cut EPUB. It may contain minor formatting imperfections, but removes CSS, metadata, and navigation noise to make it more efficient for AI.',
    '',
  ].join('\n');

  const markdownParts = [header];
  const txtParts = [
    `${baseTitle} — cut fragment`,
    `Range: ${rangeLabel}`,
    `Kept reading documents: ${kept.length}`,
    '',
    '============================================================',
    '',
  ];

  let processed = 0;
  let totalChars = 0;

  for (const spineItem of kept) {
    processed += 1;
    onProgress(78 + Math.round((processed / kept.length) * 10), `Extracting text (${processed}/${kept.length})`);

    const title = markdownEscapeTitle(spineItem.title || spineItem.href || `Document ${processed}`);
    log(`Extracting text ${processed}/${kept.length}: ${title}`);

    let raw = '';
    try {
      raw = (await epub.zip.file(spineItem.fullPath)?.async('text')) || '';
    } catch (error) {
      log(`Could not read ${spineItem.fullPath}: ${(error as Error).message}`, 'warn');
    }

    let markdownBody = '';
    let txtBody = '';

    if (/x?html|xml/i.test(spineItem.media || spineItem.fullPath)) {
      markdownBody = markdownFromHtml(raw);
      txtBody = plainTextFromHtml(raw);
    } else {
      markdownBody = normalizeTextForExport(raw);
      txtBody = normalizeTextForExport(raw);
    }

    totalChars += txtBody.length;
    markdownParts.push(`\n\n## ${title}\n\n${markdownBody || '_Document sin texto extraíble._'}\n`);
    txtParts.push(`\n\n${title}\n${'='.repeat(Math.min(60, Math.max(8, title.length)))}\n\n${txtBody || '[Document sin texto extraíble]'}\n`);
  }

  const markdown = `${normalizeTextForExport(markdownParts.join('\n'))}\n`;
  const txt = `${normalizeTextForExport(txtParts.join('\n'))}\n`;

  log(`Extraction completed. Approximate TXT characters: ${totalChars.toLocaleString('es-ES')}`, 'ok');
  log(`Final Markdown: ${(new Blob([markdown]).size / 1024).toFixed(1)} KB. Final TXT: ${(new Blob([txt]).size / 1024).toFixed(1)} KB.`, 'ok');

  return { markdown, txt };
}
