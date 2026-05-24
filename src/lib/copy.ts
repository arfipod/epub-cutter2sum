export async function copyTextRobust(text: string): Promise<{ ok: boolean; reason?: string }> {
  const value = String(text || '');

  if (!value.trim()) {
    return { ok: false, reason: 'texto empty' };
  }

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return { ok: true };
    }
  } catch {
    // Fallback below.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);

    if (ok) return { ok: true };
    return { ok: false, reason: 'execCommand returned false' };
  } catch (error) {
    return { ok: false, reason: (error as Error).message || 'permission denied' };
  }
}
