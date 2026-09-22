const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const FIELDS = ['falla', 'parte', 'problema', 'codigos', 'sintomas', 'pruebas'];
const VEHICLE = ['marca', 'modelo', 'anio', 'motor', 'transmision', 'kilometraje', 'vin'];

fetch('/api/estado')
  .then((r) => r.json())
  .then((s) => {
    $('#status').textContent = `${s.documentos} manual(es) en la biblioteca${s.ia ? '' : ' · IA no configurada'}`;
    if (!s.ia) $('#buscarWeb').closest('label').classList.add('hidden');
  })
  .catch(() => {});

$('#clear').addEventListener('click', () => {
  $('#form').reset();
  $('#result').innerHTML = '';
  $('#error').classList.add('hidden');
});

$('#form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = { vehiculo: {}, buscarWeb: $('#buscarWeb').checked };
  for (const f of FIELDS) body[f] = $(`#${f}`).value;
  for (const f of VEHICLE) body.vehiculo[f] = $(`#${f}`).value;

  $('#error').classList.add('hidden');
  $('#result').innerHTML = '';
  $('#submit').disabled = true;
  $('#loading').classList.remove('hidden');
  const msgs = body.buscarWeb
    ? ['Buscando en los manuales del taller', 'Consultando fuentes en internet', 'Revisando boletines y fallas conocidas', 'Armando el diagnóstico']
    : ['Buscando en los manuales del taller', 'Armando el diagnóstico'];
  let i = 0;
  $('#loadingMsg').textContent = msgs[0];
  const timer = setInterval(() => ($('#loadingMsg').textContent = msgs[Math.min(++i, msgs.length - 1)]), 9000);

  try {
    const res = await fetch('/api/diagnostico', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'Error inesperado.');
      if (data.fuentesManual?.length) renderLibraryOnly(data, body);
      return;
    }
    if (data.modo === 'ia') renderDiagnosis(data, body);
    else renderLibraryOnly(data, body);
    $('#result').scrollIntoView({ behavior: 'smooth' });
  } catch {
    showError('No se pudo conectar con el servidor.');
  } finally {
    clearInterval(timer);
    $('#submit').disabled = false;
    $('#loading').classList.add('hidden');
  }
});

function showError(msg) {
  $('#error').textContent = msg;
  $('#error').classList.remove('hidden');
}

function vehicleLabel(v) {
  return [v.marca, v.modelo, v.anio, v.motor].filter(Boolean).join(' ');
}

function docLink(src) {
  const page = src.pagina ? `#page=${src.pagina}` : '';
  return `/api/documentos/${encodeURIComponent(src.docId)}/archivo${page}`;
}

// Convierte "[M2]" o una URL en un enlace.
function renderRef(ref, manualByTag) {
  const tag = ref.match(/\[?M\d+\]?/i)?.[0];
  if (tag) {
    const key = `[${tag.replace(/[[\]]/g, '').toUpperCase()}]`;
    const src = manualByTag.get(key);
    if (src) {
      const page = src.pagina ? `, pág. ${src.pagina}` : '';
      return `<a href="${docLink(src)}" target="_blank" rel="noopener">${esc(key)} ${esc(src.titulo)}${page}</a>`;
    }
  }
  if (/^https?:\/\//i.test(ref)) {
    let host = ref;
    try { host = new URL(ref).hostname.replace(/^www\./, ''); } catch {}
    return `<a href="${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a>`;
  }
  return esc(ref);
}

const list = (items, ordered = false) =>
  items?.length ? `<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>` : '';

const SRC_LABEL = { manual: 'Manual del taller', web: 'Internet', conocimiento: 'Conocimiento general' };
const DIFF_LABEL = { facil: 'Fácil', media: 'Media', dificil: 'Difícil' };

function renderDiagnosis(data, body) {
  const d = data.diagnostico;
  const manualByTag = new Map(data.fuentesManual.map((m) => [m.etiqueta, m]));
  const html = [];

  html.push(`<div class="card">
    <h2>Diagnóstico · ${esc(vehicleLabel(body.vehiculo))}</h2>
    <p class="summary">${esc(d.resumen)}</p>
    <p class="muted small">Fuentes: ${data.fuentesManual.length} fragmento(s) de manuales${
      data.busquedaWeb ? ` · ${data.paginasWeb.length} página(s) web revisadas` : ' · sin búsqueda web'
    } · ${data.segundos}s</p>
    <div class="actions no-print"><button class="secondary small" onclick="window.print()">Imprimir</button></div>
  </div>`);

  if (d.codigos?.length) {
    html.push(`<div class="card"><h2>Códigos de falla</h2><table>
      ${d.codigos.map((c) => `<tr><td><strong>${esc(c.codigo)}</strong></td><td>${esc(c.significado)}</td></tr>`).join('')}
    </table></div>`);
  }

  if (d.causas_posibles?.length) {
    html.push(`<div class="card"><h2>Posibles causas</h2>
      ${d.causas_posibles
        .map(
          (c, i) => `<div class="cause">
            <div class="cause-head"><span class="num">${i + 1}.</span><strong>${esc(c.causa)}</strong>
              <span class="pill ${esc(c.probabilidad)}">Probabilidad ${esc(c.probabilidad)}</span>
              <span class="pill src">${esc(SRC_LABEL[c.fuente_tipo] || c.fuente_tipo)}</span></div>
            <p>${esc(c.explicacion)}</p>
            ${c.fuentes?.length ? `<div class="refs">Fuentes: ${c.fuentes.map((f) => renderRef(f, manualByTag)).join(' · ')}</div>` : ''}
          </div>`
        )
        .join('')}
    </div>`);
  }

  if (d.ubicacion?.length) {
    html.push(`<div class="card"><h2>Dónde se ubica</h2><table>
      ${d.ubicacion.map((u) => `<tr><td><strong>${esc(u.componente)}</strong></td><td>${esc(u.descripcion)}</td></tr>`).join('')}
    </table></div>`);
  }

  if (d.pasos_diagnostico?.length) {
    html.push(`<div class="card"><h2>Cómo confirmar la falla</h2>${list(d.pasos_diagnostico, true)}</div>`);
  }

  if (d.reparacion?.length) {
    html.push(`<div class="card"><h2>Cómo arreglarlo</h2>
      ${d.reparacion
        .map(
          (r) => `<h3>${esc(r.titulo)}</h3>
          <p class="muted small">Dificultad: ${esc(DIFF_LABEL[r.dificultad] || r.dificultad)}${
            r.tiempo_estimado ? ` · Tiempo estimado: ${esc(r.tiempo_estimado)}` : ''
          }</p>
          ${r.herramientas?.length ? `<p class="small"><strong>Herramientas:</strong> ${r.herramientas.map(esc).join(', ')}</p>` : ''}
          ${list(r.pasos, true)}`
        )
        .join('')}
    </div>`);
  }

  if (d.advertencias?.length) {
    html.push(`<div class="card"><h2>⚠ Advertencias</h2>${list(d.advertencias)}</div>`);
  }

  html.push(renderSources(data, d));
  $('#result').innerHTML = html.join('');
}

function renderSources(data, d = {}) {
  const parts = [];
  if (data.fuentesManual?.length) {
    parts.push(`<h3>Manuales del taller</h3>
      ${data.fuentesManual
        .map(
          (m) => `<details class="excerpt"><summary>${esc(m.etiqueta)} ${esc(m.titulo)}${
            m.pagina ? ` · pág. ${m.pagina}` : ''
          } — <a href="${docLink(m)}" target="_blank" rel="noopener">abrir</a></summary><pre>${esc(m.texto)}</pre></details>`
        )
        .join('')}`);
  }
  const web = (d.fuentes_web || []).filter((w) => /^https?:\/\//i.test(w.url));
  if (web.length) {
    parts.push(`<h3>Páginas web citadas</h3><ul>${web
      .map((w) => `<li><a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${esc(w.titulo || w.url)}</a></li>`)
      .join('')}</ul>`);
  }
  const revisadas = (data.paginasWeb || []).filter((w) => /^https?:\/\//i.test(w.url));
  if (revisadas.length) {
    parts.push(`<details><summary class="small">Todas las páginas revisadas (${revisadas.length})</summary><ul class="small">${revisadas
      .map((w) => `<li><a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${esc(w.titulo)}</a></li>`)
      .join('')}</ul></details>`);
  }
  return parts.length ? `<div class="card"><h2>Fuentes</h2>${parts.join('')}</div>` : '';
}

function renderLibraryOnly(data, body) {
  const html = [];
  if (data.aviso) html.push(`<div class="alert warn">${esc(data.aviso)}</div>`);
  if (!data.fuentesManual?.length) {
    html.push(`<div class="card"><p>No se encontró información en los manuales para ${esc(vehicleLabel(body.vehiculo))}.</p></div>`);
  } else {
    html.push(`<div class="card"><h2>Resultados en los manuales · ${esc(vehicleLabel(body.vehiculo))}</h2>
      ${data.fuentesManual
        .map(
          (m) => `<div class="excerpt"><strong>${esc(m.titulo)}</strong>${m.pagina ? ` · pág. ${m.pagina}` : ''} —
            <a href="${docLink(m)}" target="_blank" rel="noopener">abrir</a><pre>${esc(m.texto)}</pre></div>`
        )
        .join('')}</div>`);
  }
  $('#result').innerHTML = html.join('');
}
