// Proveedor Claude (Anthropic): usa la herramienta web_search del servidor y
// entrega el diagnóstico mediante una herramienta con esquema estricto.
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, DIAGNOSIS_SCHEMA, buildUserMessage } from '../prompt.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const MAX_TURNS = 8;

const DIAGNOSIS_TOOL = {
  name: 'entregar_diagnostico',
  description:
    'Entrega el diagnóstico final al mecánico. Llamar una sola vez, al final, con toda la información recopilada.',
  strict: true,
  input_schema: DIAGNOSIS_SCHEMA,
};

const SYSTEM = `${SYSTEM_PROMPT}

Cuando termines tu investigación, entrega el resultado llamando UNA vez a la herramienta "entregar_diagnostico". No escribas el diagnóstico como texto libre.`;

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export class ProviderError extends Error {}

export async function diagnoseClaude(consulta, excerpts, { webSearch }) {
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
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        tools,
        messages,
        // Si el modelo principal rechaza la solicitud, se reintenta
        // automáticamente con el modelo de respaldo recomendado.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
      .finalMessage();

    for (const block of response.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url) webResults.set(r.url, r.title || r.url);
      }
    }

    if (response.stop_reason === 'refusal') {
      throw new ProviderError('La IA no pudo procesar esta consulta. Reformula la descripción de la falla.');
    }

    const call = response.content.find((b) => b.type === 'tool_use' && b.name === DIAGNOSIS_TOOL.name);
    if (call) {
      return {
        diagnostico: call.input,
        webResults: [...webResults].map(([url, titulo]) => ({ url, titulo })),
        modelo: response.model,
      };
    }

    if (response.stop_reason === 'max_tokens') {
      throw new ProviderError('La respuesta de la IA fue demasiado larga. Intenta con una consulta más concreta.');
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
  throw new ProviderError('La IA no entregó un diagnóstico. Intenta de nuevo.');
}

export function claudeErrorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'La clave de la API de Anthropic no es válida.';
  if (err instanceof Anthropic.RateLimitError) return 'Demasiadas consultas seguidas. Espera un momento.';
  if (err instanceof Anthropic.APIConnectionError) return 'No hay conexión con el servicio de IA.';
  return null;
}
