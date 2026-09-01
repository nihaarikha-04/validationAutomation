/**
 * Hands a generated file to the browser's downloader.
 *
 * The only place a report reaches the DOM. Kept out of the components so everything that decides
 * *what* a report says stays pure and testable, and so no `downloads` permission is needed —
 * an object URL clicked from the panel's own page is an ordinary download.
 */
export function downloadText(contents: string, fileName: string): void {
  // `text/plain` deliberately, not `text/csv`: some browsers offer to open a CSV in an external
  // application, and a report the user asked to save should be saved.
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();

  // Revoked on the next turn: revoking immediately races the download in Chromium.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
