/** The task_class question, its closed menu of categories and worked examples (agentmux internal/classify/data/task_class.yaml, copied unchanged). */
export const QUESTION = "What kind of work is this goal?";

/** A pick whose stated confidence is below this is unsure. */
export const THRESHOLD = 0.7;

export const CATEGORIES: readonly { readonly id: string; readonly criteria: string }[] = [
  {
    "id": "simple_edit",
    "criteria": "A small, mechanical, single-file-or-few-file change with an obvious implementation (create/edit a file, fix a typo, bump a version, ordinary local git add/commit)."
  },
  {
    "id": "hard_code",
    "criteria": "A change that spans multiple packages or files, needs design or architecture decisions, or touches shared abstractions."
  },
  {
    "id": "structured_extraction",
    "criteria": "Pulling structured data out of unstructured input (parse this, extract these fields)."
  },
  {
    "id": "research",
    "criteria": "Answering a question by reading or searching many sources before anything is written."
  },
  {
    "id": "judgment",
    "criteria": "A call that trades off options with no single mechanical answer."
  },
  {
    "id": "summarization",
    "criteria": "Condensing existing material into a shorter form."
  },
  {
    "id": "status_update",
    "criteria": "Reporting on work already done, with no new implementation, research, or extraction."
  }
];

export const EXAMPLES: readonly { readonly text: string; readonly category: string }[] = [
  {
    "text": "Create a file named hello.txt containing the single line: hello from delegate. Commit it.",
    "category": "simple_edit"
  },
  {
    "text": "Fix the typo in the README title and commit.",
    "category": "simple_edit"
  },
  {
    "text": "Bump the version string in package.json and commit.",
    "category": "simple_edit"
  },
  {
    "text": "Refactor the auth module across packages to use the new session type.",
    "category": "hard_code"
  },
  {
    "text": "Design and implement a new caching layer shared by three services.",
    "category": "hard_code"
  },
  {
    "text": "Extract the invoice number, date, and total from this PDF text.",
    "category": "structured_extraction"
  },
  {
    "text": "Pull every email address out of this log file.",
    "category": "structured_extraction"
  },
  {
    "text": "Find out which of our vendors support SOC 2 compliance.",
    "category": "research"
  },
  {
    "text": "Compare three logging libraries and recommend one.",
    "category": "research"
  },
  {
    "text": "Decide whether to use REST or GraphQL for the new API.",
    "category": "judgment"
  },
  {
    "text": "Decide which of the two proposed schemas to migrate to.",
    "category": "judgment"
  },
  {
    "text": "Summarize this incident report into three bullet points.",
    "category": "summarization"
  },
  {
    "text": "Write a one-paragraph summary of this design doc.",
    "category": "summarization"
  },
  {
    "text": "Post a status update on the migration's progress.",
    "category": "status_update"
  },
  {
    "text": "Report what changed since the last release.",
    "category": "status_update"
  }
];
