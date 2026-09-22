// Extracción de texto de los archivos que sube el administrador.
// Devuelve una lista de páginas: [{ page, text }]. Para formatos sin páginas
// (DOCX, TXT) se devuelve una sola "página".
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.csv', '.json', '.html', '.htm'];

export function isSupported(filename) {
  return SUPPORTED_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

export async function extractPages(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.pages.map((p) => ({ page: p.num, text: clean(p.text) }));
    } finally {
      await parser.destroy();
    }
  }

  if (ext === '.docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    return [{ page: null, text: clean(value) }];
  }

  if (ext === '.html' || ext === '.htm') {
    const html = buffer.toString('utf8');
    const text = html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
    return [{ page: null, text: clean(text) }];
  }

  if (SUPPORTED_EXTENSIONS.includes(ext)) {
    return [{ page: null, text: clean(buffer.toString('utf8')) }];
  }

  throw new Error(`Formato no soportado: ${ext || 'sin extensión'}`);
}

function clean(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Divide cada página en fragmentos de ~CHUNK_SIZE caracteres con solapamiento,
// cortando preferentemente en saltos de párrafo o final de frase.
const CHUNK_SIZE = 1400;
const OVERLAP = 250;

export function chunkPages(pages) {
  const chunks = [];
  for (const { page, text } of pages) {
    if (!text) continue;
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + CHUNK_SIZE, text.length);
      if (end < text.length) {
        const window = text.slice(start, end);
        const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '));
        if (cut > CHUNK_SIZE * 0.5) end = start + cut + 1;
      }
      const piece = text.slice(start, end).trim();
      if (piece) chunks.push({ page, text: piece });
      if (end >= text.length) break;
      start = end - OVERLAP;
    }
  }
  return chunks;
}
