import JSZip from 'jszip';
import type { CutMode, LoadedEpub, RangeInfo, SpineEntry } from '../types';

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i + 1) : '';
}

export function joinPath(base: string, href: string): string {
  const cleanHref = (href || '').split('#')[0];
  if (!cleanHref) return base.replace(/\/$/, '');
  if (/^[a-z]+:/i.test(cleanHref)) return cleanHref;

  const parts = `${base}${cleanHref}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function textOf(node: Element | null | undefined): string {
  return (node?.textContent || '').replace(/\s+/g, ' ').trim();
}

export function parseXml(text: string): XMLDocument {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error(`Invalid XML: ${parserError.textContent?.slice(0, 160) || 'parsererror'}`);
  }
  return doc;
}

export function serializeXml(doc: XMLDocument): string {
  return new XMLSerializer().serializeToString(doc);
}

export function qsa(root: ParentNode, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector));
}

export function selectedRange(mode: CutMode, startValue: number, endValue: number, total: number): RangeInfo {
  let start = 0;
  let end = total;
  let cutoffIndex: number | null = null;

  if (mode === 'before-exclusive') {
    cutoffIndex = endValue;
    start = 0;
    end = endValue;
  }
  if (mode === 'before-inclusive') {
    cutoffIndex = endValue;
    start = 0;
    end = endValue + 1;
  }
  if (mode === 'after-inclusive') {
    cutoffIndex = startValue;
    start = startValue;
    end = total;
  }
  if (mode === 'after-exclusive') {
    cutoffIndex = startValue;
    start = startValue + 1;
    end = total;
  }
  if (mode === 'range-exclusive-end') {
    start = startValue;
    end = endValue;
  }
  if (mode === 'range-inclusive-end') {
    start = startValue;
    end = endValue + 1;
  }

  start = Math.max(0, Math.min(total, start));
  end = Math.max(0, Math.min(total, end));
  if (end < start) [start, end] = [end, start];

  return { start, end, cutoffIndex, startIndex: startValue, endIndex: endValue };
}

export function pruneNcx(xmlText: string, ncxPath: string, keptPaths: Set<string>): string {
  const doc = parseXml(xmlText);
  const base = dirname(ncxPath);

  qsa(doc, 'navPoint').forEach((navPoint) => {
    const src = navPoint.querySelector('content')?.getAttribute('src');
    const full = joinPath(base, src || '');
    if (src && !keptPaths.has(full.split('#')[0])) {
      navPoint.parentNode?.removeChild(navPoint);
    }
  });

  qsa(doc, 'navPoint').forEach((navPoint, index) => {
    navPoint.setAttribute('playOrder', String(index + 1));
  });

  return serializeXml(doc);
}

export function pruneNav(htmlText: string, navPath: string, keptPaths: Set<string>): string {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const base = dirname(navPath);

  doc.querySelectorAll('a[href]').forEach((anchor) => {
    const full = joinPath(base, anchor.getAttribute('href') || '');
    if (!keptPaths.has(full.split('#')[0])) {
      const listItem = anchor.closest('li');
      (listItem || anchor).remove();
    }
  });

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

export async function loadEpubFile(
  file: File,
  onProgress: (percent: number, label: string) => void,
  log: (message: string, level?: 'info' | 'ok' | 'warn' | 'err') => void,
): Promise<LoadedEpub> {
  onProgress(2, 'Reading file');
  log(`Reading file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

  const arrayBuffer = await file.arrayBuffer();

  onProgress(10, 'Opening EPUB ZIP');
  const zip = await JSZip.loadAsync(arrayBuffer);
  const allNames = Object.keys(zip.files);
  log(`ZIP opened. Detected entries: ${allNames.length}`, 'ok');

  const containerText = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerText) throw new Error('Could not find META-INF/container.xml');

  const containerDoc = parseXml(containerText);
  const opfPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('Could not find rootfile/full-path en container.xml');

  const opfText = await zip.file(opfPath)?.async('text');
  if (!opfText) throw new Error(`Could not read OPF: ${opfPath}`);

  const opfDoc = parseXml(opfText);
  const opfBase = dirname(opfPath);
  log(`OPF found: ${opfPath}`, 'ok');

  const manifestItems = qsa(opfDoc, 'manifest > item');
  const manifest = new Map<string, Element>();
  manifestItems.forEach((item) => {
    const id = item.getAttribute('id');
    if (id) manifest.set(id, item);
  });

  const spineItems = qsa(opfDoc, 'spine > itemref');
  const spine: SpineEntry[] = spineItems.map((itemref, idx) => {
    const idref = itemref.getAttribute('idref') || '';
    const item = manifest.get(idref);
    const href = item?.getAttribute('href') || '';
    return {
      idx,
      idref,
      href,
      fullPath: joinPath(opfBase, href),
      media: item?.getAttribute('media-type') || '',
      title: '',
      tocTitle: null,
      linear: itemref.getAttribute('linear') || 'yes',
    };
  });

  if (!spine.length) throw new Error('The OPF does not contain a reading spine.');

  onProgress(35, 'Looking for table of contents');
  const titleByFullPath = new Map<string, string>();

  const navItem = manifestItems.find((item) =>
    (item.getAttribute('properties') || '').split(/\s+/).includes('nav'),
  ) || null;

  if (navItem) {
    const navPath = joinPath(opfBase, navItem.getAttribute('href') || '');
    const navText = await zip.file(navPath)?.async('text');
    if (navText) {
      log(`NAV index found: ${navPath}`);
      const navDoc = new DOMParser().parseFromString(navText, 'text/html');
      navDoc.querySelectorAll('nav a[href], nav [href]').forEach((anchor) => {
        const href = anchor.getAttribute('href');
        if (!href) return;
        const full = joinPath(dirname(navPath), href);
        if (!titleByFullPath.has(full)) titleByFullPath.set(full, textOf(anchor));
        if (!titleByFullPath.has(full.split('#')[0])) titleByFullPath.set(full.split('#')[0], textOf(anchor));
      });
    }
  }

  const ncxItem = manifestItems.find((item) => item.getAttribute('media-type') === 'application/x-dtbncx+xml') || null;
  if (ncxItem) {
    const ncxPath = joinPath(opfBase, ncxItem.getAttribute('href') || '');
    const ncxText = await zip.file(ncxPath)?.async('text');
    if (ncxText) {
      log(`NCX index found: ${ncxPath}`);
      const ncxDoc = parseXml(ncxText);
      qsa(ncxDoc, 'navPoint').forEach((navPoint) => {
        const src = navPoint.querySelector('content')?.getAttribute('src');
        const label = textOf(navPoint.querySelector('navLabel text'));
        if (!src || !label) return;
        const full = joinPath(dirname(ncxPath), src);
        if (!titleByFullPath.has(full)) titleByFullPath.set(full, label);
        if (!titleByFullPath.has(full.split('#')[0])) titleByFullPath.set(full.split('#')[0], label);
      });
    }
  }

  onProgress(45, 'Detecting titles');
  let titleDone = 0;
  for (const item of spine) {
    item.tocTitle = titleByFullPath.get(item.fullPath) || titleByFullPath.get(item.fullPath.split('#')[0]) || null;

    if (!item.tocTitle && /x?html/i.test(item.media)) {
      const text = await zip.file(item.fullPath)?.async('text');
      const doc = new DOMParser().parseFromString(text || '', 'text/html');
      const heading = doc.querySelector('h1,h2,h3,title');
      item.title = textOf(heading) || item.href.split('/').pop() || `Document ${item.idx + 1}`;
    } else {
      item.title = item.tocTitle || item.href.split('/').pop() || `Document ${item.idx + 1}`;
    }

    titleDone += 1;
    if (titleDone % 10 === 0 || titleDone === spine.length) {
      onProgress(45 + Math.round((titleDone / spine.length) * 40), `Detecting titles (${titleDone}/${spine.length})`);
    }
  }

  onProgress(100, 'EPUB loaded');
  log(`EPUB ready. Spine documents: ${spine.length}`, 'ok');

  return {
    file,
    zip,
    opfPath,
    opfText,
    opfDoc,
    opfBase,
    manifest,
    manifestItems,
    spine,
    spineItems,
    navItem,
    ncxItem,
  };
}
