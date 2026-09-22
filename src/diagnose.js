// Motor de diagnóstico: combina los fragmentos encontrados en los manuales del
// administrador con búsquedas en internet (herramienta web_search de Claude) y
// devuelve un diagnóstico estructurado.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const MAX_TURNS = 8;

let client = null;
export function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `Eres un técnico automotriz máster que asiste a mecánicos de taller. Respondes siempre en español, con lenguaje técnico pero claro.

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
No inventes números de parte, torques ni valores: si no los tienes de una fuente, indica que deben verificarse en el manual del fabricante.

Cuando termines tu investigación, entrega el resultado llamando UNA vez a la herramienta "entregar_diagnostico". No escribas el diagnóstico como texto libre.`;

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const DIAGNOSIS_TOOL = {
  name: 'entregar_diagnostico',
  description:
    'Entrega el diagnóstico final al mecánico. Llamar una sola vez, al final, con toda la información recopilada.',
  strict: true,
  input_schema: obj({
    resumen: { ...str, description: 'Resumen breve del problema más probable y qué hacer primero.' },
    codigos: {
      type: 'array',
      description: 'Significado de cada código de falla informado (vacío si no hay códigos).',
      items: obj({ codigo: str, significado: str }),
    },
    causas_posibles: {
      type: 'array',
      description: 'Causas ordenadas de la más probable a la menos probable.',
      items: obj({
        causa: str,
        probabilidad: { type: 'string', enum: ['alta', 'media', 'baja'] },
        explicacion: str,
        fuente_tipo: { type: 'string', enum: ['manual', 'web', 'conocimiento'] },
        fuentes: { ...strArr, description: 'Etiquetas [M#] de manuales y/o URLs.' },
      }),
    },
    ubicacion: {
      type: 'array',
      description: 'Dónde se encuentra cada componente implicado en este vehículo.',
      items: obj({ componente: str, descripcion: str }),
    },
    pasos_diagnostico: { ...strArr, description: 'Pruebas en orden para confirmar la causa.' },
    reparacion: {
      type: 'array',
      items: obj({
        titulo: str,
        dificultad: { type: 'string', enum: ['facil', 'media', 'dificil'] },
        tiempo_estimado: str,
        herramientas: strArr,
        pasos: strArr,
      }),
    },
    advertencias: strArr,
    fuentes_web: {
      type: 'array',
      description: 'Páginas web consultadas que respaldan el diagnóstico.',
      items: obj({ titulo: str, url: str }),
    },
  }),
};

function buildUserMessage(consulta, excerpts, webSearch) {
  const v = consulta.vehiculo || {};
  const lines = [
    '## Vehículo',
    `- Marca: ${v.marca || 'no indicada'}`,
    `- Modelo: ${v.modelo || 'no indicado'}`,
    `- Año: ${v.anio || 'no indicado'}`,
    v.motor ? `- Motor: ${v.motor}` : null,
    v.transmision ? `- Transmisión: ${v.transmision}` : null,
    v.kilometraje ? `- Kilometraje: ${v.kilometraje}` : null,
    v.vin ? `- VIN: ${v.vin}` : null,
    '',
    '## Falla reportada',
    consulta.falla ? `- Falla: ${consulta.falla}` : null,
    consulta.parte ? `- Parte / sistema: ${consulta.parte}` : null,
    consulta.problema ? `- Descripción del problema: ${consulta.problema}` : null,
    consulta.codigos?.length ? `- Códigos de falla: ${consulta.codigos.join(', ')}` : null,
    consulta.sintomas ? `- Síntomas / condiciones: ${consulta.sintomas}` : null,
    consulta.pruebas ? `- Lo que ya se revisó o cambió: ${consulta.pruebas}` : null,
    '',
  ];

  if (excerpts.length) {
    lines.push('## Fragmentos de la biblioteca del taller');
    excerpts.forEach((e, i) => {
      const where = e.pagina ? `, página ${e.pagina}` : '';
      lines.push(`<fragmento etiqueta="[M${i + 1}]" documento="${e.titulo}${where}">`, e.texto, '</fragmento>', '');
    });
  } else {
    lines.push('## Biblioteca del taller', 'No se encontraron fragmentos relevantes en los manuales del taller.', '');
  }

  lines.push(
    webSearch
      ? 'La búsqueda web está disponible: úsala para completar lo que no esté en los manuales y para verificar fallas conocidas de este vehículo.'
      : 'La búsqueda web NO está disponible en esta consulta: trabaja solo con los manuales y tu conocimiento.'
  );
  return lines.filter((l) => l !== null).join('\n');
}

/**
 * @param {object} consulta datos del formulario
 * @param {Array} excerpts fragmentos de la biblioteca (resultado de Library.search)
 * @param {{webSearch:boolean}} opts
 */
export async function diagnose(consulta, excerpts, { webSearch = true } = {}) {
  const tools = [DIAGNOSIS_TOOL];
  if (webSearch) tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 6 });

  const messages = [{ role: 'user', content: buildUserMessage(consulta, excerpts, webSearch) }];
  const webResults = new Map(); // url -> title
  let nudged = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await getClient()
      .beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        system: SYSTEM_PROMPT,
        thinking: { type: 'adaptive' },
        tools,
        messages,
        // Si el modelo principal rechaza la solicitud, se reintenta
        // automáticamente con el modelo de respaldo recomendado.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
      .finalMessage();

    collectWebResults(response.content, webResults);

    if (response.stop_reason === 'refusal') {
      throw new DiagnosisError('La IA no pudo procesar esta consulta. Reformula la descripción de la falla.');
    }

    const call = response.content.find((b) => b.type === 'tool_use' && b.name === DIAGNOSIS_TOOL.name);
    if (call) {
      return {
        diagnostico: call.input,
        webResults: [...webResults].map(([url, titulo]) => ({ url, titulo })),
        modelo: response.model,
        uso: response.usage,
      };
    }

    if (response.stop_reason === 'max_tokens') {
      throw new DiagnosisError('La respuesta de la IA fue demasiado larga. Intenta con una consulta más concreta.');
    }

    // pause_turn: la búsqueda web sigue en curso, se continúa el mismo turno.
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'pause_turn') {
      if (nudged) break;
      nudged = true;
      messages.push({
        role: 'user',
        content: 'Entrega ahora el diagnóstico llamando a la herramienta entregar_diagnostico.',
      });
    }
  }
  throw new DiagnosisError('La IA no entregó un diagnóstico. Intenta de nuevo.');
}

function collectWebResults(content, into) {
  for (const block of content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url) into.set(r.url, r.title || r.url);
    }
  }
}

export class DiagnosisError extends Error {}
