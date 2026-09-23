// Motor de diagnóstico: combina los fragmentos encontrados en los manuales del
// administrador con búsquedas en internet y devuelve un diagnóstico estructurado.
// Usa Gemini (Google) o Claude (Anthropic) según la clave configurada.
import { normalizeDiagnosis } from './prompt.js';
import { diagnoseClaude, claudeErrorMessage, ProviderError } from './providers/claude.js';
import { diagnoseGemini, geminiErrorMessage } from './providers/gemini.js';

const PROVIDERS = {
  gemini: { key: () => process.env.GEMINI_API_KEY, run: diagnoseGemini, errorMessage: geminiErrorMessage },
  claude: {
    key: () => process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    run: diagnoseClaude,
    errorMessage: claudeErrorMessage,
  },
};

// AI_PROVIDER fuerza un proveedor; si no, se usa el primero que tenga clave.
export function aiProvider() {
  const forced = (process.env.AI_PROVIDER || '').toLowerCase();
  if (PROVIDERS[forced]) return PROVIDERS[forced].key() ? forced : null;
  return Object.keys(PROVIDERS).find((name) => PROVIDERS[name].key()) || null;
}

export function aiEnabled() {
  return aiProvider() !== null;
}

export class DiagnosisError extends Error {}

/**
 * @param {object} consulta datos del formulario
 * @param {Array} excerpts fragmentos de la biblioteca (resultado de Library.search)
 * @param {{webSearch:boolean}} opts
 */
export async function diagnose(consulta, excerpts, { webSearch = true } = {}) {
  const name = aiProvider();
  if (!name) throw new DiagnosisError('La IA no está configurada.');
  const provider = PROVIDERS[name];
  try {
    const result = await provider.run(consulta, excerpts, { webSearch });
    return { ...result, diagnostico: normalizeDiagnosis(result.diagnostico), proveedor: name };
  } catch (err) {
    if (err instanceof ProviderError) throw new DiagnosisError(err.message);
    const message = provider.errorMessage(err);
    if (message) {
      console.error(`Error de ${name}:`, err.message);
      throw new DiagnosisError(message);
    }
    throw err;
  }
}
