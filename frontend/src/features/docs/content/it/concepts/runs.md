Un'esecuzione è un'ottimizzazione. Ha uno stato, un limite di spesa e un insieme di versioni salvate. Questa pagina spiega gli stati di un'esecuzione, le azioni che puoi compiere su di essa e i motivi per cui un'esecuzione si ferma.

## Stati dell'esecuzione

Ogni esecuzione ha uno di questi stati:

| Stato        | Significato                                                                          |
| ------------ | ------------------------------------------------------------------------------------ |
| `pending`    | L'esecuzione è in coda.                                                              |
| `validating` | Skynet controlla la configurazione prima che inizi l'ottimizzazione.                 |
| `running`    | L'ottimizzatore propone nuove versioni e assegna loro un punteggio.                  |
| `success`    | L'esecuzione è terminata. La versione migliore è salvata.                            |
| `failed`     | Un errore ha arrestato l'esecuzione.                                                 |
| `cancelled`  | Una persona ha annullato l'esecuzione.                                               |
| `paused`     | L'esecuzione si è fermata a un checkpoint. Puoi riprenderla.                         |
| `stopped`    | L'esecuzione si è fermata al suo budget. Conserva la versione migliore che ha trovato. |

`success`, `failed`, `cancelled`, `stopped` e `paused` sono stati terminali. L'ottimizzatore non lavora su un'esecuzione in uno stato terminale. `paused` è l'unico stato terminale che esiste per essere ripreso.

## Azioni

La pagina dell'esecuzione mostra le azioni valide per lo stato attuale e per il tuo ruolo. L'API offre le stesse azioni.

| Azione              | Quando puoi usarla                                                                                                      | Che cosa fa                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Metti in pausa**  | L'esecuzione è in corso e ha un checkpoint salvato.                                                                     | Ferma l'esecuzione al checkpoint. Lo stato diventa `paused`.                      |
| **Annulla**         | L'esecuzione è `pending`, `validating` o `running`.                                                                     | Arresta l'esecuzione. Non puoi annullare un annullamento.                         |
| **Riprendi**        | L'esecuzione è `failed`, `cancelled`, `paused` o `stopped` al budget, e ha un checkpoint salvato.                        | Prosegue la stessa esecuzione dall'ultimo checkpoint. L'esecuzione mantiene il suo id. |
| **Clona**           | Sempre, purché tu possa vedere l'esecuzione.                                                                            | Apre la procedura guidata di invio con una copia della configurazione.            |
| **Elimina**         | L'esecuzione è in uno stato terminale. Solo il proprietario.                                                            | Elimina definitivamente l'esecuzione e tutti i suoi dati.                         |

L'API offre anche altre due azioni per un'esecuzione `failed` o `cancelled`:

- **Riprova** avvia una nuova esecuzione con la stessa configurazione. La nuova esecuzione riceve un nuovo id.
- **Riavvia** avvia di nuovo la stessa esecuzione dall'inizio. L'esecuzione mantiene il suo id.

> [!NOTE]
> Riprova, riavvio e clonazione tramite API rifiutano un'esecuzione che ha un proprio limite di spesa. Apri la configurazione nella procedura guidata di invio e imposta un nuovo budget prima di avviare una nuova esecuzione. Il pulsante **Clona** nella pagina dell'esecuzione lo fa al posto tuo.

La clonazione tramite API può creare da 1 a 5 copie in una richiesta. Ogni copia conta nei limiti delle tue esecuzioni. Vedi [Limiti](/docs/limits).

### Chi può compiere un'azione

Il tuo ruolo sull'esecuzione determina le azioni che vedi:

- Un **proprietario** può compiere tutte le azioni, gestire la condivisione ed eliminare l'esecuzione.
- Un **editor** può mettere in pausa, annullare, riprendere e riprovare l'esecuzione, e alzarne il limite di spesa.
- Un **visualizzatore** può aprire l'esecuzione e clonarla.

Leggi [Condividere e pubblicare](/docs/guides/sharing) per saperne di più sui ruoli.

## Come si ferma un'esecuzione

Un'esecuzione si ferma per uno di questi quattro motivi.

### Completamento

L'ottimizzatore termina il suo lavoro. Lo stato diventa `success`. Skynet salva la versione migliore ed esegue il test finale. Leggi [Leggere i risultati](/docs/guides/results).

### Budget

Un'esecuzione non ha una stima dei costi prima di partire. Il suo limite di spesa è il budget che può usare. Skynet misura il costo reale di ogni esecuzione dello scorer man mano che l'esecuzione procede:

1. Skynet attende 10 esecuzioni dello scorer regolate. Prima di allora, il costo di una singola chiamata è troppo variabile per essere utile.
2. Skynet usa il costo medio fino a quel momento per stimare il prezzo dell'iterazione successiva. Moltiplica il prezzo per 1,5, perché le iterazioni successive di solito costano di più.
3. Quando il budget rimanente non basta a pagare l'iterazione successiva, Skynet smette di accettare nuovo lavoro. L'ottimizzatore si ferma alla successiva chiamata a pagamento.

L'esecuzione ha quindi lo stato `stopped` e il motivo di arresto `budget_reached`. La pagina dell'esecuzione mostra l'avviso **Budget raggiunto**. L'avviso indica quale versione Skynet ha salvato:

- La tua migliore versione valutata.
- La tua versione iniziale valutata, se non è stata trovata una versione migliore.
- Nessuna versione, se il budget si è esaurito prima che un candidato completasse la valutazione. I tuoi input e i log restano salvati.

Per continuare, usa **Alza il limite e continua** nell'avviso. Skynet riprende l'esecuzione dall'ultimo checkpoint.

> [!TIP]
> Un'esecuzione con **Nessun limite** attinge al saldo del tuo account finché non termina. Se il saldo si esaurisce, l'esecuzione si ferma e conserva ciò che ha. L'avviso mostra allora **Saldo dell'account esaurito**. Aggiungi fondi, poi riprendi l'esecuzione.

Alcune esecuzioni meno recenti sono state messe in pausa con il motivo di arresto `budget_projected`. Puoi riprenderle nello stesso modo.

### Errore

Un errore arresta l'esecuzione. Lo stato diventa `failed`. La scheda **Log** mostra che cosa è successo. Se l'esecuzione ha un checkpoint salvato, puoi riprenderla. Puoi anche riprovarla.

Se un worker si ferma mentre esegue il tuo job, Skynet recupera il job e riprova. Dopo 3 tentativi, Skynet contrassegna il job come non riuscito. Anche una ripresa dopo un errore o un annullamento conta come tentativo. Una ripresa dopo una pausa o un arresto per budget non conta.

### Annullamento

Annulli l'esecuzione. Lo stato diventa `cancelled`. Non puoi annullare un annullamento. In seguito puoi riprendere l'esecuzione da un checkpoint salvato, oppure riprovarla.

## Pagine correlate

- [Budget e fatturazione](/docs/concepts/billing)
- [Avviare un'esecuzione con la procedura guidata](/docs/guides/submit)
- [Limiti](/docs/limits)
