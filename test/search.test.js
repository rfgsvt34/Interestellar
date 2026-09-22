import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SearchIndex, extractCodes, tokenize } from '../src/search.js';
import { chunkPages } from '../src/extract.js';
import { Library, yearInRange } from '../src/store.js';

test('extractCodes detecta códigos OBD-II', () => {
  assert.deepEqual(extractCodes('Tiene p0301, P0171 y u0100'), ['P0301', 'P0171', 'U0100']);
});

test('tokenize ignora acentos y palabras vacías', () => {
  assert.deepEqual(tokenize('La Transmisión del motor'), ['transmision', 'motor']);
});

test('yearInRange acepta rangos y listas', () => {
  assert.equal(yearInRange(2015, '2013-2019'), true);
  assert.equal(yearInRange(2020, '2013-2019'), false);
  assert.equal(yearInRange(2012, '2010, 2012'), true);
});

test('chunkPages divide textos largos con solapamiento', () => {
  const text = 'Oración de prueba. '.repeat(300);
  const chunks = chunkPages([{ page: 1, text }]);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((c) => c.page === 1 && c.text.length <= 1400));
});

test('el índice prioriza coincidencias de código de falla', () => {
  const idx = new SearchIndex();
  idx.add('a', 0, 'Falla de encendido en cilindro, revisar bobinas y bujías.');
  idx.add('b', 0, 'Código P0301: falla de encendido detectada en el cilindro 1.');
  const [first] = idx.search({ text: 'falla de encendido', codes: ['P0301'] });
  assert.equal(first.docId, 'b');
  idx.removeDoc('b');
  assert.equal(idx.size, 1);
});

test('Library indexa, prioriza por vehículo y elimina documentos', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interestellar-'));
  try {
    const lib = new Library(dir);
    await lib.init();
    const nissan = await lib.add(
      { buffer: Buffer.from('Sensor de oxígeno: código P0134, ubicado en el múltiple de escape.'), originalName: 'nissan.txt', mime: 'text/plain' },
      { marca: 'Nissan', modelo: 'Sentra', anios: '2013-2019' }
    );
    await lib.add(
      { buffer: Buffer.from('Sensor de oxígeno: código P0134, ubicado después del catalizador.'), originalName: 'ford.txt', mime: 'text/plain' },
      { marca: 'Ford', modelo: 'Focus' }
    );
    const results = lib.search({ text: 'sensor oxigeno', codes: ['P0134'], vehiculo: { marca: 'Nissan', modelo: 'Sentra', anio: '2016' } });
    assert.equal(results[0].docId, nissan.id);

    // Se recarga desde disco
    const lib2 = new Library(dir);
    await lib2.init();
    assert.equal(lib2.list().length, 2);
    assert.equal(lib2.index.size, 2);

    await lib2.remove(nissan.id);
    assert.equal(lib2.list().length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
