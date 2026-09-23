// Proveedor Gemini (Google): usa la búsqueda de Google integrada ("grounding")
// y pide el diagnóstico en JSON.
import { GoogleGenAI, ApiError } from '@google/genai';
import { SYSTEM_PROMPT, DIAGNOSIS_SCHEMA, buildUserMessage } from '../prompt.js';
import { ProviderError } from './claude.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

const JSON_INSTRUCTIONS = `

Formato de salida: responde ÚNICAMENTE con un objeto JSON válido (sin texto antes ni después y sin bloques de código) que cumpla este esquema JSON:
${JSON.stringify(DIAGNOSIS_SCHEMA)}`;

let client = null;
function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export async function diagnoseGemini(consulta, excerpts, { webSearch }) {
  const ai = getClient();
  const userMessage = buildUserMessage(consulta, excerpts, webSearch);

  // La búsqueda de Google no se puede combinar con la salida JSON forzada, así que
  // con búsqueda se pide el JSON por instrucciones y, si no llega bien, se hace
  // una segunda llamada (sin búsqueda) que solo convierte la respuesta a JSON.
  const config = { systemInstruction: SYSTEM_PROMPT + JSON_INSTRUCTIONS };
  if (webSearch) {
    config.tools = [{ googleSearch: {} }];
  } else {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = DIAGNOSIS_SCHEMA;
  }

  const response = await ai.models.generateContent({ model: MODEL, contents: userMessage, config });
  checkBlocked(response);

  const webResults = new Map();
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  for (const c of chunks) if (c.web?.uri) webResults.set(c.web.uri, c.web.title || c.web.uri);

  let diagnostico = parseJson(response.text);
  if (!diagnostico) {
    const fix = await ai.models.generateContent({
      model: MODEL,
      contents: `Convierte este diagnóstico al formato JSON indicado, sin perder información:\n\n${response.text || ''}`,
      config: { responseMimeType: 'application/json', responseJsonSchema: DIAGNOSIS_SCHEMA },
    });
    checkBlocked(fix);
    diagnostico = parseJson(fix.text);
  }
  if (!diagnostico) throw new ProviderError('La IA no entregó un diagnóstico válido. Intenta de nuevo.');

  return {
    diagnostico,
    webResults: [...webResults].map(([url, titulo]) => ({ url, titulo })),
    modelo: response.modelVersion || MODEL,
  };
}

function checkBlocked(response) {
  const reason = response.promptFeedback?.blockReason || response.candidates?.[0]?.finishReason;
  if (reason && ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'OTHER'].includes(reason) && !response.text) {
    throw new ProviderError('La IA no pudo procesar esta consulta. Reformula la descripción de la falla.');
  }
}

function parseJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function geminiErrorMessage(err) {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 400 && /API[_ ]KEY/i.test(err.message)) return 'La clave de Gemini (GEMINI_API_KEY) no es válida.';
  if (err.status === 401 || err.status === 403) return 'La clave de Gemini no tiene permiso para usar este modelo.';
  if (err.status === 429) return 'Se alcanzó el límite gratuito de Gemini. Espera un minuto (o hasta mañana si es el límite diario).';
  if (err.status === 404) return `El modelo de Gemini "${MODEL}" no existe. Revisa la variable GEMINI_MODEL.`;
  if (err.status >= 500) return 'El servicio de Gemini está saturado. Intenta de nuevo en un momento.';
  return null;
}
