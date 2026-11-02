El etiquetador añade etiquetas a las filas de un conjunto de datos. Puedes etiquetar tú mismo cada fila, o dejar que un modelo de IA etiquete filas mientras revisas su trabajo. El resultado es un conjunto de datos etiquetado que puedes usar en una ejecución.

## Iniciar una sesión

Abre el etiquetador de una de estas formas:

- Abre el etiquetador desde el panel principal.
- En **Conjuntos de datos**, selecciona un conjunto de datos y haz clic en **Etiquetar este conjunto de datos**.
- En el editor de conjuntos de datos, haz clic en **Etiquetar con IA**.

### Elegir los datos

La configuración te pide los datos que quieres etiquetar:

- **Elige de tu biblioteca** usa un conjunto de datos que subiste. Para subir un archivo nuevo, usa primero [Conjuntos de datos](/docs/guides/datasets).
- **Generar un conjunto de datos sintético** crea filas por ti. Esta opción necesita el asistente de IA.

### Elegir el tipo de tarea

| Tipo de tarea                 | Qué das a cada fila                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| **Pregunta de sí / no**       | Una respuesta de sí o no.                                                                |
| **Elegir entre categorías**   | Una o más categorías de una lista que tú defines. Añade al menos dos categorías.         |
| **Respuestas escritas**       | Una respuesta de texto libre.                                                            |

### Elegir un modo

La configuración pregunta «¿Cómo quieres etiquetar?». Hay tres modos:

| Modo                     | Qué ocurre                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Manual**               | Tú etiquetas cada fila. No interviene ninguna IA.                                                                  |
| **Copiloto** (Co-pilot)  | Después de una breve entrevista, la IA etiqueta un primer lote. Conservas o corriges cada etiqueta en rondas de revisión. |
| **Piloto automático** (Autopilot) | Después de una breve entrevista, la IA etiqueta todas las filas y marca las filas de las que no está segura.       |

La configuración marca un modo como **Recomendado**.

La configuración también ofrece la opción **Modelo de etiquetado**. El valor predeterminado sirve para la mayoría de los conjuntos de datos.

> [!NOTE]
> En la app para Mac, el etiquetado con IA necesita tu propia clave del proveedor. Elige un modelo en **Tu propia clave**. Consulta [App para Mac](/docs/guides/mac-app).

## La entrevista sobre el conjunto de datos

Copiloto y Piloto automático empiezan con una **Entrevista sobre el conjunto de datos**. La IA hace preguntas sobre tus datos y tus etiquetas. Puedes hacer clic en **Omitir la entrevista**.

La entrevista construye una **Guía de etiquetado**. La guía contiene las reglas que sigue la IA. Usa **Añadir una regla** para añadir tu propia regla.

Al final, la IA muestra **Este es el plan**. Después empiezas el trabajo:

- En Copiloto, haz clic en **Etiquetar las primeras {rows} filas para mi revisión**.
- En Piloto automático, haz clic en **Etiquetar todas las {rows} filas**.

## Rondas de revisión del Copiloto

En Copiloto, la IA etiqueta primero un lote de calibración. El tamaño del lote depende del tipo de tarea:

| Tipo de tarea              | Primer lote                                                  |
| -------------------------- | ------------------------------------------------------------ |
| Pregunta de sí / no        | 24 filas                                                     |
| Elegir entre categorías    | 6 filas por categoría, como mínimo 30 y como máximo 60       |
| Respuestas escritas        | 30 filas                                                     |

Si el conjunto de datos tiene menos filas, la IA las etiqueta todas.

### Revisar cada etiqueta

Para cada fila, el panel lateral muestra la etiqueta de la IA:

1. Lee la fila y la etiqueta.
2. Para conservar la etiqueta, haz clic en **Confirmar (Intro)** o pulsa Intro.
3. Para cambiar la etiqueta, corrígela. El panel muestra «Corregido: la IA aprenderá de esto».
4. Cuando termines, haz clic en **Terminar esta ronda**.

El panel muestra el objetivo: «Cuando coincidamos el {gate}% de las veces, me encargaré de etiquetar el resto.»

### El umbral de coincidencia

Después de cada ronda, Skynet mide con qué frecuencia coincidiste con la IA. El umbral es del 92 % en las tareas de sí / no y de categorías. Es del 85 % en las respuestas escritas.

El resumen de la ronda muestra «Coincidiste con la IA en el {agreement}%». Después eliges:

- **Una ronda de revisión más** te da otro lote para revisar.
- **Etiquetar las {rows} filas restantes** deja que la IA etiquete el resto.

## Piloto automático y etiquetado automático

Cuando la IA etiqueta las filas restantes, el trabajo se ejecuta en el servidor. Puedes salir de la página sin problemas y volver más tarde.

- **Reanudar etiquetado** continúa un trabajo detenido.
- **Cancelar: conservar lo etiquetado** detiene el trabajo y conserva las etiquetas que ya existen.

### Revisar las filas dudosas

La IA asigna una confianza a cada etiqueta automática. Skynet marca una fila cuando la confianza es inferior a 0,75. Después del trabajo, haz clic en **Revisar {count} filas de las que la IA no estaba segura** para comprobarlas.

> [!TIP]
> Revisa las filas marcadas antes de usar los datos en una ejecución. Las etiquetas incorrectas reducen la calidad de la optimización.

## Modo manual

En el modo Manual, tú etiquetas cada fila. Los atajos de teclado siguientes te ayudan a trabajar rápido.

### Atajos de teclado

| Tecla            | Acción                                                         |
| ---------------- | -------------------------------------------------------------- |
| Ctrl+H o Cmd+H   | Mostrar los atajos.                                            |
| Y / N            | Responder sí o no en una fila de sí / no.                      |
| De 1 a 9         | Seleccionar o quitar esa categoría en una fila de categorías.  |
| U                | Ir a la siguiente fila sin etiquetar.                          |
| Inicio           | Ir a la primera fila.                                          |
| E                | Exportar como CSV.                                             |

## Resultados

Los resultados muestran de dónde vino cada etiqueta:

| Recuento                                 | Significado                                    |
| ---------------------------------------- | ---------------------------------------------- |
| **Etiquetadas por ti**                   | Etiquetas que escribiste tú.                   |
| **Etiquetas de IA confirmadas por ti**   | Etiquetas de la IA que conservaste al revisar. |
| **Etiquetadas automáticamente**          | Etiquetas de la IA sin revisión.               |
| **Coste**                                | El coste del trabajo de la IA en esta sesión.  |

La columna **Origen** muestra los mismos valores para cada fila: **Tú**, **IA confirmado** o **IA**.

## Guardar y exportar

### Guardar en la biblioteca

Haz clic en **Guardar en la biblioteca** o en **Mover a Conjuntos de datos** para conservar los datos etiquetados como un conjunto de datos. Después puedes usarlo en una [ejecución](/docs/guides/submit).

### Exportar un archivo

Haz clic en **Exportar etiquetas** y elige un formato:

- CSV
- JSON
- Excel (`.xlsx`)
- Parquet
- Feather

Si algunas filas no tienen etiqueta, Skynet te pide que confirmes la exportación.

La exportación añade una columna de etiqueta. Su nombre depende del tipo de tarea:

| Tipo de tarea              | Columna               |
| -------------------------- | --------------------- |
| Pregunta de sí / no        | `binary_label`        |
| Elegir entre categorías    | `selected_categories` |
| Respuestas escritas        | `extracted_text`      |

Una columna `label_source` registra de dónde vino cada etiqueta.

## Sesiones

Cada trabajo de etiquetado es una sesión. Una sesión tiene uno de estos estados: **En curso**, **En revisión**, **Etiquetado automático** o **Completado**. Haz clic en **Iniciar sesión nueva** para empezar de nuevo con otros ajustes.

Puedes compartir una sesión con otras personas desde su cuadro de diálogo para compartir. Para conocer las reglas, consulta [Compartir y publicar](/docs/guides/sharing).

## Próximos pasos

- [Prepara un conjunto de datos](/docs/guides/datasets) antes de etiquetar.
- [Inicia una ejecución con el asistente](/docs/guides/submit) con los datos etiquetados.
- Pregunta al [panel del agente](/docs/guides/agent-panel) por tus sesiones de etiquetado.
