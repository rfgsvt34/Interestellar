"""Proveedor Gemini (Google): usa la búsqueda de Google integrada ("grounding")
y pide el diagnóstico en JSON."""
import json
import logging
import os
import time

from google import genai
from google.genai import errors, types

from ..prompt import DIAGNOSIS_SCHEMA, SYSTEM_PROMPT, build_user_message
from . import ProviderError

log = logging.getLogger(__name__)

MODEL = os.getenv("GEMINI_MODEL") or "gemini-flash-latest"
# Si el modelo principal está saturado, se prueba con este (más ligero).
FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-flash-lite-latest")
RETRY_DELAYS = [2, 5]

# Sin herramientas propias: se desactiva la llamada automática de funciones del SDK.
_NO_AFC = types.AutomaticFunctionCallingConfig(disable=True)

JSON_INSTRUCTIONS = (
    "\n\nFormato de salida: responde ÚNICAMENTE con un objeto JSON válido (sin texto antes ni después y sin "
    "bloques de código) que cumpla este esquema JSON:\n" + json.dumps(DIAGNOSIS_SCHEMA, ensure_ascii=False)
)

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    return _client


def diagnose_gemini(consulta, excerpts, web_search):
    user_message = build_user_message(consulta, excerpts, web_search)

    # La búsqueda de Google no se combina con la salida JSON forzada, así que con
    # búsqueda se pide el JSON por instrucciones y, si no llega bien, se hace una
    # segunda llamada (sin búsqueda) que solo convierte la respuesta a JSON.
    if web_search:
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT + JSON_INSTRUCTIONS,
            tools=[types.Tool(google_search=types.GoogleSearch())],
            automatic_function_calling=_NO_AFC,
        )
    else:
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT + JSON_INSTRUCTIONS,
            response_mime_type="application/json",
            response_json_schema=DIAGNOSIS_SCHEMA,
            automatic_function_calling=_NO_AFC,
        )

    response, model = _generate_with_retry(user_message, config)
    _check_blocked(response)

    web_results = {}
    candidate = (response.candidates or [None])[0]
    metadata = getattr(candidate, "grounding_metadata", None)
    for chunk in (getattr(metadata, "grounding_chunks", None) or []):
        web = getattr(chunk, "web", None)
        if web and web.uri:
            web_results[web.uri] = web.title or web.uri

    diagnostico = _parse_json(response.text)
    if diagnostico is None:
        fix, _ = _generate_with_retry(
            f"Convierte este diagnóstico al formato JSON indicado, sin perder información:\n\n{response.text or ''}",
            types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=DIAGNOSIS_SCHEMA,
                automatic_function_calling=_NO_AFC,
            ),
        )
        _check_blocked(fix)
        diagnostico = _parse_json(fix.text)
    if diagnostico is None:
        raise ProviderError("La IA no entregó un diagnóstico válido. Intenta de nuevo.")

    return {
        "diagnostico": diagnostico,
        "webResults": [{"url": u, "titulo": t} for u, t in web_results.items()],
        "modelo": response.model_version or model,
    }


def _generate_with_retry(contents, config):
    """Reintenta cuando Gemini responde "saturado" (5xx) o límite por minuto (429) y,
    si sigue fallando, prueba con el modelo de respaldo."""
    models = list(dict.fromkeys(m for m in (MODEL, FALLBACK_MODEL) if m))
    last_error = None
    for model in models:
        for attempt in range(len(RETRY_DELAYS) + 1):
            try:
                return _get_client().models.generate_content(model=model, contents=contents, config=config), model
            except errors.APIError as err:
                last_error = err
                if not (err.code == 429 or (err.code or 0) >= 500):
                    raise
                log.warning("Gemini %s respondió %s (intento %d): %s", model, err.code, attempt + 1, err.message)
                if attempt < len(RETRY_DELAYS):
                    time.sleep(RETRY_DELAYS[attempt])
    raise last_error


def _check_blocked(response):
    reason = getattr(response.prompt_feedback, "block_reason", None) if response.prompt_feedback else None
    if not reason and response.candidates:
        reason = response.candidates[0].finish_reason
    name = getattr(reason, "name", str(reason or ""))
    if name in ("SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "OTHER") and not response.text:
        raise ProviderError("La IA no pudo procesar esta consulta. Reformula la descripción de la falla.")


def _parse_json(text):
    if not text:
        return None
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def gemini_error_message(err):
    if not isinstance(err, errors.APIError):
        return None
    code, msg = err.code or 0, str(err.message or err)
    if code == 400 and "API" in msg.upper() and "KEY" in msg.upper():
        return "La clave de Gemini (GEMINI_API_KEY) no es válida."
    if code in (401, 403):
        return "La clave de Gemini no tiene permiso para usar este modelo."
    if code == 429:
        return "Se alcanzó el límite gratuito de Gemini. Espera un minuto (o hasta mañana si es el límite diario)."
    if code == 404:
        return f'El modelo de Gemini "{MODEL}" no existe. Revisa la variable GEMINI_MODEL.'
    if code >= 500:
        return "El servicio de Gemini está saturado. Intenta de nuevo en un momento."
    return None
