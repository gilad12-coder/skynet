The tagger adds labels to the rows of a dataset. You can label every row yourself, or let an AI model label rows while you review its work. The result is a labeled dataset that you can use in a run.

## Start a session

Open the tagger in one of these ways:

- Open the tagger from the dashboard.
- In **Datasets**, select one dataset and click **Tag this dataset**.
- In the dataset editor, click **Tag with AI**.

### Choose the data

The setup asks for the data to label:

- **Choose from your library** uses a dataset that you uploaded. To upload a new file, use [Datasets](/docs/guides/datasets) first.
- **Generate a synthetic dataset** creates rows for you. This option needs the assistant.

### Choose the task type

| Task type                | What you give each row                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| **Yes / No question**    | A yes or no answer.                                                              |
| **Pick from categories** | One or more categories from a list that you define. Add at least two categories. |
| **Written answers**      | A free text answer.                                                              |

### Choose a mode

The setup asks "How do you want to tag?". There are three modes:

| Mode          | What happens                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| **Manual**    | You label every row yourself. No AI is involved.                                                     |
| **Co-pilot**  | After a short interview, the AI tags a first batch. You keep or correct each label in review rounds. |
| **Autopilot** | After a short interview, the AI tags all rows and flags the rows it is not sure about.               |

The setup marks one mode as **Recommended**.

The setup also has a **Tagging model** choice. The default suits most datasets.

> [!NOTE]
> In the Mac app, tagging with AI needs your own provider key. Choose a model under **Your own key**. See [Mac app](/docs/guides/mac-app).

## The dataset interview

Co-pilot and Autopilot start with a **Dataset interview**. The AI asks questions about your data and your labels. You can click **Skip the interview**.

The interview builds a **Labeling guide**. The guide holds the rules that the AI follows. Use **Add a rule** to add your own rule.

At the end, the AI shows **Here's the plan**. Then you start the work:

- In Co-pilot, click **Tag the first {rows} rows for my review**.
- In Autopilot, click **Tag all {rows} rows**.

## Co-pilot review rounds

In Co-pilot, the AI first tags a calibration batch. The batch size depends on the task type:

| Task type            | First batch                                          |
| -------------------- | ---------------------------------------------------- |
| Yes / No question    | 24 rows                                              |
| Pick from categories | 6 rows for each category, at least 30 and at most 60 |
| Written answers      | 30 rows                                              |

If the dataset has fewer rows, the AI tags all of them.

### Review each label

For each row, the side rail shows the AI label:

1. Read the row and the label.
2. To keep the label, click **Confirm (Enter)** or press Enter.
3. To change the label, correct it. The rail shows "Corrected — the AI will learn from this".
4. When you finish, click **Finish this round**.

The rail shows the target: "Once we agree {gate}% of the time, I'll tag the rest myself."

### The agreement gate

After each round, Skynet measures how often you agreed with the AI. The gate is 92% for Yes / No and category tasks. It is 85% for written answers.

The round summary shows "You agreed with the AI on {agreement}%". Then you choose:

- **One more review round** gives you another batch to review.
- **Tag the remaining {rows} rows** lets the AI tag the rest.

## Autopilot and automatic tagging

When the AI tags the remaining rows, the work runs on the server. You can safely leave the page and come back.

- **Resume tagging** continues a stopped job.
- **Cancel — keep what's tagged** stops the job and keeps the labels that exist.

### Review unsure rows

The AI gives each automatic label a confidence. Skynet flags a row when the confidence is below 0.75. After the job, click **Review {count} rows the AI wasn't sure about** to check them.

> [!TIP]
> Review the flagged rows before you use the data in a run. Wrong labels lower the quality of the optimization.

## Manual mode

In Manual mode, you label every row yourself. The keyboard shortcuts below help you work fast.

### Keyboard shortcuts

| Key             | Action                                           |
| --------------- | ------------------------------------------------ |
| Ctrl+H or Cmd+H | Show the shortcuts.                              |
| Y / N           | Answer yes or no on a Yes / No row.              |
| 1 to 9          | Select or clear that category on a category row. |
| U               | Go to the next untagged row.                     |
| Home            | Go to the first row.                             |
| E               | Export as CSV.                                   |

## Results

The results show where each label came from:

| Count                       | Meaning                                  |
| --------------------------- | ---------------------------------------- |
| **Labeled by you**          | Labels that you wrote.                   |
| **AI labels you confirmed** | AI labels that you kept in review.       |
| **Labeled automatically**   | AI labels with no review.                |
| **Cost**                    | The cost of the AI work in this session. |

The **Source** column shows the same values for each row: **You**, **AI confirmed** or **AI**.

## Save and export

### Save to the library

Click **Save to library** or **Move to Datasets** to keep the labeled data as a dataset. Then you can use it in a [run](/docs/guides/submit).

### Export a file

Click **Export tags** and choose a format:

- CSV
- JSON
- Excel (`.xlsx`)
- Parquet
- Feather

If some rows have no label, Skynet asks you to confirm the export.

The export adds a label column. Its name depends on the task type:

| Task type            | Column                |
| -------------------- | --------------------- |
| Yes / No question    | `binary_label`        |
| Pick from categories | `selected_categories` |
| Written answers      | `extracted_text`      |

A `label_source` column records where each label came from.

## Sessions

Each tagging job is a session. A session has one of these statuses: **In progress**, **In review**, **Auto-labeling** or **Done**. Click **Start new session** to begin again with new settings.

You can share a session with other people from its share dialog. For sharing rules, see [Sharing](/docs/guides/sharing).

## Next steps

- [Prepare a dataset](/docs/guides/datasets) before you tag.
- [Submit a run](/docs/guides/submit) with the labeled data.
- Ask the [agent panel](/docs/guides/agent-panel) about your tagging sessions.
