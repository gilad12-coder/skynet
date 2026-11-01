Sie können einen Durchlauf mit anderen Personen teilen und ihn in der öffentlichen Galerie „Erkunden“ listen. Das sind zwei verschiedene Einstellungen. Link-Zugriff und Einladungen steuern, wer einen Durchlauf öffnen kann. Die öffentliche Sichtbarkeit steuert, ob der Durchlauf in der öffentlichen Suche erscheint. Diese Anleitung erklärt beides.

## Standardwerte

| Einstellung                           | Standard für einen neuen Durchlauf                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Öffentliche Sichtbarkeit              | **Öffentlich**. Der Durchlauf erscheint in der öffentlichen Suche.                     |
| Link-Zugriff                          | **Eingeschränkt**. Nur der Eigentümer und eingeladene Personen können den Durchlauf öffnen. |
| Rolle für **Jeder mit dem Link**      | **Betrachter**                                                                         |

Der Einreichungsassistent zeigt die Sichtbarkeit eines neuen Durchlaufs auf seinem letzten Bildschirm. Nach dem Start des Durchlaufs ändern Sie sie im Dialog **Teilen und Datenschutz**.

> [!WARNING]
> Neue Durchläufe sind standardmäßig öffentlich. Enthält Ihr Durchlauf Daten, die andere Nutzer nicht sehen dürfen, setzen Sie ihn im Dialog **Teilen und Datenschutz** auf **Privat**.

## Die Freigabeeinstellungen öffnen

Wählen Sie auf der Seite des Durchlaufs **Teilen und Datenschutz**. Nur der Eigentümer des Durchlaufs sieht diese Schaltfläche.

## Rollen

Jede Person, die einen Durchlauf öffnen kann, hat eine von drei Rollen:

| Rolle          | Was die Person tun kann                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Betrachter** | Den Durchlauf öffnen und seine Ergebnisse und seinen Eigentümer sehen. Den Durchlauf klonen.                                                  |
| **Bearbeiter** | Betrachterzugriff plus Ausführen des Modells, Chat und Umbenennen. Ein Bearbeiter kann den Durchlauf auch abbrechen, pausieren, fortsetzen und erneut versuchen. |
| **Eigentümer** | Volle Kontrolle, einschließlich Verwaltung der Freigabe und Löschen.                                                                          |

Ein Durchlauf hat genau einen Eigentümer. Alle Personen, die einen geteilten Durchlauf öffnen, müssen sich anmelden. Es gibt keinen anonymen Zugriff auf einen geteilten Durchlauf.

## Einen Link teilen

1. Öffnen Sie **Teilen und Datenschutz**.
2. Wählen Sie unter **Link-Zugriff** eine dieser Optionen:
   - **Eingeschränkt**: Nur der Eigentümer und eingeladene Personen können den Durchlauf öffnen.
   - **Jeder mit dem Link**: Jeder angemeldete Nutzer, der den Link hat, kann den Durchlauf öffnen.
3. Wählen Sie für **Jeder mit dem Link** die Rolle, die der Link vergibt: **Betrachter** oder **Bearbeiter**. Ein Link vergibt nie die Rolle **Eigentümer**.
4. Wählen Sie **Link kopieren**.

Der Link hat die Form `/share/<token>`. Das Token ist der Teil des Links, der schwer zu erraten ist. Wird der Link widerrufen oder der Durchlauf gelöscht, zeigt der Link **Freigabe nicht gefunden**.

> [!NOTE]
> Geheimnisse wie API-Schlüssel und Basis-URLs erscheinen nie in einem geteilten Durchlauf.

## Personen einladen

1. Öffnen Sie **Teilen und Datenschutz**.
2. Geben Sie unter **Personen einladen** einen Benutzernamen ein. Die Liste zeigt bis zu 10 passende Nutzer.
3. Wählen Sie eine Rolle: **Betrachter** oder **Bearbeiter**.
4. Wählen Sie **Einladen**.

**Personen mit Zugriff** listet alle auf, die eine Rolle im Durchlauf haben. Für jede Person können Sie:

- die Rolle ändern.
- den Zugriff entfernen.

Eine Person behält den höchsten Zugriff, den die Regeln ihr geben. Ein eingeladener Bearbeiter behält zum Beispiel die Rolle **Bearbeiter**, wenn der Link **Betrachter** vergibt.

### Eigentum übertragen

Sie können den Durchlauf an einen anderen Nutzer übergeben:

1. Öffnen Sie das Rollenmenü einer Person unter **Personen mit Zugriff**. Sie können auch das Rollenmenü unter **Personen einladen** verwenden.
2. Wählen Sie **Eigentum übertragen**.
3. Bestätigen Sie die Übertragung.

Der neue Eigentümer erhält die volle Kontrolle. Sie werden zum Bearbeiter und verlieren die Rechte des Eigentümers.

## Öffentliche Sichtbarkeit

Die öffentliche Sichtbarkeit steuert, ob ein Durchlauf in der öffentlichen Suche der Galerie „Erkunden“ erscheint. Sie ändert weder den Link-Zugriff noch die Einladungen.

| Option         | Bedeutung                                                                          |
| -------------- | ---------------------------------------------------------------------------------- |
| **Öffentlich** | In der öffentlichen Suche gelistet. Für alle Nutzer sichtbar.                      |
| **Privat**     | Aus der öffentlichen Suche ausgeblendet. Nur für Sie und eingeladene Personen sichtbar. |

Nur der Eigentümer kann die öffentliche Sichtbarkeit ändern. Die Änderung wirkt sofort.

## Die Galerie „Erkunden“

Auf der Seite „Erkunden“ können Sie Optimierungen durchsuchen. Sie hat drei Tabs:

| Tab                  | Was er zeigt                                         |
| -------------------- | ---------------------------------------------------- |
| **Meine**            | Ihre Optimierungen, private und öffentliche          |
| **Öffentlich**       | Öffentliche Optimierungen anderer Nutzer             |
| **Mit mir geteilt**  | Optimierungen, die andere Nutzer mit Ihnen geteilt haben |

Mit der Suchleiste und **Filter** finden Sie Durchläufe.

Einen öffentlichen Durchlauf können Sie aus „Erkunden“ nur öffnen, wenn er mit dem Status `success` abgeschlossen ist. Wenn Sie ihn öffnen:

- Sie erhalten die Rolle **Betrachter**. Sie können den Durchlauf lesen und klonen.
- Die Seite zeigt den Eigentümer des Durchlaufs.
- Skynet entfernt Geheimnisse wie API-Schlüssel und Basis-URLs.
- Sie können das Modell nicht ausführen. Das Modell würde den Schlüssel des Eigentümers belasten.

> [!TIP]
> Um einer Person mehr Zugriff auf einen öffentlichen Durchlauf zu geben, laden Sie sie als **Bearbeiter** ein.

## Verwandte Seiten

- [Durchläufe](/docs/concepts/runs)
- [Ergebnisse lesen](/docs/guides/results)
- [Sicherheit](/docs/security)
