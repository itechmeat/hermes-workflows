// Client-side file plumbing (download a text file, read a picked one).
// Isolated from the page so the DOM wiring stays in one testable place and the
// page handlers read cleanly.

/** Read a picked file as text. FileReader, not `File.text()`: the test DOM
 *  (jsdom) does not implement the latter, and both run everywhere we ship. */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`failed to read ${file.name}`));
    reader.readAsText(file);
  });
}

export function downloadTextFile(filename: string, content: string, type = "text/yaml"): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
