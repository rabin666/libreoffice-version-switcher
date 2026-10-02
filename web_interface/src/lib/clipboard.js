// Clipboard helper with a fallback for browsers that refuse the async API.

/** Copies text to the clipboard and resolves to whether it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http://127.0.0.1 is a secure context, but some browsers still block the async API.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}
