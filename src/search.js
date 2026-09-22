// Buscador local sobre los fragmentos de los documentos (BM25),
// con prioridad para códigos de falla (OBD-II) y coincidencias de vehículo.

const STOPWORDS = new Set(
  (
    'a al algo ante antes como con contra cual cuando de del desde donde durante e el ella ellos en entre era es esa ese eso esta este esto estos fue ha hace hay la las le les lo los mas me mi muy no nos o otra otro para pero poco por porque que se sea segun ser si sin sobre su sus tambien tiene todo tras tu un una uno unos y ya ' +
    'the and or of to in on for with is are was be by at an as it this that from not no when if then than'
  ).split(/\s+/)
);

// Códigos OBD-II (P0301, U0100, B1234, C0035) y variantes con sufijo (P0171-00)
const DTC_RE = /\b[PBCU][0-3][0-9A-F]{3}\b/gi;

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

// Stemming muy ligero para español/inglés: plurales y terminaciones comunes.
function stem(t) {
  if (/^\d/.test(t) || t.length <= 4) return t;
  return t.replace(/(es|s)$/, '').replace(/(ando|iendo|ado|ido|cion|ing|ed)$/, '');
}

export function extractCodes(text) {
  return [...new Set((String(text || '').match(DTC_RE) || []).map((c) => c.toUpperCase()))];
}

export class SearchIndex {
  constructor() {
    this.docs = new Map(); // key -> { docId, chunkIndex, tf: Map, len, codes:Set, textNorm }
    this.df = new Map();
    this.totalLen = 0;
  }

  add(docId, chunkIndex, text) {
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.docs.set(`${docId}:${chunkIndex}`, {
      docId,
      chunkIndex,
      tf,
      len: tokens.length,
      codes: new Set(extractCodes(text)),
      textNorm: normalize(text),
    });
    this.totalLen += tokens.length;
  }

  removeDoc(docId) {
    for (const [key, entry] of this.docs) {
      if (entry.docId !== docId) continue;
      for (const t of entry.tf.keys()) {
        const n = this.df.get(t) - 1;
        if (n > 0) this.df.set(t, n);
        else this.df.delete(t);
      }
      this.totalLen -= entry.len;
      this.docs.delete(key);
    }
  }

  get size() {
    return this.docs.size;
  }

  /**
   * @param {object} q
   * @param {string} q.text       texto libre (falla, parte, problema…)
   * @param {string[]} q.codes    códigos de falla
   * @param {string[]} q.vehicleTerms  marca / modelo / año
   * @param {(docId:string)=>number} [q.docBoost] multiplicador por documento
   */
  search({ text = '', codes = [], vehicleTerms = [], docBoost = () => 1 }, limit = 8) {
    const N = this.docs.size;
    if (!N) return [];
    const avgLen = this.totalLen / N || 1;
    const k1 = 1.4;
    const b = 0.75;

    const qTokens = [...new Set(tokenize(text))];
    const vTokens = [...new Set(vehicleTerms.flatMap((v) => tokenize(v)))];
    const qCodes = codes.map((c) => c.toUpperCase());

    const results = [];
    for (const entry of this.docs.values()) {
      let score = 0;
      for (const t of qTokens) {
        const f = entry.tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * entry.len) / avgLen)));
      }
      let codeHits = 0;
      for (const c of qCodes) if (entry.codes.has(c)) codeHits++;
      score += codeHits * 12;

      if (score <= 0) continue;

      let vehicleHits = 0;
      for (const t of vTokens) if (entry.tf.has(t)) vehicleHits++;
      score *= 1 + 0.25 * vehicleHits;
      score *= docBoost(entry.docId);

      results.push({ docId: entry.docId, chunkIndex: entry.chunkIndex, score, codeHits });
    }

    results.sort((a, b2) => b2.score - a.score);

    // Evita que un solo documento acapare todos los resultados.
    const perDoc = new Map();
    const out = [];
    for (const r of results) {
      const n = perDoc.get(r.docId) || 0;
      if (n >= 4) continue;
      perDoc.set(r.docId, n + 1);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }
}
