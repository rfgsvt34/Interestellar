"""Instrucciones, formato de respuesta y mensaje de la consulta, comunes a todos
los proveedores de IA."""
from __future__ import annotations

SYSTEM_PROMPT = """Eres un técnico automotriz máster que asiste a mecánicos de taller. Respondes siempre en español, con lenguaje técnico pero claro.

Recibirás la descripción de una falla (síntomas, parte afectada, códigos OBD-II, etc.), los datos del vehículo y, cuando existan, fragmentos de manuales y boletines técnicos que el taller tiene en su biblioteca, etiquetados como [M1], [M2]…

Cómo trabajar:
1. Primero apóyate en los fragmentos de la biblioteca del taller: son la fuente preferida. Cítalos por su etiqueta ([M1], [M2]) en el campo "fuentes" de cada causa.
2. Si la búsqueda web está disponible y los manuales no cubren el caso (o solo parcialmente), busca en internet: boletines técnicos (TSB), recalls, foros de mecánicos, bases de datos de códigos de falla, específicos para la marca, modelo, año y motor. Busca en español y en inglés. Cita las URLs que uses.
3. Si algo proviene solo de tu conocimiento general, indícalo con fuente_tipo "conocimiento".
4. Ordena las causas de más a menos probable para ESE vehículo, considerando fallas conocidas del modelo.
5. Indica dónde se ubica físicamente cada componente en ese vehículo (lado, cerca de qué pieza, cómo acceder).
6. Da pasos de diagnóstico concretos (qué medir, valores esperados si los conoces, con qué herramienta) antes de cambiar piezas.
7. Da procedimientos de reparación paso a paso, herramientas y especificaciones (torques, capacidades) solo si estás razonablemente seguro; si no, dilo.
8. Incluye advertencias de seguridad relevantes (alto voltaje en híbridos, sistema de combustible presurizado, airbags, etc.).
No inventes números de parte, torques ni valores: si no los tienes de una fuente, indica que deben verificarse en el manual del fabricante."""

_STR = {"type": "string"}
_STR_ARR = {"type": "array", "items": _STR}


def _obj(properties: dict) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


DIAGNOSIS_SCHEMA = _obj(
    {
        "resumen": {**_STR, "description": "Resumen breve del problema más probable y qué hacer primero."},
        "codigos": {
            "type": "array",
            "description": "Significado de cada código de falla informado (vacío si no hay códigos).",
            "items": _obj({"codigo": _STR, "significado": _STR}),
        },
        "causas_posibles": {
            "type": "array",
            "description": "Causas ordenadas de la más probable a la menos probable.",
            "items": _obj(
                {
                    "causa": _STR,
                    "probabilidad": {"type": "string", "enum": ["alta", "media", "baja"]},
                    "explicacion": _STR,
                    "fuente_tipo": {"type": "string", "enum": ["manual", "web", "conocimiento"]},
                    "fuentes": {**_STR_ARR, "description": "Etiquetas [M#] de manuales y/o URLs."},
                }
            ),
        },
        "ubicacion": {
            "type": "array",
            "description": "Dónde se encuentra cada componente implicado en este vehículo.",
            "items": _obj({"componente": _STR, "descripcion": _STR}),
        },
        "pasos_diagnostico": {**_STR_ARR, "description": "Pruebas en orden para confirmar la causa."},
        "reparacion": {
            "type": "array",
            "items": _obj(
                {
                    "titulo": _STR,
                    "dificultad": {"type": "string", "enum": ["facil", "media", "dificil"]},
                    "tiempo_estimado": _STR,
                    "herramientas": _STR_ARR,
                    "pasos": _STR_ARR,
                }
            ),
        },
        "advertencias": _STR_ARR,
        "fuentes_web": {
            "type": "array",
            "description": "Páginas web consultadas que respaldan el diagnóstico.",
            "items": _obj({"titulo": _STR, "url": _STR}),
        },
    }
)


def normalize_diagnosis(raw) -> dict:
    """Completa campos faltantes y corrige valores fuera de rango, por si el modelo
    no respetó exactamente el formato."""
    d = raw if isinstance(raw, dict) else {}

    def arr(v):
        return v if isinstance(v, list) else []

    def text(v):
        return "" if v is None else str(v)

    def pick(v, allowed, fallback):
        return v if v in allowed else fallback

    def get(o, k):
        return o.get(k) if isinstance(o, dict) else None

    return {
        "resumen": text(d.get("resumen")),
        "codigos": [{"codigo": text(get(c, "codigo")), "significado": text(get(c, "significado"))} for c in arr(d.get("codigos"))],
        "causas_posibles": [
            {
                "causa": text(get(c, "causa")),
                "probabilidad": pick(get(c, "probabilidad"), ("alta", "media", "baja"), "media"),
                "explicacion": text(get(c, "explicacion")),
                "fuente_tipo": pick(get(c, "fuente_tipo"), ("manual", "web", "conocimiento"), "conocimiento"),
                "fuentes": [text(f) for f in arr(get(c, "fuentes"))],
            }
            for c in arr(d.get("causas_posibles"))
        ],
        "ubicacion": [
            {"componente": text(get(u, "componente")), "descripcion": text(get(u, "descripcion"))} for u in arr(d.get("ubicacion"))
        ],
        "pasos_diagnostico": [text(p) for p in arr(d.get("pasos_diagnostico"))],
        "reparacion": [
            {
                "titulo": text(get(r, "titulo")),
                "dificultad": pick(get(r, "dificultad"), ("facil", "media", "dificil"), "media"),
                "tiempo_estimado": text(get(r, "tiempo_estimado")),
                "herramientas": [text(h) for h in arr(get(r, "herramientas"))],
                "pasos": [text(p) for p in arr(get(r, "pasos"))],
            }
            for r in arr(d.get("reparacion"))
        ],
        "advertencias": [text(a) for a in arr(d.get("advertencias"))],
        "fuentes_web": [{"titulo": text(get(w, "titulo")), "url": text(get(w, "url"))} for w in arr(d.get("fuentes_web"))],
    }


def build_user_message(consulta: dict, excerpts: list[dict], web_search: bool) -> str:
    v = consulta.get("vehiculo") or {}
    lines = [
        "## Vehículo",
        f"- Marca: {v.get('marca') or 'no indicada'}",
        f"- Modelo: {v.get('modelo') or 'no indicado'}",
        f"- Año: {v.get('anio') or 'no indicado'}",
    ]
    for key, label in (("motor", "Motor"), ("transmision", "Transmisión"), ("kilometraje", "Kilometraje"), ("vin", "VIN")):
        if v.get(key):
            lines.append(f"- {label}: {v[key]}")
    lines += ["", "## Falla reportada"]
    for key, label in (
        ("falla", "Falla"),
        ("parte", "Parte / sistema"),
        ("problema", "Descripción del problema"),
    ):
        if consulta.get(key):
            lines.append(f"- {label}: {consulta[key]}")
    if consulta.get("codigos"):
        lines.append(f"- Códigos de falla: {', '.join(consulta['codigos'])}")
    if consulta.get("sintomas"):
        lines.append(f"- Síntomas / condiciones: {consulta['sintomas']}")
    if consulta.get("pruebas"):
        lines.append(f"- Lo que ya se revisó o cambió: {consulta['pruebas']}")
    lines.append("")

    if excerpts:
        lines.append("## Fragmentos de la biblioteca del taller")
        for i, e in enumerate(excerpts, 1):
            where = f", página {e['pagina']}" if e.get("pagina") else ""
            lines += [f'<fragmento etiqueta="[M{i}]" documento="{e["titulo"]}{where}">', e["texto"], "</fragmento>", ""]
    else:
        lines += ["## Biblioteca del taller", "No se encontraron fragmentos relevantes en los manuales del taller.", ""]

    lines.append(
        "La búsqueda web está disponible: úsala para completar lo que no esté en los manuales y para verificar fallas conocidas de este vehículo."
        if web_search
        else "La búsqueda web NO está disponible en esta consulta: trabaja solo con los manuales y tu conocimiento."
    )
    return "\n".join(lines)
