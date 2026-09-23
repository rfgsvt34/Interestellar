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

## Instalación

Requiere Node.js 22 o superior.

```bash
npm install
cp .env.example .env   # y edita GEMINI_API_KEY y ADMIN_PASSWORD
npm start
```

Abre `http://localhost:3000` (mecánicos) y `http://localhost:3000/admin.html` (administrador).

### Variables de entorno

| Variable | Descripción |
|---|---|
| `GEMINI_API_KEY` | Clave de Gemini ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)), con capa gratuita. Busca en internet con Google. |
| `ANTHROPIC_API_KEY` | Alternativa de pago: clave de Claude ([console.anthropic.com](https://console.anthropic.com/)). |
| `AI_PROVIDER` | `gemini` o `claude`, si configuras las dos claves. Sin él se usa Gemini. |
| `GEMINI_MODEL` | Modelo de Gemini (por defecto `gemini-flash-latest`). |
| `ADMIN_PASSWORD` | Contraseña del panel de administrador. Sin ella el panel queda deshabilitado. |
| `PORT` | Puerto del servidor (por defecto 3000). |
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
server.js            API y servidor web (Express)
src/extract.js       extracción de texto (PDF, DOCX, TXT…) y fragmentación
src/search.js        índice de búsqueda BM25 y detección de códigos DTC
src/store.js         biblioteca de documentos e historial en disco
src/diagnose.js      elige el proveedor de IA y normaliza el diagnóstico
src/prompt.js        instrucciones y formato del diagnóstico
src/providers/       Gemini (Google) y Claude (Anthropic)
public/              panel del mecánico y panel de administrador
test/                pruebas (npm test)
```

## Publicar en Render

El archivo `render.yaml` ya trae la configuración. En Render: **New → Blueprint**, elige este repositorio, escribe `GEMINI_API_KEY` y `ADMIN_PASSWORD` cuando los pida y confirma. Usa el plan `starter` (no se apaga) con un disco de 1 GB montado en `/var/data` para que los manuales subidos no se pierdan.
