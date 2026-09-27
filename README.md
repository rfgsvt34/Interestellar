# Interestellar — Diagnóstico para mecánicos

Aplicación web con dos paneles:

- **Panel del mecánico** (`/`): se captura la falla, la parte o sistema del vehículo, la descripción del problema, los códigos de falla (DTC) y los datos del vehículo (marca, modelo, año, motor, etc.). El sistema responde con:
  - posibles causas, ordenadas por probabilidad y con sus fuentes,
  - dónde se ubica la pieza o el componente,
  - pruebas para confirmar la falla,
  - cómo arreglarlo (pasos, herramientas, dificultad y tiempo),
  - advertencias de seguridad.
- **Panel de administrador** (`/admin.html`, protegido con contraseña): se suben manuales de servicio, boletines técnicos (TSB), diagramas, tablas de códigos o notas del taller (PDF, DOCX, TXT, MD, CSV, JSON, HTML). Cada archivo puede etiquetarse con marca, modelo y años para que tenga prioridad en la búsqueda. También permite probar la búsqueda y ver el historial de consultas.

## Cómo funciona

1. El texto de cada archivo se extrae, se divide en fragmentos y se indexa (búsqueda BM25 con prioridad para códigos OBD-II y para documentos del mismo vehículo).
2. En cada consulta se buscan los fragmentos más relevantes de la biblioteca.
3. Esos fragmentos se envían a la IA (Gemini de Google o Claude de Anthropic), que además **busca en internet** (boletines, recalls, foros, bases de datos de códigos) lo que no esté en los archivos. La casilla "Buscar también en internet" permite desactivarlo.
4. La IA devuelve un diagnóstico estructurado. Cada causa indica si viene de un manual del taller (con enlace al documento y página), de internet (con la URL) o de conocimiento general.

Si no hay ninguna clave de IA configurada, la aplicación sigue funcionando en modo **solo biblioteca**: muestra los fragmentos encontrados en los manuales.

## Cómo correrlo en tu computadora (localhost)

Necesitas **Python 3.10 o superior** ([python.org/downloads](https://www.python.org/downloads/); en Windows marca la casilla *"Add Python to PATH"* al instalar).

1. Descarga el proyecto (en GitHub: **Code → Download ZIP**, y descomprímelo) o clónalo con `git clone`.
2. Abre una terminal **dentro de la carpeta del proyecto** y crea un entorno virtual con las librerías:

   **Windows (PowerShell o CMD)**
   ```bat
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   copy .env.example .env
   ```

   **Mac / Linux**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env
   ```

3. Abre el archivo `.env` con cualquier editor de texto y llena `GEMINI_API_KEY` (tu clave `AIza...`) y `ADMIN_PASSWORD`.
4. Arranca el servidor:
   ```bash
   python app.py
   ```
5. Abre en el navegador:
   - Panel del mecánico: **http://localhost:3000**
   - Panel de administrador: **http://localhost:3000/admin.html**

Para detenerlo, presiona `Ctrl + C` en la terminal. Las siguientes veces solo necesitas activar el entorno (paso 2, segunda línea) y correr `python app.py`.

Los manuales subidos se guardan en la carpeta `data/` del proyecto; no se borran al cerrar el programa.

Pruebas: `python -m unittest discover -s tests`

### Variables de entorno

| Variable | Descripción |
|---|---|
| `GEMINI_API_KEY` | Clave de Gemini ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)), con capa gratuita. Busca en internet con Google. |
| `ANTHROPIC_API_KEY` | Alternativa de pago: clave de Claude ([console.anthropic.com](https://console.anthropic.com/)). |
| `AI_PROVIDER` | `gemini` o `claude`, si configuras las dos claves. Sin él se usa Gemini. |
| `GEMINI_MODEL` | Modelo de Gemini (por defecto `gemini-flash-latest`). |
| `ADMIN_PASSWORD` | Contraseña del panel de administrador. Sin ella el panel queda deshabilitado. |
| `PORT` | Puerto del servidor (por defecto 3000). |
| `GEMINI_FALLBACK_MODEL` | Modelo de respaldo si Gemini está saturado (por defecto `gemini-flash-lite-latest`). |
| `CLAUDE_MODEL` | Modelo de Claude (por defecto `claude-opus-5`). |
| `DATA_DIR` | Carpeta donde se guardan los archivos, el índice y el historial (por defecto `./data`). |
| `MAX_UPLOAD_MB` | Tamaño máximo por archivo (por defecto 50 MB). |

## Notas

- Los PDF escaneados (imágenes sin texto) todavía no se pueden leer; el panel de administrador lo avisa al subirlos. Conviene pasarlos antes por un OCR.
- Los documentos de la biblioteca se pueden abrir desde los enlaces de las fuentes del diagnóstico sin iniciar sesión, para que el mecánico consulte la página citada.
- La búsqueda web la hace la IA (Gemini usa la Búsqueda de Google); no depende de tener Safari o Google instalados.
- En la capa gratuita de Gemini hay límites de consultas por minuto y por día, y Google puede usar las consultas para mejorar sus productos.
- Con Claude, si el modelo principal rechaza una consulta, la API la reintenta automáticamente con el modelo de respaldo recomendado (`fallbacks: "default"`).
- Con Claude, cada consulta tiene un costo en la cuenta de Anthropic.

## Estructura

```
app.py                         servidor web (Flask) y rutas de la API
interestellar/extract.py       extracción de texto (PDF, DOCX, TXT…) y fragmentación
interestellar/search.py        índice de búsqueda BM25 y detección de códigos DTC
interestellar/store.py         biblioteca de documentos e historial en disco
interestellar/diagnose.py      elige el proveedor de IA y normaliza el diagnóstico
interestellar/prompt.py        instrucciones y formato del diagnóstico
interestellar/providers/       Gemini (Google) y Claude (Anthropic)
public/                        panel del mecánico y panel de administrador (HTML/JS/CSS)
tests/                         pruebas
```

## Publicar en Render

El archivo `render.yaml` ya trae la configuración (Python + gunicorn). En Render: **New → Blueprint**, elige este repositorio, escribe `GEMINI_API_KEY` y `ADMIN_PASSWORD` cuando los pida y confirma. Usa el plan `starter` (no se apaga) con un disco de 1 GB montado en `/var/data` para que los manuales subidos no se pierdan.
