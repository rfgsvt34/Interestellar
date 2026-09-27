"""Motor de diagnóstico: combina los fragmentos encontrados en los manuales del
administrador con búsquedas en internet y devuelve un diagnóstico estructurado.
Usa Gemini (Google) o Claude (Anthropic) según la clave configurada."""
import logging
import os

from .prompt import normalize_diagnosis
from .providers import ProviderError

log = logging.getLogger(__name__)


def _gemini():
    from .providers.gemini import diagnose_gemini, gemini_error_message

    return diagnose_gemini, gemini_error_message


def _claude():
    from .providers.claude import claude_error_message, diagnose_claude

    return diagnose_claude, claude_error_message


# Los proveedores se importan solo cuando se usan, así no hace falta instalar
# la librería de Anthropic si solo se usa Gemini.
PROVIDERS = {
    "gemini": {"key": lambda: os.getenv("GEMINI_API_KEY"), "load": _gemini},
    "claude": {"key": lambda: os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"), "load": _claude},
}


class DiagnosisError(Exception):
    pass


def ai_provider():
    """AI_PROVIDER fuerza un proveedor; si no, se usa el primero que tenga clave."""
    forced = (os.getenv("AI_PROVIDER") or "").lower()
    if forced in PROVIDERS:
        return forced if PROVIDERS[forced]["key"]() else None
    return next((name for name, p in PROVIDERS.items() if p["key"]()), None)


def ai_enabled() -> bool:
    return ai_provider() is not None


def diagnose(consulta, excerpts, web_search=True) -> dict:
    name = ai_provider()
    if not name:
        raise DiagnosisError("La IA no está configurada.")
    run, error_message = PROVIDERS[name]["load"]()
    try:
        result = run(consulta, excerpts, web_search)
    except ProviderError as err:
        raise DiagnosisError(str(err)) from err
    except Exception as err:
        message = error_message(err)
        if message:
            log.error("Error de %s: %s", name, err)
            raise DiagnosisError(message) from err
        raise
    return {**result, "diagnostico": normalize_diagnosis(result["diagnostico"]), "proveedor": name}
