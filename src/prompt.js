// Instrucciones, formato de respuesta y mensaje de la consulta, comunes a todos
// los proveedores de IA.

export const SYSTEM_PROMPT = `Eres un técnico automotriz máster que asiste a mecánicos de taller. Respondes siempre en español, con lenguaje técnico pero claro.

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
No inventes números de parte, torques ni valores: si no los tienes de una fuente, indica que deben verificarse en el manual del fabricante.`;

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const DIAGNOSIS_SCHEMA = obj({
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
  });

// Completa campos faltantes y corrige valores fuera de rango, por si el modelo
// no respetó exactamente el formato (p. ej. cuando la respuesta llega como texto).
export function normalizeDiagnosis(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const text = (v) => (v == null ? '' : String(v));
  const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
  return {
    resumen: text(d.resumen),
    codigos: arr(d.codigos).map((c) => ({ codigo: text(c?.codigo), significado: text(c?.significado) })),
    causas_posibles: arr(d.causas_posibles).map((c) => ({
      causa: text(c?.causa),
      probabilidad: pick(c?.probabilidad, ['alta', 'media', 'baja'], 'media'),
      explicacion: text(c?.explicacion),
      fuente_tipo: pick(c?.fuente_tipo, ['manual', 'web', 'conocimiento'], 'conocimiento'),
      fuentes: arr(c?.fuentes).map(text),
    })),
    ubicacion: arr(d.ubicacion).map((u) => ({ componente: text(u?.componente), descripcion: text(u?.descripcion) })),
    pasos_diagnostico: arr(d.pasos_diagnostico).map(text),
    reparacion: arr(d.reparacion).map((r) => ({
      titulo: text(r?.titulo),
      dificultad: pick(r?.dificultad, ['facil', 'media', 'dificil'], 'media'),
      tiempo_estimado: text(r?.tiempo_estimado),
      herramientas: arr(r?.herramientas).map(text),
      pasos: arr(r?.pasos).map(text),
    })),
    advertencias: arr(d.advertencias).map(text),
    fuentes_web: arr(d.fuentes_web).map((w) => ({ titulo: text(w?.titulo), url: text(w?.url) })),
  };
}

export function buildUserMessage(consulta, excerpts, webSearch) {
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
