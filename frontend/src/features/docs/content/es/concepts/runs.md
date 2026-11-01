Una ejecución es una optimización. Tiene un estado, un límite de gasto y un conjunto de versiones guardadas. Esta página explica los estados de una ejecución, las acciones que puedes realizar sobre ella y los motivos por los que se detiene.

## Estados de una ejecución

Cada ejecución tiene uno de estos estados:

| Estado       | Significado                                                                     |
| ------------ | ------------------------------------------------------------------------------- |
| `pending`    | La ejecución está en la cola.                                                   |
| `validating` | Skynet comprueba la configuración antes de que empiece la optimización.         |
| `running`    | El optimizador propone y puntúa versiones nuevas.                               |
| `success`    | La ejecución terminó. La mejor versión está guardada.                           |
| `failed`     | Un error detuvo la ejecución.                                                   |
| `cancelled`  | Una persona canceló la ejecución.                                               |
| `paused`     | La ejecución se detuvo en un punto de control. Puedes reanudarla.               |
| `stopped`    | La ejecución se detuvo al llegar a su presupuesto. Conserva la mejor versión que encontró. |

`success`, `failed`, `cancelled`, `stopped` y `paused` son estados terminales. El optimizador no trabaja en una ejecución que está en un estado terminal. `paused` es el único estado terminal pensado para reanudarse.

## Acciones

La página de la ejecución muestra las acciones que se aplican al estado actual y a tu rol. La API tiene las mismas acciones.

| Acción        | Cuándo puedes usarla                                                                                                     | Qué hace                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **Pausar**    | La ejecución está en curso y tiene un punto de control guardado.                                                         | Detiene la ejecución en el punto de control. El estado pasa a `paused`.     |
| **Cancelar**  | La ejecución está en `pending`, `validating` o `running`.                                                                | Detiene la ejecución. No puedes deshacer una cancelación.                   |
| **Reanudar**  | La ejecución está en `failed`, `cancelled`, `paused`, o `stopped` por el presupuesto, y tiene un punto de control guardado. | Continúa la misma ejecución desde su último punto de control. La ejecución conserva su id. |
| **Clonar**    | En cualquier momento en que puedas ver la ejecución.                                                                     | Abre el asistente de envío con una copia de la configuración.               |
| **Eliminar**  | La ejecución está en un estado terminal. Solo el propietario.                                                            | Elimina de forma permanente la ejecución y todos sus datos.                 |

La API tiene además dos acciones para una ejecución en `failed` o `cancelled`:

- **Reintentar** inicia una ejecución nueva con la misma configuración. La ejecución nueva recibe un id nuevo.
- **Reiniciar** vuelve a iniciar la misma ejecución desde el principio. La ejecución conserva su id.

> [!NOTE]
> Reintentar, reiniciar y la clonación por API rechazan una ejecución que tiene su propio límite de gasto. Abre la configuración en el asistente de envío y fija un presupuesto nuevo antes de iniciar una ejecución nueva. El botón **Clonar** de la página de la ejecución lo hace por ti.

La clonación por API puede crear de 1 a 5 copias en una sola solicitud. Cada copia cuenta para tus límites de ejecuciones. Consulta [Límites](/docs/limits).

### Quién puede realizar una acción

Tu rol en la ejecución determina las acciones que ves:

- Un **propietario** puede realizar todas las acciones, gestionar el uso compartido y eliminar la ejecución.
- Un **editor** puede pausar, cancelar, reanudar y reintentar la ejecución, y subir su límite de gasto.
- Un **lector** puede abrir la ejecución y clonarla.

Lee [Compartir y publicar](/docs/guides/sharing) para saber más sobre los roles.

## Cómo se detiene una ejecución

Una ejecución se detiene por uno de cuatro motivos.

### Finalización

El optimizador termina su trabajo. El estado pasa a `success`. Skynet guarda la mejor versión y ejecuta la prueba final. Lee [Leer los resultados](/docs/guides/results).

### Presupuesto

Una ejecución no tiene una estimación de coste antes de empezar. Su límite de gasto es el presupuesto que puede usar. Skynet mide el coste real de cada ejecución del evaluador a medida que avanza la ejecución:

1. Skynet espera a que haya 10 ejecuciones del evaluador liquidadas. Antes de eso, el coste de una llamada es demasiado variable para usarlo.
2. Skynet usa el coste medio hasta el momento para estimar el precio de la siguiente iteración. Multiplica el precio por 1,5, porque las iteraciones posteriores suelen costar más.
3. Cuando el presupuesto restante no alcanza para pagar la siguiente iteración, Skynet deja de admitir trabajo nuevo. El optimizador se detiene en su siguiente llamada de pago.

La ejecución pasa entonces al estado `stopped` con el motivo de detención `budget_reached`. La página de la ejecución muestra un aviso **Presupuesto alcanzado**. El aviso te indica qué versión guardó Skynet:

- Tu mejor versión evaluada.
- Tu versión inicial evaluada, si no se encontró ninguna versión mejor.
- Ninguna versión, si el presupuesto se agotó antes de que algún candidato terminara su evaluación. Tus entradas y registros siguen guardados.

Para continuar, usa **Subir el límite y continuar** en el aviso. Skynet reanuda la ejecución desde el último punto de control.

> [!TIP]
> Una ejecución con **Sin límite** usa el saldo de tu cuenta hasta que termina. Si el saldo se agota, la ejecución se detiene y conserva lo que tiene. El aviso indica entonces **Saldo de la cuenta agotado**. Añade fondos y luego reanuda la ejecución.

Algunas ejecuciones antiguas se pausaron con el motivo de detención `budget_projected`. Puedes reanudarlas de la misma forma.

### Fallo

Un error detiene la ejecución. El estado pasa a `failed`. La pestaña **Registros** muestra lo que ocurrió. Si la ejecución tiene un punto de control guardado, puedes reanudarla. También puedes reintentarla.

Si un worker se detiene mientras ejecuta tu trabajo, Skynet recupera el trabajo y lo vuelve a intentar. Tras 3 intentos, Skynet marca el trabajo como fallido. Reanudar después de un fallo o una cancelación también cuenta como intento. Reanudar después de una pausa o de una detención por presupuesto no cuenta.

### Cancelación

Cancelas la ejecución. El estado pasa a `cancelled`. No puedes deshacer una cancelación. Más adelante puedes reanudar la ejecución desde un punto de control guardado, o reintentarla.

## Páginas relacionadas

- [Presupuestos y facturación](/docs/concepts/billing)
- [Iniciar una ejecución con el asistente](/docs/guides/submit)
- [Límites](/docs/limits)
