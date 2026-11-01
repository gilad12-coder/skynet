Der Tagger fügt den Zeilen eines Datensatzes Labels hinzu. Sie können jede Zeile selbst labeln oder ein KI-Modell Zeilen labeln lassen, während Sie seine Arbeit prüfen. Das Ergebnis ist ein gelabelter Datensatz, den Sie in einem Durchlauf verwenden können.

## Eine Sitzung starten

Öffnen Sie den Tagger auf eine dieser Arten:

- Öffnen Sie den Tagger über das Dashboard.
- Wählen Sie unter **Datensätze** einen Datensatz aus und klicken Sie auf **Diesen Datensatz taggen**.
- Klicken Sie im Datensatz-Editor auf **Mit KI taggen**.

### Die Daten wählen

Die Einrichtung fragt nach den Daten, die gelabelt werden sollen:

- **Aus deiner Bibliothek wählen** verwendet einen Datensatz, den Sie hochgeladen haben. Um eine neue Datei hochzuladen, verwenden Sie zuerst [Datensätze](/docs/guides/datasets).
- **Synthetischen Datensatz erzeugen** erstellt Zeilen für Sie. Diese Option benötigt den Assistenten.

### Den Aufgabentyp wählen

| Aufgabentyp                  | Was Sie jeder Zeile geben                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| **Ja / Nein-Frage**          | Eine Antwort mit Ja oder Nein.                                                                  |
| **Aus Kategorien wählen**    | Eine oder mehrere Kategorien aus einer Liste, die Sie festlegen. Fügen Sie mindestens zwei Kategorien hinzu. |
| **Schriftliche Antworten**   | Eine Antwort als freier Text.                                                                   |

### Einen Modus wählen

Die Einrichtung fragt „Wie möchtest du taggen?“. Es gibt drei Modi:

| Modus         | Was passiert                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Manuell**   | Sie labeln jede Zeile selbst. Es ist keine KI beteiligt.                                                                      |
| **Co-Pilot**  | Nach einem kurzen Interview taggt die KI einen ersten Stapel. In Prüfrunden behalten oder korrigieren Sie jedes Label.        |
| **Autopilot** | Nach einem kurzen Interview taggt die KI alle Zeilen und markiert die Zeilen, bei denen sie unsicher ist.                     |

Die Einrichtung kennzeichnet einen Modus als **Empfohlen**.

Die Einrichtung bietet außerdem die Auswahl **Tagging-Modell**. Der Standard eignet sich für die meisten Datensätze.

> [!NOTE]
> In der Mac-App benötigt das Taggen mit KI Ihren eigenen Anbieterschlüssel. Wählen Sie ein Modell unter **Dein eigener Schlüssel**. Siehe [Mac-App](/docs/guides/mac-app).

## Das Datensatz-Interview

Co-Pilot und Autopilot beginnen mit einem **Datensatz-Interview**. Die KI stellt Fragen zu Ihren Daten und Ihren Labels. Sie können auf **Interview überspringen** klicken.

Das Interview erstellt einen **Labeling-Leitfaden**. Der Leitfaden enthält die Regeln, denen die KI folgt. Mit **Regel hinzufügen** fügen Sie eine eigene Regel hinzu.

Am Ende zeigt die KI **Das ist der Plan**. Dann starten Sie die Arbeit:

- Klicken Sie in Co-Pilot auf **Die ersten {rows} Zeilen für meine Prüfung taggen**.
- Klicken Sie in Autopilot auf **Alle {rows} Zeilen taggen**.

## Prüfrunden in Co-Pilot

In Co-Pilot taggt die KI zuerst einen Kalibrierungsstapel. Die Größe des Stapels hängt vom Aufgabentyp ab:

| Aufgabentyp              | Erster Stapel                                              |
| ------------------------ | ---------------------------------------------------------- |
| Ja / Nein-Frage          | 24 Zeilen                                                  |
| Aus Kategorien wählen    | 6 Zeilen pro Kategorie, mindestens 30 und höchstens 60     |
| Schriftliche Antworten   | 30 Zeilen                                                  |

Hat der Datensatz weniger Zeilen, taggt die KI alle.

### Jedes Label prüfen

Für jede Zeile zeigt die Seitenleiste das Label der KI:

1. Lesen Sie die Zeile und das Label.
2. Um das Label zu behalten, klicken Sie auf **Bestätigen (Enter)** oder drücken Sie die Eingabetaste.
3. Um das Label zu ändern, korrigieren Sie es. Die Seitenleiste zeigt „Korrigiert – die KI lernt daraus“.
4. Wenn Sie fertig sind, klicken Sie auf **Diese Runde abschließen**.

Die Seitenleiste zeigt das Ziel: „Sobald wir uns zu {gate}% einig sind, tagge ich den Rest selbst.“

### Die Übereinstimmungsschwelle

Nach jeder Runde misst Skynet, wie oft Sie mit der KI übereingestimmt haben. Die Schwelle liegt bei 92 % für Ja/Nein- und Kategorieaufgaben. Bei schriftlichen Antworten liegt sie bei 85 %.

Die Zusammenfassung der Runde zeigt „Du warst bei {agreement}% dieses Stapels mit der KI einig“. Dann wählen Sie:

- **Noch eine Prüfrunde** gibt Ihnen einen weiteren Stapel zum Prüfen.
- **Die restlichen {rows} Zeilen taggen** lässt die KI den Rest taggen.

## Autopilot und automatisches Taggen

Wenn die KI die restlichen Zeilen taggt, läuft die Arbeit auf dem Server. Sie können die Seite gefahrlos verlassen und später zurückkehren.

- **Taggen fortsetzen** setzt einen gestoppten Job fort.
- **Abbrechen – bereits Getaggtes behalten** stoppt den Job und behält die vorhandenen Labels.

### Unsichere Zeilen prüfen

Die KI gibt jedem automatischen Label eine Konfidenz. Skynet markiert eine Zeile, wenn die Konfidenz unter 0,75 liegt. Klicken Sie nach dem Job auf **{count} Zeilen prüfen, bei denen sich die KI unsicher war**, um sie zu prüfen.

> [!TIP]
> Prüfen Sie die markierten Zeilen, bevor Sie die Daten in einem Durchlauf verwenden. Falsche Labels senken die Qualität der Optimierung.

## Manueller Modus

Im manuellen Modus labeln Sie jede Zeile selbst. Die folgenden Tastenkürzel helfen Ihnen, schnell zu arbeiten.

### Tastenkürzel

| Taste               | Aktion                                                          |
| ------------------- | --------------------------------------------------------------- |
| Strg+H oder Cmd+H   | Die Tastenkürzel anzeigen.                                      |
| Y / N               | In einer Ja/Nein-Zeile mit Ja oder Nein antworten.              |
| 1 bis 9             | In einer Kategoriezeile diese Kategorie auswählen oder abwählen. |
| U                   | Zur nächsten ungetaggten Zeile wechseln.                        |
| Pos1                | Zur ersten Zeile wechseln.                                      |
| E                   | Als CSV exportieren.                                            |

## Ergebnisse

Die Ergebnisse zeigen, woher jedes Label stammt:

| Anzahl                              | Bedeutung                                         |
| ----------------------------------- | ------------------------------------------------- |
| **Von Ihnen gelabelt**              | Labels, die Sie geschrieben haben.                |
| **Von Ihnen bestätigte KI-Labels**  | KI-Labels, die Sie in der Prüfung behalten haben. |
| **Automatisch gelabelt**            | KI-Labels ohne Prüfung.                           |
| **Kosten**                          | Die Kosten der KI-Arbeit in dieser Sitzung.       |

Die Spalte **Quelle** zeigt für jede Zeile dieselben Werte: **Du**, **KI bestätigt** oder **KI**.

## Speichern und exportieren

### In der Bibliothek speichern

Klicken Sie auf **In Bibliothek speichern** oder **Zu Datensätzen verschieben**, um die gelabelten Daten als Datensatz zu behalten. Dann können Sie sie in einem [Durchlauf](/docs/guides/submit) verwenden.

### Eine Datei exportieren

Klicken Sie auf **Tags exportieren** und wählen Sie ein Format:

- CSV
- JSON
- Excel (`.xlsx`)
- Parquet
- Feather

Haben einige Zeilen kein Label, bittet Skynet Sie, den Export zu bestätigen.

Der Export fügt eine Label-Spalte hinzu. Ihr Name hängt vom Aufgabentyp ab:

| Aufgabentyp              | Spalte                |
| ------------------------ | --------------------- |
| Ja / Nein-Frage          | `binary_label`        |
| Aus Kategorien wählen    | `selected_categories` |
| Schriftliche Antworten   | `extracted_text`      |

Eine Spalte `label_source` hält fest, woher jedes Label stammt.

## Sitzungen

Jeder Tagging-Job ist eine Sitzung. Eine Sitzung hat einen dieser Status: **In Bearbeitung**, **In Prüfung**, **Automatisches Taggen** oder **Fertig**. Klicken Sie auf **Neue Sitzung starten**, um mit neuen Einstellungen neu zu beginnen.

Sie können eine Sitzung über ihren Freigabedialog mit anderen Personen teilen. Die Regeln für das Teilen finden Sie unter [Teilen und veröffentlichen](/docs/guides/sharing).

## Nächste Schritte

- [Bereiten Sie einen Datensatz vor](/docs/guides/datasets), bevor Sie taggen.
- [Starten Sie einen Durchlauf](/docs/guides/submit) mit den gelabelten Daten.
- Fragen Sie den [Agentenbereich](/docs/guides/agent-panel) nach Ihren Tagging-Sitzungen.
