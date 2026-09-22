const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let token = sessionStorage.getItem('adminToken') || '';
let docs = [];
let pendingFiles = [];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/admin/login') {
    logout();
    throw new Error(data.error || 'Sesión expirada.');
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---------- Sesión ----------
$('#login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#loginError').classList.add('hidden');
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#password').value }),
    });
    token = data.token;
    sessionStorage.setItem('adminToken', token);
    showPanel();
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').classList.remove('hidden');
  }
});

$('#logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  logout();
});

function logout() {
  token = '';
  sessionStorage.removeItem('adminToken');
  $('#panel').classList.add('hidden');
  $('#logout').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

function showPanel() {
  $('#login').classList.add('hidden');
  $('#panel').classList.remove('hidden');
  $('#logout').classList.remove('hidden');
  loadDocs();
}

if (token) showPanel();

fetch('/api/estado')
  .then((r) => r.json())
  .then((s) => ($('#formats').textContent = `Formatos: ${s.formatos.join(', ')}`))
  .catch(() => {});

// ---------- Pestañas ----------
document.querySelectorAll('.tabs button').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.tab));
    if (btn.dataset.tab === 'consultas') loadHistory();
  })
);

// ---------- Subida ----------
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  setFiles([...e.dataTransfer.files]);
});
$('#files').addEventListener('change', (e) => setFiles([...e.target.files]));

function setFiles(files) {
  pendingFiles = files;
  $('#fileList').innerHTML = files.map((f) => `<div>📄 ${esc(f.name)} <span class="muted">(${fmtSize(f.size)})</span></div>`).join('');
}

$('#uploadForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!pendingFiles.length) {
    $('#uploadStatus').textContent = 'Selecciona al menos un archivo.';
    return;
  }
  const fd = new FormData();
  for (const f of pendingFiles) fd.append('archivos', f);
  for (const id of ['titulo', 'u_marca', 'u_modelo', 'u_anios', 'u_categoria', 'u_notas']) {
    const el = $(`#${id}`);
    fd.append(el.name, el.value);
  }
  $('#uploadBtn').disabled = true;
  $('#uploadStatus').textContent = 'Subiendo y extrayendo texto…';
  $('#uploadResult').innerHTML = '';
  try {
    const data = await api('/api/admin/documentos', { method: 'POST', body: fd });
    $('#uploadResult').innerHTML = data.resultados
      .map((r) =>
        r.error
          ? `<div class="alert error">${esc(r.archivo)}: ${esc(r.error)}</div>`
          : `<div class="alert ${r.documento.aviso ? 'warn' : 'ok'}">${esc(r.archivo)}: ${r.documento.fragmentos} fragmentos indexados${
              r.documento.aviso ? ` — ${esc(r.documento.aviso)}` : ''
            }</div>`
      )
      .join('');
    pendingFiles = [];
    $('#uploadForm').reset();
    $('#fileList').innerHTML = '';
    loadDocs();
  } catch (err) {
    $('#uploadResult').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  } finally {
    $('#uploadBtn').disabled = false;
    $('#uploadStatus').textContent = '';
  }
});

// ---------- Lista de documentos ----------
async function loadDocs() {
  try {
    docs = await api('/api/admin/documentos');
    renderDocs();
  } catch (err) {
    $('#docs').innerHTML = `<tr><td colspan="5" class="muted">${esc(err.message)}</td></tr>`;
  }
}

$('#filter').addEventListener('input', renderDocs);

function renderDocs() {
  const f = $('#filter').value.toLowerCase();
  const rows = docs.filter((d) => !f || [d.titulo, d.marca, d.modelo, d.nombreArchivo].join(' ').toLowerCase().includes(f));
  $('#docCount').textContent = `(${docs.length})`;
  $('#docs').innerHTML = rows.length
    ? rows
        .map(
          (d) => `<tr>
        <td><a href="/api/documentos/${encodeURIComponent(d.id)}/archivo" target="_blank" rel="noopener"><strong>${esc(d.titulo)}</strong></a>
          <div class="muted small">${esc(d.nombreArchivo)}${d.categoria ? ` · ${esc(d.categoria)}` : ''}</div>
          ${d.aviso ? `<div class="small" style="color:var(--warn)">${esc(d.aviso)}</div>` : ''}</td>
        <td>${esc([d.marca, d.modelo, d.anios].filter(Boolean).join(' ') || 'General')}</td>
        <td class="small">${d.paginas ? `${d.paginas} pág. · ` : ''}${d.fragmentos} frag.<div class="muted">${fmtSize(d.tamano)}</div></td>
        <td class="small">${new Date(d.uploadedAt).toLocaleDateString()}</td>
        <td><button class="small secondary" data-edit="${esc(d.id)}">Editar</button>
            <button class="danger" data-del="${esc(d.id)}">Eliminar</button></td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="muted">${docs.length ? 'Sin coincidencias.' : 'Aún no hay documentos. Sube el primero arriba.'}</td></tr>`;
}

$('#docs').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  const edit = e.target.closest('[data-edit]');
  if (del) {
    const d = docs.find((x) => x.id === del.dataset.del);
    if (!confirm(`¿Eliminar "${d.titulo}" de la biblioteca?`)) return;
    try {
      await api(`/api/admin/documentos/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
      loadDocs();
    } catch (err) {
      alert(err.message);
    }
  }
  if (edit) {
    const d = docs.find((x) => x.id === edit.dataset.edit);
    const changes = {};
    for (const [key, label] of [['titulo', 'Título'], ['marca', 'Marca'], ['modelo', 'Modelo'], ['anios', 'Años (ej. 2013-2019)']]) {
      const v = prompt(label, d[key] || '');
      if (v === null) return;
      changes[key] = v;
    }
    try {
      await api(`/api/admin/documentos/${encodeURIComponent(d.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      loadDocs();
    } catch (err) {
      alert(err.message);
    }
  }
});

// ---------- Probar búsqueda ----------
$('#searchForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const results = await api(`/api/admin/buscar?q=${encodeURIComponent($('#q').value)}`);
    $('#searchResults').innerHTML = results.length
      ? results
          .map(
            (r) => `<div class="excerpt"><strong>${esc(r.titulo)}</strong>${r.pagina ? ` · pág. ${r.pagina}` : ''}
              <span class="muted">· relevancia ${r.score}</span><pre>${esc(r.texto)}</pre></div>`
          )
          .join('')
      : '<p class="muted">Sin resultados.</p>';
  } catch (err) {
    $('#searchResults').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
});

// ---------- Historial ----------
async function loadHistory() {
  try {
    const rows = await api('/api/admin/consultas');
    $('#history').innerHTML = rows.length
      ? rows
          .map((h) => {
            const v = h.consulta.vehiculo;
            const falla = [h.consulta.falla, h.consulta.codigos.join(', '), h.consulta.problema].filter(Boolean).join(' · ');
            return `<tr><td class="small">${new Date(h.fecha).toLocaleString()}</td>
              <td>${esc([v.marca, v.modelo, v.anio].join(' '))}</td>
              <td class="small">${esc(falla.slice(0, 160))}</td>
              <td class="small">${esc(h.causaPrincipal)}</td>
              <td class="small">${h.manualesUsados} manual${h.busquedaWeb ? ' + web' : ''}</td></tr>`;
          })
          .join('')
      : '<tr><td colspan="5" class="muted">Aún no hay consultas.</td></tr>';
  } catch (err) {
    $('#history').innerHTML = `<tr><td colspan="5" class="muted">${esc(err.message)}</td></tr>`;
  }
}

function fmtSize(n) {
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
