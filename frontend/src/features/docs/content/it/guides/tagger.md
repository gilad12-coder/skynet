Il tagger aggiunge etichette alle righe di un dataset. Puoi etichettare ogni riga da solo, oppure lasciare che un modello IA etichetti le righe mentre tu ne controlli il lavoro. Il risultato è un dataset etichettato che puoi usare in un'esecuzione.

## Avviare una sessione

Apri il tagger in uno di questi modi:

- Apri il tagger dalla dashboard.
- In **Dataset**, seleziona un dataset e fai clic su **Etichetta questo dataset**.
- Nell'editor del dataset, fai clic su **Etichetta con l'IA**.

### Scegliere i dati

La configurazione ti chiede i dati da etichettare:

- **Scegli dalla tua libreria** usa un dataset che hai caricato. Per caricare un nuovo file, usa prima [Dataset](/docs/guides/datasets).
- **Genera un dataset sintetico** crea le righe per te. Questa opzione richiede l'assistente.

### Scegliere il tipo di attività

| Tipo di attività               | Che cosa fornisci per ogni riga                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| **Domanda sì / no**            | Una risposta sì o no.                                                                    |
| **Scegli tra le categorie**    | Una o più categorie da un elenco che definisci tu. Aggiungi almeno due categorie.        |
| **Risposte scritte**           | Una risposta in testo libero.                                                            |

### Scegliere una modalità

La configurazione chiede «Come vuoi etichettare?». Ci sono tre modalità:

| Modalità                 | Che cosa succede                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Manuale**              | Etichetti ogni riga da solo. L'IA non interviene.                                                                  |
| **Co-pilota** (Co-pilot) | Dopo una breve intervista, l'IA etichetta un primo lotto. Mantieni o correggi ogni etichetta in giri di revisione. |
| **Pilota automatico** (Autopilot) | Dopo una breve intervista, l'IA etichetta tutte le righe e segnala quelle su cui ha dei dubbi.                     |

La configurazione contrassegna una modalità come **Consigliato**.

La configurazione offre anche la scelta del **Modello di etichettatura**. Il valore predefinito va bene per la maggior parte dei dataset.

> [!NOTE]
> Nell'app per Mac, l'etichettatura con l'IA richiede la chiave del tuo provider. Scegli un modello in **La tua chiave**. Vedi [App per Mac](/docs/guides/mac-app).

## L'intervista sul dataset

Co-pilota e Pilota automatico iniziano con un'**Intervista sul dataset**. L'IA ti fa domande sui tuoi dati e sulle tue etichette. Puoi fare clic su **Salta l'intervista**.

L'intervista costruisce una **Guida all'etichettatura**. La guida contiene le regole che l'IA segue. Usa **Aggiungi una regola** per aggiungere una regola tua.

Alla fine, l'IA mostra **Ecco il piano**. Poi avvii il lavoro:

- In Co-pilota, fai clic su **Etichetta le prime {rows} righe per la mia revisione**.
- In Pilota automatico, fai clic su **Etichetta tutte le {rows} righe**.

## Giri di revisione in Co-pilota

In Co-pilota, l'IA etichetta prima un lotto di calibrazione. La dimensione del lotto dipende dal tipo di attività:

| Tipo di attività            | Primo lotto                                                  |
| --------------------------- | ------------------------------------------------------------ |
| Domanda sì / no             | 24 righe                                                     |
| Scegli tra le categorie     | 6 righe per ogni categoria, almeno 30 e al massimo 60        |
| Risposte scritte            | 30 righe                                                     |

Se il dataset ha meno righe, l'IA le etichetta tutte.

### Controllare ogni etichetta

Per ogni riga, il pannello laterale mostra l'etichetta dell'IA:

1. Leggi la riga e l'etichetta.
2. Per mantenere l'etichetta, fai clic su **Conferma (Invio)** o premi Invio.
3. Per cambiare l'etichetta, correggila. Il pannello mostra «Corretta — l'IA imparerà da questo».
4. Quando hai finito, fai clic su **Termina questo giro**.

Il pannello mostra l'obiettivo: «Quando saremo d'accordo nel {gate}% dei casi, etichetterò io il resto.»

### La soglia di accordo

Dopo ogni giro, Skynet misura quanto spesso sei stato d'accordo con l'IA. La soglia è il 92% per le attività sì / no e a categorie. È l'85% per le risposte scritte.

Il riepilogo del giro mostra «Hai concordato con l'IA sul {agreement}%». Poi scegli:

- **Un altro giro di revisione** ti dà un altro lotto da controllare.
- **Etichetta le {rows} righe rimanenti** lascia che l'IA etichetti il resto.

## Pilota automatico ed etichettatura automatica

Quando l'IA etichetta le righe rimanenti, il lavoro gira sul server. Puoi lasciare la pagina in sicurezza e tornare in seguito.

- **Riprendi l'etichettatura** continua un job interrotto.
- **Annulla — mantieni ciò che è etichettato** ferma il job e mantiene le etichette esistenti.

### Controllare le righe incerte

L'IA assegna un livello di confidenza a ogni etichetta automatica. Skynet segnala una riga quando la confidenza è inferiore a 0,75. Al termine del job, fai clic su **Rivedi {count} righe su cui l'IA aveva dei dubbi** per controllarle.

> [!TIP]
> Controlla le righe segnalate prima di usare i dati in un'esecuzione. Le etichette sbagliate abbassano la qualità dell'ottimizzazione.

## Modalità manuale

In modalità Manuale, etichetti ogni riga da solo. Le scorciatoie da tastiera qui sotto ti aiutano a lavorare in fretta.

### Scorciatoie da tastiera

| Tasto               | Azione                                                          |
| ------------------- | --------------------------------------------------------------- |
| Ctrl+H o Cmd+H      | Mostra le scorciatoie.                                          |
| Y / N               | Rispondi sì o no su una riga sì / no.                           |
| Da 1 a 9            | Seleziona o deseleziona quella categoria su una riga a categorie. |
| U                   | Vai alla successiva riga senza etichetta.                       |
| Home                | Vai alla prima riga.                                            |
| E                   | Esporta in CSV.                                                 |

## Risultati

I risultati mostrano da dove viene ogni etichetta:

| Conteggio                            | Significato                                            |
| ------------------------------------ | ------------------------------------------------------ |
| **Etichettate da te**                | Etichette che hai scritto tu.                          |
| **Etichette IA confermate da te**    | Etichette dell'IA che hai mantenuto nella revisione.   |
| **Etichettate automaticamente**      | Etichette dell'IA senza revisione.                     |
| **Costo**                            | Il costo del lavoro dell'IA in questa sessione.        |

La colonna **Origine** mostra gli stessi valori per ogni riga: **Tu**, **IA confermata** o **IA**.

## Salvare ed esportare

### Salvare nella libreria

Fai clic su **Salva nella libreria** o **Sposta in Dataset** per conservare i dati etichettati come dataset. Poi puoi usarlo in un'[esecuzione](/docs/guides/submit).

### Esportare un file

Fai clic su **Esporta i tag** e scegli un formato:

- CSV
- JSON
- Excel (`.xlsx`)
- Parquet
- Feather

Se alcune righe non hanno un'etichetta, Skynet ti chiede di confermare l'esportazione.

L'esportazione aggiunge una colonna di etichette. Il suo nome dipende dal tipo di attività:

| Tipo di attività            | Colonna               |
| --------------------------- | --------------------- |
| Domanda sì / no             | `binary_label`        |
| Scegli tra le categorie     | `selected_categories` |
| Risposte scritte            | `extracted_text`      |

Una colonna `label_source` registra da dove viene ogni etichetta.

## Sessioni

Ogni job di etichettatura è una sessione. Una sessione ha uno di questi stati: **In corso**, **In revisione**, **Etichettatura automatica** o **Completata**. Fai clic su **Avvia una nuova sessione** per ricominciare con nuove impostazioni.

Puoi condividere una sessione con altre persone dalla sua finestra di condivisione. Per le regole di condivisione, vedi [Condividere e pubblicare](/docs/guides/sharing).

## Passaggi successivi

- [Prepara un dataset](/docs/guides/datasets) prima di etichettare.
- [Avvia un'esecuzione](/docs/guides/submit) con i dati etichettati.
- Chiedi al [pannello dell'agente](/docs/guides/agent-panel) informazioni sulle tue sessioni di etichettatura.
