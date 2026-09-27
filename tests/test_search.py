import shutil
import tempfile
import unittest

from interestellar.extract import chunk_pages
from interestellar.prompt import normalize_diagnosis
from interestellar.search import SearchIndex, extract_codes, tokenize
from interestellar.store import Library, year_in_range


class SearchTests(unittest.TestCase):
    def test_extract_codes(self):
        self.assertEqual(extract_codes("Tiene p0301, P0171 y u0100"), ["P0301", "P0171", "U0100"])

    def test_tokenize_ignora_acentos_y_palabras_vacias(self):
        self.assertEqual(tokenize("La Transmisión del motor"), ["transmision", "motor"])

    def test_year_in_range(self):
        self.assertTrue(year_in_range(2015, "2013-2019"))
        self.assertFalse(year_in_range(2020, "2013-2019"))
        self.assertTrue(year_in_range(2012, "2010, 2012"))

    def test_chunk_pages(self):
        chunks = chunk_pages([{"page": 1, "text": "Oración de prueba. " * 300}])
        self.assertGreater(len(chunks), 2)
        self.assertTrue(all(c["page"] == 1 and len(c["text"]) <= 1400 for c in chunks))

    def test_prioriza_codigo_de_falla(self):
        idx = SearchIndex()
        idx.add("a", 0, "Falla de encendido en cilindro, revisar bobinas y bujías.")
        idx.add("b", 0, "Código P0301: falla de encendido detectada en el cilindro 1.")
        self.assertEqual(idx.search("falla de encendido", ["P0301"])[0]["doc_id"], "b")
        idx.remove_doc("b")
        self.assertEqual(idx.size, 1)

    def test_normalize_diagnosis(self):
        d = normalize_diagnosis({"causas_posibles": [{"causa": "x", "probabilidad": "ALTA?"}]})
        self.assertEqual(d["causas_posibles"][0]["probabilidad"], "media")
        self.assertEqual(d["reparacion"], [])


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_indexa_prioriza_y_elimina(self):
        lib = Library(self.dir)
        lib.init()
        nissan = lib.add(b"Sensor de oxigeno: codigo P0134, ubicado en el multiple de escape.", "nissan.txt", "text/plain",
                         {"marca": "Nissan", "modelo": "Sentra", "anios": "2013-2019"})
        lib.add(b"Sensor de oxigeno: codigo P0134, ubicado despues del catalizador.", "ford.txt", "text/plain",
                {"marca": "Ford", "modelo": "Focus"})
        res = lib.search("sensor oxigeno", ["P0134"], {"marca": "Nissan", "modelo": "Sentra", "anio": "2016"})
        self.assertEqual(res[0]["docId"], nissan["id"])

        lib2 = Library(self.dir)
        lib2.init()
        self.assertEqual(len(lib2.list()), 2)
        self.assertEqual(lib2.index.size, 2)
        lib2.remove(nissan["id"])
        self.assertEqual(len(lib2.list()), 1)


if __name__ == "__main__":
    unittest.main()
