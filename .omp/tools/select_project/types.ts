/** A user or agent turn of the thread (agentmux session.Turn). */
export interface Turn {
  Role: string;
  Text: string;
}

/** What is on disk at a project's home: its top-level names (directories end in "/") and the opening of its README. */
export interface Contents {
  Entries: string[];
  Readme: string;
}

/** A live project as the question reads it (agentmux project.Record). */
export interface ProjectRecord {
  ID: string;
  Name: string;
  Goal: string;
  Summary: string;
  Home: string;
  Contents: Contents;
}

/** One thread and the projects it could belong to (agentmux session.Conversation), every default filled in. */
export interface SelectProjectInput {
  WorkDir: string;
  Repo: string;
  Worktree: string;
  Branch: string;
  Title: string;
  FirstRequest: string;
  Turns: Turn[];
  Current?: ProjectRecord;
  Projects: ProjectRecord[];
  ProjectBudget?: number;
}

/** The project a thread is in: a live project's name and id, or a call for a new project (agentmux project.Selected). */
export interface Selected {
  ProjectName: string;
  /** Empty when the input record carried no `ID` and when `NeedsNewProject`. */
  ProjectID: string;
  NeedsNewProject: boolean;
  /** The model's stated probability, 0 to 1, that its pick is right; null when no model was asked. */
  Confidence: number | null;
}
