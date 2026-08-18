# Cómo poner esto en marcha (gratis)

Yo he escrito el código. Esto de aquí son los pasos para que quede publicado y funcionando, y luego cómo tocarlo tú mismo cuando quieras cambiar algo.

## Qué contiene esta carpeta

- `index.html` — lo que ve el usuario (el formulario y el resultado)
- `api/generate-itinerary.js` — la parte que llama a la IA de forma segura (nunca se ve desde el navegador)
- `package.json` — configuración mínima del proyecto

## Paso 1 — Consigue tu clave de la API de Claude

1. Ve a [console.anthropic.com](https://console.anthropic.com) y crea una cuenta.
2. En la sección **API Keys**, crea una nueva clave y guárdala (no la compartas ni la subas a ningún sitio público).
3. Anthropic suele dar algo de crédito gratis al registrarte. Con el modelo que uso aquí (Haiku), cada itinerario generado cuesta unos pocos céntimos — con 5-10€ de crédito puedes probar cientos de veces.

## Paso 2 — Sube el código a GitHub

1. Crea una cuenta en [github.com](https://github.com) si no tienes.
2. Crea un repositorio nuevo (puede ser privado) y sube esta carpeta completa (`itinerario-ia-app`).
   - Más fácil: en GitHub Desktop o directamente arrastrando los archivos desde la web de GitHub al crear el repositorio.

## Paso 3 — Despliega en Vercel (gratis)

1. Ve a [vercel.com](https://vercel.com) y crea una cuenta (puedes entrar directamente con tu cuenta de GitHub).
2. Pulsa **"Add New" → "Project"** y elige el repositorio que acabas de subir.
3. Vercel detecta automáticamente que es un proyecto con funciones API, no hace falta que toques nada de configuración.
4. Antes de darle a "Deploy", ve a **Environment Variables** y añade:
   - Nombre: `ANTHROPIC_API_KEY`
   - Valor: la clave que copiaste en el Paso 1
5. Dale a **Deploy**. En 1-2 minutos tendrás una URL pública tipo `tu-proyecto.vercel.app` ya funcionando, gratis.

## Paso 4 — Pruébalo desde el móvil

Abre esa URL desde el navegador del móvil. Puedes incluso "Añadir a pantalla de inicio" para que se sienta como una app de verdad, sin pasar por ninguna tienda de aplicaciones.

## Cómo tocarlo tú mismo cuando quieras cambiar algo

No hace falta que sepas programar para estos cambios — son solo texto dentro de los archivos:

- **Cambiar los tipos de aventura o los textos**: abre `index.html`, busca el bloque que empieza por `const adventures = [` cerca del final del archivo, y edita los textos entre comillas.
- **Cambiar el criterio de la IA** (qué sabe de cada destino, el tono, qué debe incluir): abre `api/generate-itinerary.js` y edita el texto dentro de `systemPrompt`. Esto es lo más importante para que no suene genérico — cuanto más metas ahí de lo que ya sabes de cada destino, mejor será el resultado.
- **Cambiar colores/diseño**: en `index.html`, arriba del todo hay un bloque `:root{...}` con los colores en formato `--accent: #2dd4bf;` — cambia esos códigos de color.

Cada vez que cambies algo y lo subas a GitHub, Vercel vuelve a publicar la app automáticamente en menos de un minuto — no hay que repetir el Paso 3.

## Si algo falla

Si al generar el itinerario sale un error en la app, casi siempre es por:
1. La clave `ANTHROPIC_API_KEY` no está bien puesta en Vercel (revisa el Paso 3.4)
2. Se acabó el crédito gratis de la cuenta de Anthropic (añade unos euros de saldo en console.anthropic.com)

Si te atascas en cualquier paso, vuelve aquí y cuéntame exactamente en qué paso estás y qué mensaje de error ves, y seguimos desde ahí.
