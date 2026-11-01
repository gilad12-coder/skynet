L'outil d'annotation ajoute des étiquettes aux lignes d'un jeu de données. Vous pouvez étiqueter chaque ligne vous-même, ou laisser un modèle d'IA étiqueter les lignes pendant que vous vérifiez son travail. Le résultat est un jeu de données étiqueté que vous pouvez utiliser dans une exécution.

## Démarrer une session

Ouvrez l'outil d'annotation de l'une de ces manières :

- Ouvrez l'outil d'annotation depuis le tableau de bord.
- Dans **Jeux de données**, sélectionnez un jeu de données et cliquez sur **Étiqueter ce jeu de données**.
- Dans l'éditeur de jeu de données, cliquez sur **Étiqueter avec l'IA**.

### Choisir les données

La configuration demande les données à étiqueter :

- **Choisir dans votre bibliothèque** utilise un jeu de données que vous avez importé. Pour importer un nouveau fichier, passez d'abord par [Jeux de données](/docs/guides/datasets).
- **Générer un jeu de données synthétique** crée des lignes pour vous. Cette option nécessite l'assistant IA.

### Choisir le type de tâche

| Type de tâche                    | Ce que vous attribuez à chaque ligne                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Question oui / non**           | Une réponse oui ou non.                                                                              |
| **Choisir parmi des catégories** | Une ou plusieurs catégories d'une liste que vous définissez. Ajoutez au moins deux catégories.       |
| **Réponses rédigées**            | Une réponse en texte libre.                                                                          |

### Choisir un mode

La configuration demande « Comment voulez-vous étiqueter ? ». Il existe trois modes :

| Mode          | Ce qui se passe                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Manuel**    | Vous étiquetez chaque ligne vous-même. Aucune IA n'intervient.                                                       |
| **Copilote** (Co-pilot) | Après un court entretien, l'IA étiquette un premier lot. Vous conservez ou corrigez chaque étiquette lors de tours de vérification. |
| **Pilote automatique** (Autopilot) | Après un court entretien, l'IA étiquette toutes les lignes et signale celles dont elle n'est pas sûre.               |

La configuration marque un mode comme **Recommandé**.

La configuration propose aussi un choix de **Modèle d'étiquetage**. La valeur par défaut convient à la plupart des jeux de données.

> [!NOTE]
> Dans l'app Mac, l'étiquetage par IA nécessite votre propre clé de fournisseur. Choisissez un modèle sous **Votre propre clé**. Voir [App Mac](/docs/guides/mac-app).

## L'entretien sur le jeu de données

Les modes Copilote et Pilote automatique commencent par un **Entretien sur le jeu de données**. L'IA pose des questions sur vos données et vos étiquettes. Vous pouvez cliquer sur **Passer l'entretien**.

L'entretien construit un **Guide d'étiquetage**. Le guide contient les règles que suit l'IA. Utilisez **Ajouter une règle** pour ajouter votre propre règle.

À la fin, l'IA affiche **Voici le plan**. Vous lancez ensuite le travail :

- En mode Copilote, cliquez sur **Étiqueter les {rows} premières lignes pour ma vérification**.
- En mode Pilote automatique, cliquez sur **Étiqueter les {rows} lignes**.

## Tours de vérification en mode Copilote

En mode Copilote, l'IA étiquette d'abord un lot d'étalonnage. La taille du lot dépend du type de tâche :

| Type de tâche                | Premier lot                                                   |
| ---------------------------- | ------------------------------------------------------------- |
| Question oui / non           | 24 lignes                                                     |
| Choisir parmi des catégories | 6 lignes par catégorie, au moins 30 et au plus 60             |
| Réponses rédigées            | 30 lignes                                                     |

Si le jeu de données contient moins de lignes, l'IA les étiquette toutes.

### Vérifier chaque étiquette

Pour chaque ligne, le panneau latéral affiche l'étiquette de l'IA :

1. Lisez la ligne et l'étiquette.
2. Pour conserver l'étiquette, cliquez sur **Confirmer (Entrée)** ou appuyez sur Entrée.
3. Pour changer l'étiquette, corrigez-la. Le panneau affiche « Corrigée — l'IA en tirera parti ».
4. Quand vous avez terminé, cliquez sur **Terminer ce tour**.

Le panneau affiche l'objectif : « Une fois que nous sommes d'accord dans {gate} % des cas, j'étiquette le reste moi-même. »

### Le seuil d'accord

Après chaque tour, Skynet mesure à quelle fréquence vous étiez d'accord avec l'IA. Le seuil est de 92 % pour les tâches oui / non et par catégories. Il est de 85 % pour les réponses rédigées.

Le récapitulatif du tour affiche « Vous étiez d'accord avec l'IA à {agreement} % ». Vous choisissez ensuite :

- **Un tour de vérification supplémentaire** vous donne un autre lot à vérifier.
- **Étiqueter les {rows} lignes restantes** laisse l'IA étiqueter le reste.

## Pilote automatique et étiquetage automatique

Quand l'IA étiquette les lignes restantes, le travail s'exécute sur le serveur. Vous pouvez quitter la page sans risque et revenir plus tard.

- **Reprendre l'étiquetage** poursuit une tâche arrêtée.
- **Annuler — conserver ce qui est étiqueté** arrête la tâche et conserve les étiquettes existantes.

### Vérifier les lignes incertaines

L'IA attribue un niveau de confiance à chaque étiquette automatique. Skynet signale une ligne quand la confiance est inférieure à 0,75. Après la tâche, cliquez sur **Vérifier les {count} lignes dont l'IA n'était pas sûre** pour les contrôler.

> [!TIP]
> Vérifiez les lignes signalées avant d'utiliser les données dans une exécution. Des étiquettes erronées réduisent la qualité de l'optimisation.

## Mode manuel

En mode Manuel, vous étiquetez chaque ligne vous-même. Les raccourcis clavier ci-dessous vous aident à travailler vite.

### Raccourcis clavier

| Touche            | Action                                                      |
| ----------------- | ----------------------------------------------------------- |
| Ctrl+H ou Cmd+H   | Afficher les raccourcis.                                    |
| Y / N             | Répondre oui ou non sur une ligne oui / non.                |
| 1 à 9             | Sélectionner ou désélectionner cette catégorie sur une ligne à catégories. |
| U                 | Aller à la prochaine ligne non étiquetée.                   |
| Home (Début)      | Aller à la première ligne.                                  |
| E                 | Exporter au format CSV.                                     |

## Résultats

Les résultats indiquent l'origine de chaque étiquette :

| Compteur                                    | Signification                                         |
| ------------------------------------------- | ----------------------------------------------------- |
| **Étiqueté par vous**                       | Les étiquettes que vous avez écrites.                 |
| **Étiquettes IA que vous avez confirmées**  | Les étiquettes de l'IA que vous avez conservées lors de la vérification. |
| **Étiqueté automatiquement**                | Les étiquettes de l'IA sans vérification.             |
| **Coût**                                    | Le coût du travail de l'IA dans cette session.        |

La colonne **Source** affiche les mêmes valeurs pour chaque ligne : **Vous**, **IA confirmée** ou **IA**.

## Enregistrer et exporter

### Enregistrer dans la bibliothèque

Cliquez sur **Enregistrer dans la bibliothèque** ou **Déplacer vers Jeux de données** pour conserver les données étiquetées sous forme de jeu de données. Vous pouvez ensuite les utiliser dans une [exécution](/docs/guides/submit).

### Exporter un fichier

Cliquez sur **Exporter les étiquettes** et choisissez un format :

- CSV
- JSON
- Excel (`.xlsx`)
- Parquet
- Feather

Si certaines lignes n'ont pas d'étiquette, Skynet vous demande de confirmer l'export.

L'export ajoute une colonne d'étiquettes. Son nom dépend du type de tâche :

| Type de tâche                | Colonne               |
| ---------------------------- | --------------------- |
| Question oui / non           | `binary_label`        |
| Choisir parmi des catégories | `selected_categories` |
| Réponses rédigées            | `extracted_text`      |

Une colonne `label_source` enregistre l'origine de chaque étiquette.

## Sessions

Chaque tâche d'étiquetage est une session. Une session a l'un de ces statuts : **En cours**, **En vérification**, **Étiquetage automatique** ou **Terminé**. Cliquez sur **Démarrer une nouvelle session** pour recommencer avec de nouveaux paramètres.

Vous pouvez partager une session avec d'autres personnes depuis sa boîte de dialogue de partage. Pour les règles de partage, voir [Partage](/docs/guides/sharing).

## Étapes suivantes

- [Préparez un jeu de données](/docs/guides/datasets) avant d'étiqueter.
- [Lancez une exécution](/docs/guides/submit) avec les données étiquetées.
- Interrogez le [panneau de l'agent](/docs/guides/agent-panel) sur vos sessions d'étiquetage.
