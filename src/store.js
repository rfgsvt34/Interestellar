// Biblioteca de documentos: guarda los archivos originales, el texto extraído
// (en fragmentos) y mantiene el índice de búsqueda en memoria.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractPages, chunkPages } from './extract.js';
import { SearchIndex, normalize } from './search.js';

export class Library {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.filesDir = path.join(this.dataDir, 'archivos');
    this.chunksDir = path.join(this.dataDir, 'fragmentos');
    this.catalogPath = path.join(this.dataDir, 'catalogo.json');
    this.historyPath = path.join(this.dataDir, 'consultas.json');
    this.docs = new Map();
    this.chunks = new Map(); // docId -> [{page,text}]
    this.index = new SearchIndex();
  }

  async init() {
    await fs.mkdir(this.filesDir, { recursive: true });
    await fs.mkdir(this.chunksDir, { recursive: true });
    const catalog = await readJson(this.catalogPath, []);
    for (const doc of catalog) {
      const chunks = await readJson(path.join(this.chunksDir, `${doc.id}.json`), []);
      this.docs.set(doc.id, doc);
      this.chunks.set(doc.id, chunks);
      chunks.forEach((c, i) => this.index.add(doc.id, i, c.text));
    }
  }

  list() {
    return [...this.docs.values()].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  get(id) {
    return this.docs.get(id);
  }

  filePath(doc) {
    return path.join(this.filesDir, doc.storedName);
  }

  /**
   * Agrega un archivo a la biblioteca.
   * @param {{buffer:Buffer, originalName:string, mime:string}} file
   * @param {{titulo?:string, marca?:string, modelo?:string, anios?:string, categoria?:string, notas?:string}} meta
   */
  async add(file, meta = {}) {
    const pages = await extractPages(file.buffer, file.originalName);
    const chunks = chunkPages(pages);
    const charCount = chunks.reduce((n, c) => n + c.text.length, 0);

    const id = crypto.randomUUID();
    const ext = path.extname(file.originalName).toLowerCase();
    const doc = {
      id,
      titulo: (meta.titulo || '').trim() || path.basename(file.originalName, ext),
      nombreArchivo: file.originalName,
      storedName: `${id}${ext}`,
      mime: file.mime,
      tamano: file.buffer.length,
      paginas: pages.filter((p) => p.page != null).length || null,
      fragmentos: chunks.length,
      caracteres: charCount,
      marca: (meta.marca || '').trim(),
      modelo: (meta.modelo || '').trim(),
      anios: (meta.anios || '').trim(),
      categoria: (meta.categoria || '').trim(),
      notas: (meta.notas || '').trim(),
      uploadedAt: new Date().toISOString(),
      aviso: charCount < 50 ? 'No se pudo extraer texto (¿PDF escaneado sin OCR?).' : '',
    };

    await fs.writeFile(this.filePath(doc), file.buffer);
    await fs.writeFile(path.join(this.chunksDir, `${id}.json`), JSON.stringify(chunks));
    this.docs.set(id, doc);
    this.chunks.set(id, chunks);
    chunks.forEach((c, i) => this.index.add(id, i, c.text));
    await this.saveCatalog();
    return doc;
  }

  async update(id, meta) {
    const doc = this.docs.get(id);
    if (!doc) return null;
    for (const key of ['titulo', 'marca', 'modelo', 'anios', 'categoria', 'notas']) {
      if (typeof meta[key] === 'string') doc[key] = meta[key].trim();
    }
    await this.saveCatalog();
    return doc;
  }

  async remove(id) {
    const doc = this.docs.get(id);
    if (!doc) return false;
    this.index.removeDoc(id);
    this.docs.delete(id);
    this.chunks.delete(id);
    await fs.rm(this.filePath(doc), { force: true });
    await fs.rm(path.join(this.chunksDir, `${id}.json`), { force: true });
    await this.saveCatalog();
    return true;
  }

  /**
   * Busca los fragmentos más relevantes para una consulta de diagnóstico.
   * Los documentos etiquetados con la misma marca/modelo/año reciben prioridad;
   * los etiquetados con otra marca se penalizan.
   */
  search({ text, codes, vehiculo = {} }, limit = 8) {
    const marca = normalize(vehiculo.marca);
    const modelo = normalize(vehiculo.modelo);
    const anio = Number(vehiculo.anio) || null;

    const docBoost = (docId) => {
      const d = this.docs.get(docId);
      if (!d) return 1;
      let boost = 1;
      if (d.marca && marca) boost *= normalize(d.marca).includes(marca) || marca.includes(normalize(d.marca)) ? 1.6 : 0.5;
      if (d.modelo && modelo) boost *= normalize(d.modelo).includes(modelo) || modelo.includes(normalize(d.modelo)) ? 1.5 : 0.8;
      if (d.anios && anio) boost *= yearInRange(anio, d.anios) ? 1.3 : 0.85;
      return boost;
    };

    const vehicleTerms = [vehiculo.marca, vehiculo.modelo, vehiculo.motor].filter(Boolean);
    return this.index.search({ text, codes, vehicleTerms, docBoost }, limit).map((r) => {
      const doc = this.docs.get(r.docId);
      const chunk = this.chunks.get(r.docId)[r.chunkIndex];
      return {
        docId: r.docId,
        titulo: doc.titulo,
        nombreArchivo: doc.nombreArchivo,
        pagina: chunk.page,
        texto: chunk.text,
        score: Number(r.score.toFixed(3)),
      };
    });
  }

  async saveCatalog() {
    await writeJsonAtomic(this.catalogPath, this.list());
  }

  // ---- Historial de consultas ----
  async addHistory(entry) {
    const history = await readJson(this.historyPath, []);
    history.unshift(entry);
    await writeJsonAtomic(this.historyPath, history.slice(0, 500));
  }

  async history(limit = 100) {
    return (await readJson(this.historyPath, [])).slice(0, limit);
  }
}

export function yearInRange(year, spec) {
  // Acepta "2015", "2012-2016", "2010, 2012, 2014-2016"
  return String(spec)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .some((part) => {
      const m = part.match(/^(\d{4})\s*(?:-|a|al|to)\s*(\d{4})$/i);
      if (m) return year >= Number(m[1]) && year <= Number(m[2]);
      return Number(part) === year;
    });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}
