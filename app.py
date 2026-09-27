"""Interestellar: panel de diagnóstico para mecánicos.

Ejecutar en local:  python app.py   y abrir http://localhost:3000
"""
import hashlib
import hmac
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import RequestEntityTooLarge

load_dotenv()  # lee el archivo .env si existe

from interestellar.diagnose import DiagnosisError, ai_enabled, ai_provider, diagnose  # noqa: E402
from interestellar.extract import SUPPORTED_EXTENSIONS, is_supported  # noqa: E402
from interestellar.search import extract_codes  # noqa: E402
from interestellar.store import Library  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("interestellar")

HERE = Path(__file__).resolve().parent
PORT = int(os.getenv("PORT") or 3000)
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD") or ""
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB") or 50)


def _open_library():
    data_dir = os.getenv("DATA_DIR") or str(HERE / "data")
    library = Library(data_dir)
    try:
        library.init()
    except PermissionError:
        # DATA_DIR sin permisos (p. ej. /var/data sin disco en Render): usar ./data.
        if not os.getenv("DATA_DIR"):
            raise
        log.warning("No se puede escribir en %s. Usando ./data; los archivos se perderán al reiniciar.", data_dir)
        library = Library(HERE / "data")
        library.init()
    return library


library = _open_library()

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024 * 5  # hasta varios archivos por envío
app.json.ensure_ascii = False


# ---------- Páginas (panel del mecánico y del administrador) ----------
@app.get("/")
def index():
    return send_from_directory(HERE / "public", "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    return send_from_directory(HERE / "public", filename)


# ---------- Autenticación del administrador ----------
_sessions = {}  # token -> expira (epoch)
_sessions_lock = threading.Lock()
SESSION_SECONDS = 12 * 60 * 60


def _bearer():
    return re.sub(r"^Bearer\s+", "", request.headers.get("Authorization", ""), flags=re.I)


def _safe_equal(a, b):
    return hmac.compare_digest(hashlib.sha256(str(a).encode()).digest(), hashlib.sha256(str(b).encode()).digest())


def require_admin(fn):
    def wrapper(*args, **kwargs):
        token = _bearer()
        with _sessions_lock:
            exp = _sessions.get(token)
            if not exp or exp < time.time():
                _sessions.pop(token, None)
                return jsonify(error="Sesión de administrador no válida o expirada."), 401
        return fn(*args, **kwargs)

    wrapper.__name__ = fn.__name__
    return wrapper


@app.post("/api/admin/login")
def admin_login():
    if not ADMIN_PASSWORD:
        return jsonify(error="Configura ADMIN_PASSWORD en el archivo .env para usar el panel."), 503
    body = request.get_json(silent=True) or {}
    if not _safe_equal(body.get("password") or "", ADMIN_PASSWORD):
        return jsonify(error="Contraseña incorrecta."), 401
    token = secrets.token_hex(32)
    with _sessions_lock:
        _sessions[token] = time.time() + SESSION_SECONDS
    return jsonify(token=token)


@app.post("/api/admin/logout")
def admin_logout():
    with _sessions_lock:
        _sessions.pop(_bearer(), None)
    return jsonify(ok=True)


# ---------- Estado ----------
@app.get("/api/estado")
def estado():
    return jsonify(
        ia=ai_enabled(),
        proveedor=ai_provider(),
        documentos=len(library.list()),
        fragmentos=library.index.size,
        formatos=SUPPORTED_EXTENSIONS,
    )


# ---------- Diagnóstico (panel del mecánico) ----------
def _parse_consulta(body):
    def s(v, limit=2000):
        return str(v if v is not None else "").strip()[:limit]

    v = body.get("vehiculo") or {}
    raw_codes = s(body.get("codigos"), 500)
    codes = extract_codes(raw_codes)
    # También acepta códigos de fabricante no-OBD separados por coma/espacio.
    for c in re.split(r"[\s,;]+", raw_codes):
        if re.fullmatch(r"[A-Z0-9-]{3,12}", c, re.I) and re.search(r"\d", c) and c.upper() not in codes:
            codes.append(c.upper())
    return {
        "falla": s(body.get("falla"), 300),
        "parte": s(body.get("parte"), 300),
        "problema": s(body.get("problema")),
        "sintomas": s(body.get("sintomas")),
        "pruebas": s(body.get("pruebas")),
        "codigos": codes[:20],
        "vehiculo": {
            "marca": s(v.get("marca"), 60),
            "modelo": s(v.get("modelo"), 80),
            "anio": s(v.get("anio"), 4),
            "motor": s(v.get("motor"), 80),
            "transmision": s(v.get("transmision"), 60),
            "kilometraje": s(v.get("kilometraje"), 20),
            "vin": s(v.get("vin"), 17),
        },
    }


@app.post("/api/diagnostico")
def diagnostico():
    body = request.get_json(silent=True) or {}
    consulta = _parse_consulta(body)
    vehiculo = consulta["vehiculo"]
    if not (consulta["falla"] or consulta["problema"] or consulta["codigos"] or consulta["parte"]):
        return jsonify(error="Describe la falla, el problema o ingresa algún código de falla."), 400
    if not (vehiculo["marca"] and vehiculo["modelo"] and vehiculo["anio"]):
        return jsonify(error="Indica la marca, el modelo y el año del vehículo."), 400

    query_text = " ".join(
        x for x in (consulta["falla"], consulta["parte"], consulta["problema"], consulta["sintomas"], " ".join(consulta["codigos"])) if x
    )
    excerpts = library.search(query_text, consulta["codigos"], vehiculo, limit=8)
    web_search = body.get("buscarWeb") is not False
    inicio = time.time()

    fuentes_manual = [
        {"etiqueta": f"[M{i}]", "docId": e["docId"], "titulo": e["titulo"], "pagina": e["pagina"], "texto": e["texto"]}
        for i, e in enumerate(excerpts, 1)
    ]

    if not ai_enabled():
        return jsonify(
            modo="solo-biblioteca",
            aviso="La IA no está configurada (falta GEMINI_API_KEY). Se muestran solo los fragmentos encontrados en los manuales.",
            fuentesManual=fuentes_manual,
        )

    try:
        result = diagnose(consulta, excerpts, web_search)
    except DiagnosisError as err:
        return jsonify(error=str(err), fuentesManual=fuentes_manual), 502
    except Exception:
        log.exception("Error en diagnóstico")
        return jsonify(error="No se pudo completar el diagnóstico. Intenta de nuevo.", fuentesManual=fuentes_manual), 502

    d = result["diagnostico"]
    try:
        library.add_history(
            {
                "fecha": datetime.now(timezone.utc).isoformat(),
                "consulta": consulta,
                "resumen": d["resumen"],
                "causaPrincipal": d["causas_posibles"][0]["causa"] if d["causas_posibles"] else "",
                "manualesUsados": len(fuentes_manual),
                "busquedaWeb": web_search,
                "modelo": result.get("modelo"),
                "proveedor": result.get("proveedor"),
            }
        )
    except Exception:
        log.exception("No se pudo guardar el historial")

    return jsonify(
        modo="ia",
        diagnostico=d,
        fuentesManual=fuentes_manual,
        paginasWeb=result["webResults"],
        busquedaWeb=web_search,
        segundos=round(time.time() - inicio),
    )


SAFE_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


@app.get("/api/documentos/<doc_id>/archivo")
def documento_archivo(doc_id):
    """Descarga / visualización de un documento de la biblioteca (para las citas)."""
    doc = library.get(doc_id)
    if not doc:
        return jsonify(error="Documento no encontrado."), 404
    # El tipo se decide por la extensión; HTML y demás se muestran como texto
    # para no ejecutar scripts en este sitio.
    mimetype = SAFE_TYPES.get(Path(doc["storedName"]).suffix, "text/plain; charset=utf-8")
    resp = send_file(library.file_path(doc), mimetype=mimetype)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Content-Disposition"] = f"inline; filename*=UTF-8''{quote(doc['nombreArchivo'])}"
    return resp


# ---------- Panel de administrador ----------
@app.get("/api/admin/documentos")
@require_admin
def admin_documentos():
    return jsonify(library.list())


@app.post("/api/admin/documentos")
@require_admin
def admin_subir():
    files = request.files.getlist("archivos")
    if not files:
        return jsonify(error="No se recibió ningún archivo."), 400

    resultados = []
    for f in files:
        name = f.filename or "archivo"
        if not is_supported(name):
            resultados.append({"archivo": name, "error": f"Formato no soportado. Usa: {', '.join(SUPPORTED_EXTENSIONS)}"})
            continue
        data = f.read()
        if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
            resultados.append({"archivo": name, "error": f"El archivo supera el límite de {MAX_UPLOAD_MB} MB."})
            continue
        meta = dict(request.form)
        if len(files) > 1:
            meta["titulo"] = ""
        try:
            doc = library.add(data, name, f.mimetype, meta)
            resultados.append({"archivo": name, "documento": doc})
        except Exception as err:
            log.exception("Error procesando %s", name)
            resultados.append({"archivo": name, "error": f"No se pudo leer el archivo: {err}"})
    return jsonify(resultados=resultados)


@app.patch("/api/admin/documentos/<doc_id>")
@require_admin
def admin_editar(doc_id):
    doc = library.update(doc_id, request.get_json(silent=True) or {})
    if not doc:
        return jsonify(error="Documento no encontrado."), 404
    return jsonify(doc)


@app.delete("/api/admin/documentos/<doc_id>")
@require_admin
def admin_eliminar(doc_id):
    if not library.remove(doc_id):
        return jsonify(error="Documento no encontrado."), 404
    return jsonify(ok=True)


@app.get("/api/admin/buscar")
@require_admin
def admin_buscar():
    """Prueba de búsqueda en la biblioteca (sin IA) desde el panel de admin."""
    q = request.args.get("q", "")
    return jsonify(library.search(q, extract_codes(q), limit=10))


@app.get("/api/admin/consultas")
@require_admin
def admin_consultas():
    return jsonify(library.history(200))


@app.errorhandler(RequestEntityTooLarge)
def too_large(_err):
    return jsonify(error=f"Los archivos superan el límite de {MAX_UPLOAD_MB} MB."), 413


def _banner():
    print(f"Interestellar listo en http://localhost:{PORT}")
    print(f"  Panel del mecánico:      http://localhost:{PORT}/")
    print(f"  Panel de administrador:  http://localhost:{PORT}/admin.html")
    if ai_enabled():
        print(f"  IA: {ai_provider()}")
    else:
        print("  ⚠ Falta GEMINI_API_KEY en el archivo .env: solo se buscará en los manuales.")
    if not ADMIN_PASSWORD:
        print("  ⚠ Falta ADMIN_PASSWORD en el archivo .env: el panel de administrador está deshabilitado.")


if __name__ == "__main__":
    _banner()
    app.run(host="127.0.0.1", port=PORT, threaded=True)
