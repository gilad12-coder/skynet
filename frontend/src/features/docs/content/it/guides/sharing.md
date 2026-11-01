Puoi condividere un'esecuzione con altre persone e puoi elencarla nella galleria pubblica Esplora. Sono due impostazioni diverse. L'accesso tramite link e gli inviti controllano chi può aprire un'esecuzione. La visibilità pubblica controlla se l'esecuzione compare nella ricerca pubblica. Questa guida spiega entrambe.

## Valori predefiniti

| Impostazione                                  | Valore predefinito per una nuova esecuzione                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| Visibilità pubblica                           | **Pubblica**. L'esecuzione compare nella ricerca pubblica.                   |
| Accesso al link                               | **Limitato**. Solo il proprietario e le persone invitate possono aprirla.    |
| Ruolo per **Chiunque abbia il link**          | **Visualizzatore**                                                           |

La procedura guidata di invio mostra la visibilità di una nuova esecuzione nella sua ultima schermata. La modifichi dopo l'avvio dell'esecuzione, nella finestra **Condivisione e privacy**.

> [!WARNING]
> Le nuove esecuzioni sono pubbliche per impostazione predefinita. Se la tua esecuzione contiene dati che altri utenti non devono vedere, impostala su **Privata** nella finestra **Condivisione e privacy**.

## Aprire le impostazioni di condivisione

Nella pagina dell'esecuzione, seleziona **Condivisione e privacy**. Solo il proprietario dell'esecuzione vede questo pulsante.

## Ruoli

Ogni persona che può aprire un'esecuzione ha uno di tre ruoli:

| Ruolo                | Che cosa può fare la persona                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Visualizzatore**   | Aprire l'esecuzione e vederne i risultati e il proprietario. Clonare l'esecuzione.                                                   |
| **Editor**           | Accesso da visualizzatore più esecuzione del modello, chat e rinomina. Un editor può anche annullare, mettere in pausa, riprendere e riprovare l'esecuzione. |
| **Proprietario**     | Controllo completo, inclusa la gestione della condivisione e l'eliminazione.                                                         |

Un'esecuzione ha esattamente un proprietario. Tutte le persone che aprono un'esecuzione condivisa devono effettuare l'accesso. Non esiste un accesso anonimo a un'esecuzione condivisa.

## Condividere un link

1. Apri **Condivisione e privacy**.
2. In **Accesso al link**, seleziona una di queste opzioni:
   - **Limitato**: solo il proprietario e le persone invitate possono aprire l'esecuzione.
   - **Chiunque abbia il link**: qualsiasi utente che ha effettuato l'accesso e ha il link può aprire l'esecuzione.
3. Per **Chiunque abbia il link**, seleziona il ruolo che il link concede: **Visualizzatore** o **Editor**. Un link non concede mai il ruolo **Proprietario**.
4. Seleziona **Copia il link**.

Il link ha la forma `/share/<token>`. Il token è la parte del link difficile da indovinare. Se il link viene revocato, o l'esecuzione viene eliminata, il link mostra **Condivisione non trovata**.

> [!NOTE]
> I segreti, come le chiavi API e gli URL di base, non compaiono mai in un'esecuzione condivisa.

## Invitare persone

1. Apri **Condivisione e privacy**.
2. In **Invita persone**, inserisci un nome utente. L'elenco mostra fino a 10 utenti corrispondenti.
3. Seleziona un ruolo: **Visualizzatore** o **Editor**.
4. Seleziona **Invita**.

**Persone con accesso** elenca tutte le persone che hanno un ruolo sull'esecuzione. Per ogni persona puoi:

- Cambiare il ruolo.
- Rimuovere l'accesso.

Una persona mantiene l'accesso più alto che le regole le concedono. Ad esempio, un editor invitato mantiene il ruolo **Editor** quando il link concede **Visualizzatore**.

### Trasferire la proprietà

Puoi cedere l'esecuzione a un altro utente:

1. Apri il menu del ruolo di una persona in **Persone con accesso**. Puoi anche usare il menu del ruolo in **Invita persone**.
2. Seleziona **Trasferisci la proprietà**.
3. Conferma il trasferimento.

Il nuovo proprietario ottiene il controllo completo. Tu diventi editor e perdi i privilegi di proprietario.

## Visibilità pubblica

La visibilità pubblica controlla se un'esecuzione compare nella ricerca pubblica della galleria Esplora. Non modifica l'accesso tramite link né gli inviti.

| Opzione         | Significato                                                                    |
| --------------- | ------------------------------------------------------------------------------ |
| **Pubblica**    | Elencata nella ricerca pubblica. Visibile a tutti gli utenti.                  |
| **Privata**     | Nascosta dalla ricerca pubblica. Visibile solo a te e alle persone invitate.   |

Solo il proprietario può cambiare la visibilità pubblica. La modifica ha effetto immediato.

## La galleria Esplora

La pagina **Esplora** ti permette di cercare ottimizzazioni. Ha tre schede:

| Scheda                 | Che cosa mostra                                         |
| ---------------------- | ------------------------------------------------------- |
| **Miei**               | Le tue ottimizzazioni, private e pubbliche              |
| **Pubbliche**          | Le ottimizzazioni pubbliche di altri utenti             |
| **Condivise con me**   | Le ottimizzazioni che altri utenti hanno condiviso con te |

Usa la barra di ricerca e i **Filtri** per trovare le esecuzioni.

Puoi aprire un'esecuzione pubblica da Esplora solo se è terminata con lo stato `success`. Quando la apri:

- Ricevi il ruolo **Visualizzatore**. Puoi leggere l'esecuzione e clonarla.
- La pagina mostra il proprietario dell'esecuzione.
- Skynet rimuove i segreti, come le chiavi API e gli URL di base.
- Non puoi eseguire il modello. Il modello spenderebbe la chiave del proprietario.

> [!TIP]
> Per dare a una persona più accesso a un'esecuzione pubblica, invitala come **Editor**.

## Pagine correlate

- [Esecuzioni](/docs/concepts/runs)
- [Leggere i risultati](/docs/guides/results)
- [Sicurezza](/docs/security)
