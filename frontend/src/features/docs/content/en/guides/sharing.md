You can share a run with other people, and you can list it in the public Explore gallery. These are two different settings. Link access and invitations control who can open a run. Public visibility controls whether the run shows in public search. This guide explains both.

## Defaults

| Setting | Default for a new run |
| --- | --- |
| Public visibility | **Public**. The run is listed in public search. |
| Link access | **Restricted**. Only the owner and invited people can open the run. |
| Role for **Anyone with the link** | **Viewer** |

The submit wizard shows the visibility of a new run on its last screen. You change it after the run starts, in the **Share and privacy** dialog.

> [!WARNING]
> New runs are public by default. If your run contains data that other users must not see, set it to **Private** in the **Share and privacy** dialog.

## Open the sharing settings

On the run page, select **Share and privacy**. Only the owner of the run sees this button.

## Roles

Each person who can open a run has one of three roles:

| Role | What the person can do |
| --- | --- |
| **Viewer** | Open the run and see its results and its owner. Clone the run. |
| **Editor** | Viewer access plus running the model, chat and renaming. An editor can also cancel, pause, resume and retry the run. |
| **Owner** | Full control, including managing sharing and deletion. |

A run has exactly one owner. All people who open a shared run must sign in. There is no anonymous access to a shared run.

## Share a link

1. Open **Share and privacy**.
2. Under **Link access**, select one of these options:
   - **Restricted**: only the owner and invited people can open the run.
   - **Anyone with the link**: any signed-in user who has the link can open the run.
3. For **Anyone with the link**, select the role that the link gives: **Viewer** or **Editor**. A link never gives the **Owner** role.
4. Select **Copy link**.

The link has the form `/share/<token>`. The token is the part of the link that is hard to guess. If the link is revoked, or the run is deleted, the link shows **Share not found**.

> [!NOTE]
> Secrets, such as API keys and base URLs, never show on a shared run.

## Invite people

1. Open **Share and privacy**.
2. Under **Invite people**, enter a username. The list shows up to 10 users that match.
3. Select a role: **Viewer** or **Editor**.
4. Select **Invite**.

**People with access** lists everyone who has a role on the run. For each person, you can:

- Change the role.
- Remove access.

A person keeps the highest access that the rules give. For example, an invited editor keeps the **Editor** role when the link gives **Viewer**.

### Transfer ownership

You can give the run to another user:

1. Open the role menu of a person in **People with access**. You can also use the role menu under **Invite people**.
2. Select **Transfer ownership**.
3. Confirm the transfer.

The new owner gets full control. You become an editor and lose the owner privileges.

## Public visibility

Public visibility controls whether a run shows in public search in the Explore gallery. It does not change link access or invitations.

| Option | Meaning |
| --- | --- |
| **Public** | Listed in public search. Visible to all users. |
| **Private** | Hidden from public search. Visible only to you and invited people. |

Only the owner can change public visibility. The change takes effect immediately.

## The Explore gallery

The Explore page lets you search optimizations. It has three tabs:

| Tab | What it shows |
| --- | --- |
| **Mine** | Your optimizations, private and public |
| **Public** | Public optimizations from other users |
| **Shared with me** | Optimizations other users shared with you |

Use the search bar and **Filters** to find runs.

You can open a public run from Explore only if it finished with the status `success`. When you open it:

- You get the **Viewer** role. You can read the run and clone it.
- The page shows the owner of the run.
- Skynet removes secrets, such as API keys and base URLs.
- You cannot run the model. The model would spend the owner's key.

> [!TIP]
> To give one person more access to a public run, invite that person as an **Editor**.

## Related pages

- [Runs](/docs/concepts/runs)
- [Read the results](/docs/guides/results)
- [Security](/docs/security)
