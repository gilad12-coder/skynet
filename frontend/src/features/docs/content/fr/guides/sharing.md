Vous pouvez partager une exécution avec d'autres personnes, et vous pouvez la publier dans la galerie publique Explorer. Ce sont deux paramètres distincts. L'accès au lien et les invitations déterminent qui peut ouvrir une exécution. La visibilité publique détermine si l'exécution apparaît dans la recherche publique. Ce guide explique les deux.

## Valeurs par défaut

| Paramètre                                            | Valeur par défaut pour une nouvelle exécution                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Visibilité publique                                  | **Publique**. L'exécution est listée dans la recherche publique.                     |
| Accès au lien                                        | **Restreint**. Seuls le propriétaire et les personnes invitées peuvent ouvrir l'exécution. |
| Rôle pour **Toute personne disposant du lien**       | **Lecteur**                                                                          |

L'assistant de soumission affiche la visibilité d'une nouvelle exécution sur son dernier écran. Vous la modifiez après le démarrage de l'exécution, dans la boîte de dialogue **Partage et confidentialité**.

> [!WARNING]
> Les nouvelles exécutions sont publiques par défaut. Si votre exécution contient des données que les autres utilisateurs ne doivent pas voir, passez-la en **Privée** dans la boîte de dialogue **Partage et confidentialité**.

## Ouvrir les paramètres de partage

Sur la page de l'exécution, sélectionnez **Partage et confidentialité**. Seul le propriétaire de l'exécution voit ce bouton.

## Rôles

Chaque personne qui peut ouvrir une exécution a l'un de ces trois rôles :

| Rôle             | Ce que la personne peut faire                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Lecteur**      | Ouvrir l'exécution et voir ses résultats et son propriétaire. Cloner l'exécution.                                                                |
| **Éditeur**      | Accès Lecteur, plus l'exécution du modèle, la discussion et le renommage. Un éditeur peut aussi annuler, mettre en pause, reprendre et réessayer l'exécution. |
| **Propriétaire** | Contrôle total, y compris la gestion du partage et la suppression.                                                                               |

Une exécution a exactement un propriétaire. Toutes les personnes qui ouvrent une exécution partagée doivent se connecter. Il n'existe pas d'accès anonyme à une exécution partagée.

## Partager un lien

1. Ouvrez **Partage et confidentialité**.
2. Sous **Accès au lien**, sélectionnez l'une de ces options :
   - **Restreint** : seuls le propriétaire et les personnes invitées peuvent ouvrir l'exécution.
   - **Toute personne disposant du lien** : tout utilisateur connecté qui dispose du lien peut ouvrir l'exécution.
3. Pour **Toute personne disposant du lien**, sélectionnez le rôle que donne le lien : **Lecteur** ou **Éditeur**. Un lien ne donne jamais le rôle **Propriétaire**.
4. Sélectionnez **Copier le lien**.

Le lien a la forme `/share/<token>`. Le jeton est la partie du lien difficile à deviner. Si le lien est révoqué, ou si l'exécution est supprimée, le lien affiche **Partage introuvable**.

> [!NOTE]
> Les secrets, comme les clés API et les URL de base, n'apparaissent jamais sur une exécution partagée.

## Inviter des personnes

1. Ouvrez **Partage et confidentialité**.
2. Sous **Inviter des personnes**, saisissez un nom d'utilisateur. La liste affiche jusqu'à 10 utilisateurs correspondants.
3. Sélectionnez un rôle : **Lecteur** ou **Éditeur**.
4. Sélectionnez **Inviter**.

**Personnes ayant accès** liste toutes les personnes qui ont un rôle sur l'exécution. Pour chaque personne, vous pouvez :

- Changer le rôle.
- Retirer l'accès.

Une personne conserve l'accès le plus élevé que lui donnent les règles. Par exemple, un éditeur invité conserve le rôle **Éditeur** quand le lien donne **Lecteur**.

### Transférer la propriété

Vous pouvez donner l'exécution à un autre utilisateur :

1. Ouvrez le menu des rôles d'une personne dans **Personnes ayant accès**. Vous pouvez aussi utiliser le menu des rôles sous **Inviter des personnes**.
2. Sélectionnez **Transférer la propriété**.
3. Confirmez le transfert.

Le nouveau propriétaire obtient le contrôle total. Vous devenez éditeur et perdez les privilèges de propriétaire.

## Visibilité publique

La visibilité publique détermine si une exécution apparaît dans la recherche publique de la galerie Explorer. Elle ne modifie ni l'accès au lien ni les invitations.

| Option        | Signification                                                                        |
| ------------- | ------------------------------------------------------------------------------------ |
| **Publique**  | Listée dans la recherche publique. Visible par tous les utilisateurs.                |
| **Privée**    | Masquée de la recherche publique. Visible uniquement par vous et les personnes invitées. |

Seul le propriétaire peut modifier la visibilité publique. La modification prend effet immédiatement.

## La galerie Explorer

La page Explorer vous permet de rechercher des optimisations. Elle comporte trois onglets :

| Onglet                     | Ce qu'il affiche                                                |
| -------------------------- | --------------------------------------------------------------- |
| **Les miennes**            | Vos optimisations, privées et publiques                         |
| **Publiques**              | Les optimisations publiques des autres utilisateurs             |
| **Partagées avec moi**     | Les optimisations que d'autres utilisateurs ont partagées avec vous |

Utilisez la barre de recherche et les **Filtres** pour trouver des exécutions.

Vous ne pouvez ouvrir une exécution publique depuis Explorer que si elle s'est terminée avec le statut `success`. Quand vous l'ouvrez :

- Vous obtenez le rôle **Lecteur**. Vous pouvez lire l'exécution et la cloner.
- La page affiche le propriétaire de l'exécution.
- Skynet retire les secrets, comme les clés API et les URL de base.
- Vous ne pouvez pas exécuter le modèle. Le modèle consommerait la clé du propriétaire.

> [!TIP]
> Pour donner davantage d'accès à une personne sur une exécution publique, invitez-la en tant qu'**Éditeur**.

## Pages associées

- [Exécutions](/docs/concepts/runs)
- [Lire les résultats](/docs/guides/results)
- [Sécurité](/docs/security)
