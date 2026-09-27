"""Buscador local sobre los fragmentos de los documentos (BM25), con prioridad
para códigos de falla (OBD-II) y coincidencias de vehículo."""
from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter

STOPWORDS = set(
    (
        "a al algo ante antes como con contra cual cuando de del desde donde durante e el ella ellos en entre era es "
        "esa ese eso esta este esto estos fue ha hace hay la las le les lo los mas me mi muy no nos o otra otro para "
        "pero poco por porque que se sea segun ser si sin sobre su sus tambien tiene todo tras tu un una uno unos y ya "
        "the and or of to in on for with is are was be by at an as it this that from not no when if then than"
    ).split()
)

# Códigos OBD-II (P0301, U0100, B1234, C0035)
DTC_RE = re.compile(r"\b[PBCU][0-3][0-9A-F]{3}\b", re.I)


def normalize(text) -> str:
    text = unicodedata.normalize("NFD", str(text or "").lower())
    return "".join(c for c in text if unicodedata.category(c) != "Mn")


def _stem(t: str) -> str:
    # Stemming muy ligero para español/inglés: plurales y terminaciones comunes.
    if t[:1].isdigit() or len(t) <= 4:
        return t
    t = re.sub(r"(es|s)$", "", t)
    return re.sub(r"(ando|iendo|ado|ido|cion|ing|ed)$", "", t)


def tokenize(text) -> list[str]:
    return [_stem(t) for t in re.split(r"[^a-z0-9]+", normalize(text)) if len(t) > 1 and t not in STOPWORDS]


def extract_codes(text) -> list[str]:
    seen = []
    for c in DTC_RE.findall(str(text or "")):
        c = c.upper()
        if c not in seen:
            seen.append(c)
    return seen


class SearchIndex:
    def __init__(self):
        self.docs = {}  # (doc_id, chunk_index) -> {"tf": Counter, "len": int, "codes": set}
        self.df = Counter()
        self.total_len = 0

    def add(self, doc_id: str, chunk_index: int, text: str):
        tokens = tokenize(text)
        tf = Counter(tokens)
        self.df.update(tf.keys())
        self.docs[(doc_id, chunk_index)] = {"tf": tf, "len": len(tokens), "codes": set(extract_codes(text))}
        self.total_len += len(tokens)

    def remove_doc(self, doc_id: str):
        for key in [k for k in self.docs if k[0] == doc_id]:
            entry = self.docs.pop(key)
            for t in entry["tf"]:
                self.df[t] -= 1
                if self.df[t] <= 0:
                    del self.df[t]
            self.total_len -= entry["len"]

    @property
    def size(self) -> int:
        return len(self.docs)

    def search(self, text="", codes=(), vehicle_terms=(), doc_boost=lambda _id: 1.0, limit=8) -> list[dict]:
        n = len(self.docs)
        if not n:
            return []
        avg_len = self.total_len / n or 1
        k1, b = 1.4, 0.75

        q_tokens = set(tokenize(text))
        v_tokens = {t for v in vehicle_terms for t in tokenize(v)}
        q_codes = [c.upper() for c in codes]

        results = []
        for (doc_id, chunk_index), entry in self.docs.items():
            score = 0.0
            for t in q_tokens:
                f = entry["tf"].get(t)
                if not f:
                    continue
                df = self.df[t]
                idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
                score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * entry["len"] / avg_len))
            code_hits = sum(1 for c in q_codes if c in entry["codes"])
            score += code_hits * 12
            if score <= 0:
                continue
            vehicle_hits = sum(1 for t in v_tokens if t in entry["tf"])
            score *= 1 + 0.25 * vehicle_hits
            score *= doc_boost(doc_id)
            results.append({"doc_id": doc_id, "chunk_index": chunk_index, "score": score})

        results.sort(key=lambda r: r["score"], reverse=True)

        # Evita que un solo documento acapare todos los resultados.
        per_doc = Counter()
        out = []
        for r in results:
            if per_doc[r["doc_id"]] >= 4:
                continue
            per_doc[r["doc_id"]] += 1
            out.append(r)
            if len(out) >= limit:
                break
        return out
