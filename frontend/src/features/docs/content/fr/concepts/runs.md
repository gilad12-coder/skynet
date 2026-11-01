Une exécution correspond à une optimisation. Elle a un statut, un plafond de dépenses et un ensemble de versions enregistrées. Cette page explique les états d'une exécution, les actions possibles sur une exécution et les raisons pour lesquelles elle s'arrête.

## États d'une exécution

Chaque exécution a l'un des statuts suivants :

| Statut       | Signification                                                                 |
| ------------ | ----------------------------------------------------------------------------- |
| `pending`    | L'exécution est dans la file d'attente.                                       |
| `validating` | Skynet vérifie la configuration avant le début de l'optimisation.             |
| `running`    | L'optimiseur propose et note de nouvelles versions.                           |
| `success`    | L'exécution est terminée. La meilleure version est enregistrée.               |
| `failed`     | Une erreur a arrêté l'exécution.                                              |
| `cancelled`  | Quelqu'un a annulé l'exécution.                                               |
| `paused`     | L'exécution s'est arrêtée à un point de contrôle. Vous pouvez la reprendre.   |
| `stopped`    | L'exécution s'est arrêtée à son budget. Elle conserve la meilleure version trouvée. |

`success`, `failed`, `cancelled`, `stopped` et `paused` sont des états terminaux. L'optimiseur ne travaille pas sur une exécution dans un état terminal. `paused` est le seul état terminal destiné à être repris.

## Actions

La page de l'exécution affiche les actions qui s'appliquent au statut actuel et à votre rôle. L'API propose les mêmes actions.

| Action                 | Quand l'utiliser                                                                                                     | Effet                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Mettre en pause**    | L'exécution est en cours et a un point de contrôle enregistré.                                                       | Arrête l'exécution au point de contrôle. Le statut passe à `paused`.           |
| **Annuler**            | L'exécution est `pending`, `validating` ou `running`.                                                                | Arrête l'exécution. Une annulation est irréversible.                           |
| **Reprendre**          | L'exécution est `failed`, `cancelled`, `paused`, ou `stopped` à son budget, et elle a un point de contrôle enregistré. | Poursuit la même exécution à partir de son dernier point de contrôle. L'exécution conserve son identifiant. |
| **Cloner**             | À tout moment, dès que vous pouvez voir l'exécution.                                                                 | Ouvre l'assistant de soumission avec une copie de la configuration.            |
| **Supprimer**          | L'exécution est dans un état terminal. Réservé au propriétaire.                                                      | Supprime définitivement l'exécution et toutes ses données.                     |

L'API propose aussi deux actions supplémentaires pour une exécution `failed` ou `cancelled` :

- **Réessayer** lance une nouvelle exécution avec la même configuration. La nouvelle exécution reçoit un nouvel identifiant.
- **Relancer** redémarre la même exécution depuis le début. L'exécution conserve son identifiant.

> [!NOTE]
> Réessayer, relancer et le clonage par l'API refusent une exécution qui a son propre plafond de dépenses. Ouvrez la configuration dans l'assistant de soumission et définissez un nouveau budget avant de lancer une nouvelle exécution. Le bouton **Cloner** de la page d'exécution le fait pour vous.

Le clonage par l'API peut créer de 1 à 5 copies en une requête. Chaque copie compte dans vos limites d'exécutions. Voir [Limites](/docs/limits).

### Qui peut effectuer une action

Votre rôle sur l'exécution détermine les actions que vous voyez :

- Un **propriétaire** peut effectuer toutes les actions, gérer le partage et supprimer l'exécution.
- Un **éditeur** peut mettre en pause, annuler, reprendre et réessayer l'exécution, et relever son plafond de dépenses.
- Un **lecteur** peut ouvrir l'exécution et la cloner.

Lisez [Partager et publier](/docs/guides/sharing) pour en savoir plus sur les rôles.

## Comment une exécution s'arrête

Une exécution s'arrête pour l'une de quatre raisons.

### Achèvement

L'optimiseur termine son travail. Le statut passe à `success`. Skynet enregistre la meilleure version et exécute le test final. Lisez [Lire les résultats](/docs/guides/results).

### Budget

Une exécution n'a pas d'estimation de coût avant de démarrer. Son plafond de dépenses est le budget dont elle dispose. Skynet mesure le coût réel de chaque exécution de l'évaluateur au fil de l'exécution :

1. Skynet attend 10 exécutions de l'évaluateur réglées. Avant cela, le coût d'un appel est trop variable pour être utilisé.
2. Skynet utilise le coût moyen observé pour estimer le prix de l'itération suivante. Il multiplie ce prix par 1,5, car les itérations ultérieures coûtent généralement plus cher.
3. Quand le budget restant ne peut plus payer l'itération suivante, Skynet n'admet plus de nouveau travail. L'optimiseur s'arrête à son prochain appel payant.

L'exécution a alors le statut `stopped` et le motif d'arrêt `budget_reached`. La page de l'exécution affiche un avis **Budget atteint**. L'avis indique quelle version Skynet a enregistrée :

- Votre meilleure version évaluée.
- Votre version de départ évaluée, si aucune meilleure version n'a été trouvée.
- Aucune version, si le budget s'est épuisé avant qu'un candidat ait terminé son évaluation. Vos entrées et vos journaux restent enregistrés.

Pour continuer, utilisez **Relever le plafond et continuer** dans l'avis. Skynet reprend l'exécution à partir du dernier point de contrôle.

> [!TIP]
> Une exécution **Sans plafond** puise dans le solde de votre compte jusqu'à ce qu'elle se termine. Si le solde s'épuise, l'exécution s'arrête et conserve ce qu'elle a produit. L'avis indique alors **Solde du compte épuisé**. Ajoutez des fonds, puis reprenez l'exécution.

Certaines exécutions plus anciennes se sont mises en pause avec le motif d'arrêt `budget_projected`. Vous pouvez les reprendre de la même manière.

### Échec

Une erreur arrête l'exécution. Le statut passe à `failed`. L'onglet **Journaux** montre ce qui s'est passé. Si l'exécution a un point de contrôle enregistré, vous pouvez la reprendre. Vous pouvez aussi la réessayer.

Si un worker s'arrête pendant qu'il exécute votre tâche, Skynet récupère la tâche et réessaie. Après 3 tentatives, Skynet marque la tâche comme échouée. Une reprise après un échec ou une annulation compte aussi comme une tentative. Une reprise après une pause ou un arrêt au budget ne compte pas.

### Annulation

Vous annulez l'exécution. Le statut passe à `cancelled`. Une annulation est irréversible. Plus tard, vous pouvez reprendre l'exécution à partir d'un point de contrôle enregistré, ou la réessayer.

## Pages associées

- [Budgets et facturation](/docs/concepts/billing)
- [Lancer une exécution avec l'assistant](/docs/guides/submit)
- [Limites](/docs/limits)
