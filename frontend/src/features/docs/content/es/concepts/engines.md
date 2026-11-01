Un motor es el método de búsqueda que propone versiones nuevas de tu artefacto. Skynet tiene seis motores nativos para artefactos de tipo Prompt, Código y Texto, tres optimizadores de DSPy para programas DSPy, y **Auto**. Esta página explica qué hace cada uno, cuándo elegirlo y qué ajustes tiene.

Lee primero [Cómo funciona la optimización](/docs/concepts/optimization) si no sabes qué motores encajan con tu artefacto.

## Comparación rápida

| Motor                 | Tipos de artefacto       | Ajustes del agente de código          | Ajuste de iteraciones máx. |
| --------------------- | ------------------------ | ------------------------------------- | -------------------------- |
| Auto                  | Todos                    | Sí, en Prompt, Código y Texto         | No                         |
| GEPA                  | Prompt, Código, Texto    | No                                    | No                         |
| Best-of-N             | Prompt, Código, Texto    | No                                    | No                         |
| AutoResearch          | Prompt, Código, Texto    | Sí                                    | No                         |
| Meta-Harness          | Prompt, Código, Texto    | Sí                                    | Sí                         |
| AutoSaddler           | Prompt, Código, Texto    | Sí                                    | Sí                         |
| ShinkaEvolve          | Prompt, Código, Texto    | No. Tiene su propio ajuste de editor. | Sí                         |
| DSPy GEPA             | Programa DSPy            | No                                    | No                         |
| DSPy MIPROv2          | Programa DSPy            | No                                    | No                         |
| DSPy BootstrapFewShot | Programa DSPy            | No                                    | No                         |

El asistente marca GEPA, DSPy GEPA y Auto como optimizadores que usan el texto de los comentarios de tu métrica.

## Auto

Auto es la opción predeterminada. Lo que ejecuta depende del tipo de artefacto:

- **Programa DSPy**: Auto ejecuta DSPy GEPA.
- **Prompt, Código o Texto**: Auto explora con cinco motores a la vez: GEPA, AutoResearch, Meta-Harness, AutoSaddler y ShinkaEvolve. Cada motor recibe una parte igual de las ejecuciones del evaluador: el presupuesto dividido entre 6. Después GEPA continúa desde la mejor versión con el resto del presupuesto.

Auto no usa Best-of-N.

> [!WARNING]
> En un artefacto de tipo Prompt, Código o Texto, Auto necesita al menos 6 ejecuciones del evaluador: 5 carriles de exploración y una continuación. Los cinco motores deben estar disponibles. Si alguno no lo está, selecciona un solo motor.

**Elígelo cuando** no sepas qué motor encaja. Es el mejor punto de partida.

## GEPA

«Evolución reflexiva con un frente de Pareto de versiones». El modelo de reflexión lee la puntuación y los comentarios de cada caso y escribe una versión mejor. GEPA mantiene un frente de versiones, cada una de las cuales es la mejor en algunos casos.

**Elígelo cuando** tu métrica dé comentarios concretos y quieras un único motor potente.

## Best-of-N

«Propuestas independientes del modelo de reflexión; conserva la mejor». Cada propuesta es independiente de las demás. Skynet vuelve a puntuar las mejores propuestas con los casos de validación.

**Elígelo cuando** quieras una línea base sencilla para compararla con otros motores.

## AutoResearch

Un agente de código hace rondas de investigación. Edita, puntúa y conserva lo que ayuda hasta que se agota el presupuesto.

**Elígelo cuando** un buen cambio requiera varios pasos de investigación, por ejemplo en un artefacto de tipo Código.

## Meta-Harness

Un agente de código propone un lote de candidatos en cada iteración. Usa el historial completo de candidatos y puntuaciones.

**Elígelo cuando** quieras un agente que aprenda del historial de todos los intentos anteriores. Usa **Candidatos por iteración** para fijar el tamaño del lote.

## AutoSaddler

Un agente de código lee los comentarios de tu métrica y aplica parches a la versión. Skynet solo conserva los parches que confirma una nueva ejecución del evaluador.

**Elígelo cuando** los comentarios de tu métrica señalen defectos claros y localizados.

## ShinkaEvolve

«Evoluciona muchas versiones en islas paralelas y aprende qué modelos las mejoran más». Es una búsqueda evolutiva sobre una población de candidatos, con mutaciones y cruces que escribe un modelo.

**Elígelo cuando** quieras una exploración amplia y tengas un presupuesto mayor.

## Optimizadores de DSPy

| Optimizador           | Qué hace                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| DSPy GEPA             | Lee los comentarios de la métrica y hace evolucionar las instrucciones de cada predictor.                                          |
| DSPy MIPROv2          | Propone instrucciones y demostraciones few-shot a la vez, y busca sus combinaciones con optimización bayesiana.                    |
| DSPy BootstrapFewShot | Reúne ejemplos resueltos que el programa acierta y los añade como demostraciones few-shot. No usa un modelo de reflexión.          |

DSPy MIPROv2 y DSPy BootstrapFewShot necesitan pares (casos con salidas esperadas).

## Ajustes

### Presupuesto

| Ajuste                                  | Valor predeterminado | Rango                                                             |
| --------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| Máximo de ejecuciones del evaluador     | 200                  | De 1 a 100000 (Auto: al menos 6)                                  |
| Detener al llegar a la puntuación       | Desactivado          | 0 o más                                                           |
| Iteraciones máx.                        | Desactivado          | De 1 a 1000. Solo Meta-Harness, AutoSaddler y ShinkaEvolve.       |

Una ejecución del evaluador es una llamada de tu métrica sobre un caso. La nueva puntuación final de la versión inicial y de la ganadora no cuenta para **Máximo de ejecuciones del evaluador**.

### Ajustes del agente de código

Estos ajustes se aplican a Auto, AutoResearch, Meta-Harness y AutoSaddler.

| Ajuste                                   | Valor predeterminado | Rango                                                     |
| ---------------------------------------- | -------------------- | --------------------------------------------------------- |
| Agente de código                         | Codex                | Pi, Codex, OpenCode, Prime Agent, comando personalizado   |
| Candidatos por iteración                 | 3                    | De 1 a 8. Se muestra para Auto y Meta-Harness.            |
| Máximo de llamadas a herramientas por candidato | 100           | De 1 a 1000                                               |

### Ajustes de ShinkaEvolve

| Ajuste                                          | Valor predeterminado                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Cómo se escriben las versiones nuevas           | Una sola llamada al modelo. La otra opción es «Agente de código (Pi)».  |
| Islas                                           | 2 (de 1 a 8)                                                            |
| Intervalo de migración                          | 10                                                                      |
| Selección de padres                             | Ponderada. Otras opciones: ley de potencias, búsqueda en haz.           |
| Ediciones diff / Reescrituras completas / Cruces | 60 % / 30 % / 10 %. Deben sumar 100 %.                                 |
| Tamaño del archivo                              | 40                                                                      |
| Evaluaciones en paralelo                        | 2                                                                       |
| Propuestas en paralelo                          | 2                                                                       |

Cuando Auto ejecuta ShinkaEvolve, el asistente muestra estos ajustes como «Ajustes de ShinkaEvolve (cuando Auto lo ejecuta)».

## Páginas relacionadas

- [Cómo funciona la optimización](/docs/concepts/optimization)
- [Métricas y evaluadores](/docs/concepts/scorers)
- [Ejecuciones](/docs/concepts/runs)
- [Facturación](/docs/concepts/billing)
