Puedes compartir una ejecución con otras personas y puedes mostrarla en la galería pública Explorar. Son dos ajustes distintos. El acceso del enlace y las invitaciones controlan quién puede abrir una ejecución. La visibilidad pública controla si la ejecución aparece en la búsqueda pública. Esta guía explica los dos.

## Valores predeterminados

| Ajuste                                          | Valor predeterminado para una ejecución nueva                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Visibilidad pública                             | **Pública**. La ejecución aparece en la búsqueda pública.                              |
| Acceso del enlace                               | **Restringido**. Solo el propietario y las personas invitadas pueden abrir la ejecución. |
| Rol para **Cualquier persona con el enlace**    | **Lector**                                                                             |

El asistente de envío muestra la visibilidad de una ejecución nueva en su última pantalla. La cambias después de que empiece la ejecución, en el cuadro de diálogo **Compartir y privacidad**.

> [!WARNING]
> Las ejecuciones nuevas son públicas por defecto. Si tu ejecución contiene datos que otros usuarios no deben ver, ponla en **Privada** en el cuadro de diálogo **Compartir y privacidad**.

## Abrir los ajustes para compartir

En la página de la ejecución, selecciona **Compartir y privacidad**. Solo el propietario de la ejecución ve este botón.

## Roles

Cada persona que puede abrir una ejecución tiene uno de estos tres roles:

| Rol             | Qué puede hacer la persona                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Lector**      | Abrir la ejecución y ver sus resultados y su propietario. Clonar la ejecución.                                                           |
| **Editor**      | El acceso de Lector, más ejecutar el modelo, chatear y cambiar el nombre. Un editor también puede cancelar, pausar, reanudar y reintentar la ejecución. |
| **Propietario** | Control total, incluida la gestión del uso compartido y la eliminación.                                                                  |

Una ejecución tiene exactamente un propietario. Todas las personas que abren una ejecución compartida deben iniciar sesión. No hay acceso anónimo a una ejecución compartida.

## Compartir un enlace

1. Abre **Compartir y privacidad**.
2. En **Acceso del enlace**, selecciona una de estas opciones:
   - **Restringido**: solo el propietario y las personas invitadas pueden abrir la ejecución.
   - **Cualquier persona con el enlace**: cualquier usuario con sesión iniciada que tenga el enlace puede abrir la ejecución.
3. Para **Cualquier persona con el enlace**, selecciona el rol que da el enlace: **Lector** o **Editor**. Un enlace nunca da el rol de **Propietario**.
4. Selecciona **Copiar enlace**.

El enlace tiene la forma `/share/<token>`. El token es la parte del enlace que es difícil de adivinar. Si se revoca el enlace o se elimina la ejecución, el enlace muestra **No se encontró el recurso compartido**.

> [!NOTE]
> Los secretos, como las claves de API y las URL base, nunca aparecen en una ejecución compartida.

## Invitar a personas

1. Abre **Compartir y privacidad**.
2. En **Invitar a personas**, introduce un nombre de usuario. La lista muestra hasta 10 usuarios que coinciden.
3. Selecciona un rol: **Lector** o **Editor**.
4. Selecciona **Invitar**.

**Personas con acceso** muestra a todas las personas que tienen un rol en la ejecución. Para cada persona, puedes:

- Cambiar el rol.
- Quitar el acceso.

Una persona conserva el acceso más alto que le dan las reglas. Por ejemplo, un editor invitado conserva el rol de **Editor** cuando el enlace da **Lector**.

### Transferir la propiedad

Puedes dar la ejecución a otro usuario:

1. Abre el menú de rol de una persona en **Personas con acceso**. También puedes usar el menú de rol de **Invitar a personas**.
2. Selecciona **Transferir la propiedad**.
3. Confirma la transferencia.

El nuevo propietario obtiene el control total. Tú pasas a ser editor y pierdes los privilegios de propietario.

## Visibilidad pública

La visibilidad pública controla si una ejecución aparece en la búsqueda pública de la galería Explorar. No cambia el acceso del enlace ni las invitaciones.

| Opción          | Significado                                                                    |
| --------------- | ------------------------------------------------------------------------------ |
| **Pública**     | Aparece en la búsqueda pública. Visible para todos los usuarios.               |
| **Privada**     | Oculta en la búsqueda pública. Visible solo para ti y las personas invitadas.  |

Solo el propietario puede cambiar la visibilidad pública. El cambio se aplica de inmediato.

## La galería Explorar

La página Explorar te permite buscar optimizaciones. Tiene tres pestañas:

| Pestaña                 | Qué muestra                                               |
| ----------------------- | --------------------------------------------------------- |
| **Míos**                | Tus optimizaciones, privadas y públicas                   |
| **Públicas**            | Optimizaciones públicas de otros usuarios                 |
| **Compartido conmigo**  | Optimizaciones que otros usuarios compartieron contigo    |

Usa la barra de búsqueda y **Filtros** para encontrar ejecuciones.

Solo puedes abrir una ejecución pública desde Explorar si terminó con el estado `success`. Cuando la abres:

- Obtienes el rol de **Lector**. Puedes leer la ejecución y clonarla.
- La página muestra el propietario de la ejecución.
- Skynet quita los secretos, como las claves de API y las URL base.
- No puedes ejecutar el modelo. El modelo gastaría la clave del propietario.

> [!TIP]
> Para dar más acceso a una persona en una ejecución pública, invita a esa persona como **Editor**.

## Páginas relacionadas

- [Ejecuciones](/docs/concepts/runs)
- [Leer los resultados](/docs/guides/results)
- [Seguridad](/docs/security)
