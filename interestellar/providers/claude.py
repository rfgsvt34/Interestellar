"""Proveedor Claude (Anthropic), opcional: usa la herramienta web_search del
servidor y entrega el diagnóstico mediante una herramienta con esquema estricto."""
import os

import anthropic

from ..prompt import DIAGNOSIS_SCHEMA, SYSTEM_PROMPT, build_user_message
from . import ProviderError

MODEL = os.getenv("CLAUDE_MODEL") or "claude-opus-5"
MAX_TURNS = 8

DIAGNOSIS_TOOL = {
    "name": "entregar_diagnostico",
    "description": "Entrega el diagnóstico final al mecánico. Llamar una sola vez, al final, con toda la información recopilada.",
    "strict": True,
    "input_schema": DIAGNOSIS_SCHEMA,
}

SYSTEM = (
    SYSTEM_PROMPT
    + '\n\nCuando termines tu investigación, entrega el resultado llamando UNA vez a la herramienta "entregar_diagnostico". '
    "No escribas el diagnóstico como texto libre."
)

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def diagnose_claude(consulta, excerpts, web_search):
    tools = [DIAGNOSIS_TOOL]
    if web_search:
        tools.append({"type": "web_search_20260209", "name": "web_search", "max_uses": 6})

    messages = [{"role": "user", "content": build_user_message(consulta, excerpts, web_search)}]
    web_results = {}
    nudged = False

    for _ in range(MAX_TURNS):
        with _get_client().beta.messages.stream(
            model=MODEL,
            max_tokens=32000,
            system=SYSTEM,
            thinking={"type": "adaptive"},
            tools=tools,
            messages=messages,
            # Si el modelo principal rechaza la solicitud, se reintenta
            # automáticamente con el modelo de respaldo recomendado.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            response = stream.get_final_message()

        for block in response.content:
            if block.type == "web_search_tool_result" and isinstance(block.content, list):
                for r in block.content:
                    if getattr(r, "url", None):
                        web_results[r.url] = getattr(r, "title", None) or r.url

        if response.stop_reason == "refusal":
            raise ProviderError("La IA no pudo procesar esta consulta. Reformula la descripción de la falla.")

        call = next((b for b in response.content if b.type == "tool_use" and b.name == DIAGNOSIS_TOOL["name"]), None)
        if call:
            return {
                "diagnostico": call.input,
                "webResults": [{"url": u, "titulo": t} for u, t in web_results.items()],
                "modelo": response.model,
            }

        if response.stop_reason == "max_tokens":
            raise ProviderError("La respuesta de la IA fue demasiado larga. Intenta con una consulta más concreta.")

        # pause_turn: la búsqueda web sigue en curso, se continúa el mismo turno.
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "pause_turn":
            if nudged:
                break
            nudged = True
            messages.append(
                {"role": "user", "content": "Entrega ahora el diagnóstico llamando a la herramienta entregar_diagnostico."}
            )
    raise ProviderError("La IA no entregó un diagnóstico. Intenta de nuevo.")


def claude_error_message(err):
    if isinstance(err, anthropic.AuthenticationError):
        return "La clave de la API de Anthropic no es válida."
    if isinstance(err, anthropic.RateLimitError):
        return "Demasiadas consultas seguidas. Espera un momento."
    if isinstance(err, anthropic.APIConnectionError):
        return "No hay conexión con el servicio de IA."
    return None
