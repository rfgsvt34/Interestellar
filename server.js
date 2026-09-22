import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { Library } from './src/store.js';
import { isSupported, SUPPORTED_EXTENSIONS } from './src/extract.js';
import { extractCodes } from './src/search.js';
import { diagnose, aiEnabled, DiagnosisError } from './src/diagnose.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;

let library = new Library(process.env.DATA_DIR || path.join(here, 'data'));
try {
  await library.init();
} catch (err) {
  // Si DATA_DIR apunta a una carpeta sin permisos (p. ej. /var/data sin disco en Render),
  // se usa la carpeta local del proyecto para que el servidor arranque igual.
  if (!process.env.DATA_DIR || !['EACCES', 'EPERM', 'EROFS'].includes(err.code)) throw err;
  console.warn(`⚠ No se puede escribir en ${process.env.DATA_DIR} (${err.code}). Usando ./data; los archivos se perderán al reiniciar.`);
  library = new Library(path.join(here, 'data'));
  await library.init();
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20 },
});

// ---------- Autenticación del administrador ----------
const sessions = new Map(); // token -> expira (ms)
const SESSION_MS = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Sesión de administrador no válida o expirada.' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Configura ADMIN_PASSWORD en el archivo .env para usar el panel.' });
  }
  if (!safeEqual(req.body?.password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.json({ token });
});

app.post('/api/admin/logout', (req, res) => {
  sessions.delete((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  res.json({ ok: true });
});

// ---------- Estado ----------
app.get('/api/estado', (_req, res) => {
  res.json({
    ia: aiEnabled(),
    documentos: library.list().length,
    fragmentos: library.index.size,
    formatos: SUPPORTED_EXTENSIONS,
  });
});

// ---------- Diagnóstico (panel del mecánico) ----------
function parseConsulta(body = {}) {
  const s = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
  const v = body.vehiculo || {};
  const consulta = {
    falla: s(body.falla, 300),
    parte: s(body.parte, 300),
    problema: s(body.problema),
    sintomas: s(body.sintomas),
    pruebas: s(body.pruebas),
    codigos: [],
    vehiculo: {
      marca: s(v.marca, 60),
      modelo: s(v.modelo, 80),
      anio: s(v.anio, 4),
      motor: s(v.motor, 80),
      transmision: s(v.transmision, 60),
      kilometraje: s(v.kilometraje, 20),
      vin: s(v.vin, 17),
    },
  };
  const rawCodes = s(body.codigos, 500);
  consulta.codigos = [
    ...new Set([
      ...extractCodes(rawCodes),
      // también acepta códigos de fabricante no-OBD separados por coma/espacio
      ...rawCodes
        .split(/[\s,;]+/)
        .filter((c) => /^[A-Z0-9-]{3,12}$/i.test(c) && /\d/.test(c))
        .map((c) => c.toUpperCase()),
    ]),
  ].slice(0, 20);
  return consulta;
}

app.post('/api/diagnostico', async (req, res) => {
  const consulta = parseConsulta(req.body);
  const { vehiculo } = consulta;
  if (!consulta.falla && !consulta.problema && !consulta.codigos.length && !consulta.parte) {
    return res.status(400).json({ error: 'Describe la falla, el problema o ingresa algún código de falla.' });
  }
  if (!vehiculo.marca || !vehiculo.modelo || !vehiculo.anio) {
    return res.status(400).json({ error: 'Indica la marca, el modelo y el año del vehículo.' });
  }

  const queryText = [consulta.falla, consulta.parte, consulta.problema, consulta.sintomas, consulta.codigos.join(' ')]
    .filter(Boolean)
    .join(' ');
  const excerpts = library.search({ text: queryText, codes: consulta.codigos, vehiculo }, 8);
  const webSearch = req.body.buscarWeb !== false;
  const inicio = Date.now();

  const fuentesManual = excerpts.map((e, i) => ({
    etiqueta: `[M${i + 1}]`,
    docId: e.docId,
    titulo: e.titulo,
    pagina: e.pagina,
    texto: e.texto,
  }));

  if (!aiEnabled()) {
    return res.json({
      modo: 'solo-biblioteca',
      aviso: 'La IA no está configurada (falta ANTHROPIC_API_KEY). Se muestran solo los fragmentos encontrados en los manuales.',
      fuentesManual,
    });
  }

  try {
    const result = await diagnose(consulta, excerpts, { webSearch });
    const respuesta = {
      modo: 'ia',
      diagnostico: result.diagnostico,
      fuentesManual,
      paginasWeb: result.webResults,
      busquedaWeb: webSearch,
      segundos: Math.round((Date.now() - inicio) / 1000),
    };
    library
      .addHistory({
        fecha: new Date().toISOString(),
        consulta,
        resumen: result.diagnostico.resumen,
        causaPrincipal: result.diagnostico.causas_posibles?.[0]?.causa || '',
        manualesUsados: fuentesManual.length,
        busquedaWeb: webSearch,
        modelo: result.modelo,
      })
      .catch((err) => console.error('No se pudo guardar el historial:', err));
    res.json(respuesta);
  } catch (err) {
    console.error('Error en diagnóstico:', err);
    let message = 'No se pudo completar el diagnóstico. Intenta de nuevo.';
    if (err instanceof DiagnosisError) message = err.message;
    else if (err instanceof Anthropic.AuthenticationError) message = 'La clave de la API de Anthropic no es válida.';
    else if (err instanceof Anthropic.RateLimitError) message = 'Demasiadas consultas seguidas. Espera un momento.';
    else if (err instanceof Anthropic.APIConnectionError) message = 'No hay conexión con el servicio de IA.';
    res.status(502).json({ error: message, fuentesManual });
  }
});

const SAFE_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Descarga / visualización de un documento de la biblioteca (para las citas).
app.get('/api/documentos/:id/archivo', (req, res) => {
  const doc = library.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  // El tipo se decide por la extensión (no por lo que dijo el navegador al subir);
  // HTML y demás se muestran como texto para no ejecutar scripts en este sitio.
  res.type(SAFE_TYPES[path.extname(doc.storedName)] || 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.nombreArchivo)}`);
  res.sendFile(library.filePath(doc));
});

// ---------- Panel de administrador ----------
app.get('/api/admin/documentos', requireAdmin, (_req, res) => {
  res.json(library.list());
});

app.post('/api/admin/documentos', requireAdmin, upload.array('archivos'), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

  const resultados = [];
  for (const f of files) {
    // multer entrega el nombre en latin1; se convierte a UTF-8 para conservar acentos.
    const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
    if (!isSupported(originalName)) {
      resultados.push({ archivo: originalName, error: `Formato no soportado. Usa: ${SUPPORTED_EXTENSIONS.join(', ')}` });
      continue;
    }
    try {
      const meta = { ...req.body, titulo: files.length === 1 ? req.body.titulo : '' };
      const doc = await library.add({ buffer: f.buffer, originalName, mime: f.mimetype }, meta);
      resultados.push({ archivo: originalName, documento: doc });
    } catch (err) {
      console.error(`Error procesando ${originalName}:`, err);
      resultados.push({ archivo: originalName, error: `No se pudo leer el archivo: ${err.message}` });
    }
  }
  res.json({ resultados });
});

app.patch('/api/admin/documentos/:id', requireAdmin, async (req, res) => {
  const doc = await library.update(req.params.id, req.body || {});
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  res.json(doc);
});

app.delete('/api/admin/documentos/:id', requireAdmin, async (req, res) => {
  const ok = await library.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Documento no encontrado.' });
  res.json({ ok: true });
});

// Prueba de búsqueda en la biblioteca (sin IA) desde el panel de admin.
app.get('/api/admin/buscar', requireAdmin, (req, res) => {
  const q = String(req.query.q || '');
  res.json(library.search({ text: q, codes: extractCodes(q) }, 10));
});

app.get('/api/admin/consultas', requireAdmin, async (_req, res) => {
  res.json(await library.history(200));
});

// Errores de subida (tamaño, etc.)
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera el límite de ${MAX_UPLOAD_MB} MB.` : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(PORT, () => {
  console.log(`Interestellar listo en http://localhost:${PORT}`);
  console.log(`  Panel del mecánico: http://localhost:${PORT}/`);
  console.log(`  Panel de administrador: http://localhost:${PORT}/admin.html`);
  if (!aiEnabled()) console.warn('  ⚠ ANTHROPIC_API_KEY no configurada: solo se buscará en los manuales.');
  if (!ADMIN_PASSWORD) console.warn('  ⚠ ADMIN_PASSWORD no configurada: el panel de administrador está deshabilitado.');
});
