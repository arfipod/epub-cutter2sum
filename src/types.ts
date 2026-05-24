import type JSZip from 'jszip';

export type CutMode =
  | 'before-exclusive'
  | 'before-inclusive'
  | 'after-inclusive'
  | 'after-exclusive'
  | 'range-exclusive-end'
  | 'range-inclusive-end';

export type LogLevel = 'info' | 'ok' | 'warn' | 'err';

export interface LogLine {
  time: string;
  message: string;
  level: LogLevel;
}

export interface SpineEntry {
  idx: number;
  idref: string;
  href: string;
  fullPath: string;
  media: string;
  title: string;
  tocTitle: string | null;
  linear: string;
}

export interface LoadedEpub {
  file: File;
  zip: JSZip;
  opfPath: string;
  opfText: string;
  opfDoc: XMLDocument;
  opfBase: string;
  manifest: Map<string, Element>;
  manifestItems: Element[];
  spine: SpineEntry[];
  spineItems: Element[];
  navItem: Element | null;
  ncxItem: Element | null;
}

export interface RangeInfo {
  start: number;
  end: number;
  cutoffIndex: number | null;
  startIndex: number;
  endIndex: number;
}

export interface GeneratedOutputs {
  epubBlob: Blob;
  markdownBlob?: Blob;
  txtBlob?: Blob;
  epubName: string;
  markdownName?: string;
  txtName?: string;
}
