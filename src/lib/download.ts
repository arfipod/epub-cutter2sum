export interface DownloadItem {
  filename: string;
  blob: Blob;
  label: string;
}

export function createObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function safeFilename(name: string): string {
  return (name || 'libro-cortado.epub').replace(/[\\/:*?"<>|]+/g, '-');
}

export function triggerDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}
