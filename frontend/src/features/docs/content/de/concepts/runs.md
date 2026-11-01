Ein Durchlauf ist eine Optimierung. Er hat einen Status, ein Ausgabenlimit und eine Reihe gespeicherter Versionen. Diese Seite erklärt die Status eines Durchlaufs, die Aktionen, die Sie darauf ausführen können, und die Gründe, aus denen ein Durchlauf stoppt.

## Status eines Durchlaufs

Jeder Durchlauf hat einen dieser Status:

| Status       | Bedeutung                                                                          |
| ------------ | ---------------------------------------------------------------------------------- |
| `pending`    | Der Durchlauf steht in der Warteschlange.                                          |
| `validating` | Skynet prüft die Einrichtung, bevor die Optimierung beginnt.                       |
| `running`    | Der Optimierer schlägt neue Versionen vor und bewertet sie.                        |
| `success`    | Der Durchlauf ist abgeschlossen. Die beste Version ist gespeichert.                |
| `failed`     | Ein Fehler hat den Durchlauf gestoppt.                                             |
| `cancelled`  | Eine Person hat den Durchlauf abgebrochen.                                         |
| `paused`     | Der Durchlauf hat an einem Checkpoint angehalten. Sie können ihn fortsetzen.       |
| `stopped`    | Der Durchlauf hat an seinem Budget gestoppt. Er behält die beste gefundene Version. |

`success`, `failed`, `cancelled`, `stopped` und `paused` sind Endzustände. Der Optimierer arbeitet nicht an einem Durchlauf in einem Endzustand. `paused` ist der einzige Endzustand, der dafür da ist, fortgesetzt zu werden.

## Aktionen

Die Seite des Durchlaufs zeigt die Aktionen, die für den aktuellen Status und Ihre Rolle gelten. Die API hat dieselben Aktionen.

| Aktion          | Wann Sie sie nutzen können                                                                                                        | Was sie tut                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Pausieren**   | Der Durchlauf läuft und hat einen gespeicherten Checkpoint.                                                                       | Hält den Durchlauf am Checkpoint an. Der Status wechselt zu `paused`.          |
| **Abbrechen**   | Der Durchlauf ist `pending`, `validating` oder `running`.                                                                         | Stoppt den Durchlauf. Einen Abbruch können Sie nicht rückgängig machen.        |
| **Fortsetzen**  | Der Durchlauf ist `failed`, `cancelled`, `paused` oder an seinem Budget `stopped` und hat einen gespeicherten Checkpoint.          | Setzt denselben Durchlauf ab seinem letzten Checkpoint fort. Der Durchlauf behält seine ID. |
| **Klonen**      | Jederzeit, wenn Sie den Durchlauf sehen können.                                                                                   | Öffnet den Einreichungsassistenten mit einer Kopie der Konfiguration.          |
| **Löschen**     | Der Durchlauf ist in einem Endzustand. Nur für Eigentümer.                                                                        | Löscht den Durchlauf und alle seine Daten dauerhaft.                           |

Die API hat zwei weitere Aktionen für einen Durchlauf, der `failed` oder `cancelled` ist:

- **Erneut versuchen** startet einen neuen Durchlauf mit derselben Konfiguration. Der neue Durchlauf erhält eine neue ID.
- **Neu starten** startet denselben Durchlauf noch einmal von vorn. Der Durchlauf behält seine ID.

> [!NOTE]
> Erneut versuchen, Neu starten und Klonen über die API lehnen einen Durchlauf ab, der ein eigenes Ausgabenlimit hat. Öffnen Sie die Konfiguration im Einreichungsassistenten und legen Sie ein neues Budget fest, bevor Sie einen neuen Durchlauf starten. Die Schaltfläche **Klonen** auf der Seite des Durchlaufs erledigt das für Sie.

Das Klonen über die API kann in einer Anfrage 1 bis 5 Kopien erstellen. Jede Kopie zählt gegen Ihre Limits für Durchläufe. Siehe [Limits](/docs/limits).

### Wer eine Aktion ausführen kann

Ihre Rolle im Durchlauf bestimmt, welche Aktionen Sie sehen:

- Ein **Eigentümer** kann alle Aktionen ausführen, die Freigabe verwalten und den Durchlauf löschen.
- Ein **Bearbeiter** kann den Durchlauf pausieren, abbrechen, fortsetzen und erneut versuchen sowie sein Ausgabenlimit erhöhen.
- Ein **Betrachter** kann den Durchlauf öffnen und klonen.

Mehr über Rollen erfahren Sie unter [Teilen und veröffentlichen](/docs/guides/sharing).

## Wie ein Durchlauf stoppt

Ein Durchlauf stoppt aus einem von vier Gründen.

### Abschluss

Der Optimierer beendet seine Arbeit. Der Status wechselt zu `success`. Skynet speichert die beste Version und führt den abschließenden Test aus. Lesen Sie [Ergebnisse lesen](/docs/guides/results).

### Budget

Ein Durchlauf hat vor dem Start keine Kostenschätzung. Sein Ausgabenlimit ist das Budget, das er verbrauchen darf. Skynet misst die tatsächlichen Kosten jedes Bewertungslaufs während des Durchlaufs:

1. Skynet wartet auf 10 abgerechnete Bewertungsläufe. Davor schwanken die Kosten eines einzelnen Aufrufs zu stark.
2. Skynet verwendet die bisherigen Durchschnittskosten, um die nächste Iteration zu bepreisen. Es multipliziert den Preis mit 1,5, weil spätere Iterationen meist mehr kosten.
3. Wenn das verbleibende Budget die nächste Iteration nicht bezahlen kann, nimmt Skynet keine neue Arbeit mehr an. Der Optimierer stoppt bei seinem nächsten kostenpflichtigen Aufruf.

Der Durchlauf hat dann den Status `stopped` und den Stoppgrund `budget_reached`. Die Seite des Durchlaufs zeigt einen Hinweis **Budget erreicht**. Der Hinweis sagt Ihnen, welche Version Skynet gespeichert hat:

- Ihre beste bewertete Version.
- Ihre bewertete Ausgangsversion, wenn keine bessere Version gefunden wurde.
- Keine Version, wenn das Budget aufgebraucht war, bevor ein Kandidat die Bewertung abgeschlossen hat. Ihre Eingaben und Logs bleiben gespeichert.

Um weiterzumachen, verwenden Sie **Limit erhöhen und fortfahren** im Hinweis. Skynet setzt den Durchlauf ab dem letzten Checkpoint fort.

> [!TIP]
> Ein Durchlauf mit **Kein Limit** greift auf Ihr Kontoguthaben zu, bis er abgeschlossen ist. Ist das Guthaben aufgebraucht, stoppt der Durchlauf und behält, was er hat. Der Hinweis lautet dann **Kontoguthaben aufgebraucht**. Laden Sie Guthaben auf und setzen Sie den Durchlauf dann fort.

Einige ältere Durchläufe wurden mit dem Stoppgrund `budget_projected` pausiert. Sie können sie auf dieselbe Weise fortsetzen.

### Fehler

Ein Fehler stoppt den Durchlauf. Der Status wechselt zu `failed`. Der Tab **Logs** zeigt, was passiert ist. Hat der Durchlauf einen gespeicherten Checkpoint, können Sie ihn fortsetzen. Sie können ihn auch erneut versuchen.

Stoppt ein Worker, während er Ihren Job ausführt, stellt Skynet den Job wieder her und versucht es erneut. Nach 3 Versuchen markiert Skynet den Job als fehlgeschlagen. Ein Fortsetzen nach einem Fehler oder einem Abbruch zählt ebenfalls als Versuch. Ein Fortsetzen nach einer Pause oder einem Budgetstopp zählt nicht.

### Abbruch

Sie brechen den Durchlauf ab. Der Status wechselt zu `cancelled`. Einen Abbruch können Sie nicht rückgängig machen. Später können Sie den Durchlauf ab einem gespeicherten Checkpoint fortsetzen oder ihn erneut versuchen.

## Verwandte Seiten

- [Budgets und Abrechnung](/docs/concepts/billing)
- [Einen Durchlauf mit dem Assistenten starten](/docs/guides/submit)
- [Limits](/docs/limits)
