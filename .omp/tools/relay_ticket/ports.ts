/** What one session needs from the sandbox: where it runs, what it clones, what it is told. */
export interface SessionRequest {
  readonly name: string;
  readonly branch: string;
  /** The stored conversation to resume or start; stable per ticket, unlike the per-run name and branch. */
  readonly conversation: string;
  /** The GitHub repository, `owner/name`, when one is known; without one the session is started with no `--repo` and clones what it needs. */
  readonly repo?: string;
  readonly prompt: string;
  readonly model?: string;
  readonly minutes: number;
}

/** How a session driver run ended. */
export interface SessionRun {
  /** The driver's exit code; null when the capability's deadline or abort stopped it, or it never started. */
  readonly exitCode: number | null;
  /** Everything the driver printed that is kept: the session's output, the container's markers, the driver's own lines. */
  readonly output: string;
  /** True when the deadline or an abort stopped the driver before it ended on its own. */
  readonly stopped: boolean;
}

/**
 * The throwaway sandbox as the capability sees it. The sandbox's lifetime belongs to the session driver's exit path;
 * `present` and `down` exist so the capability can verify that guarantee and sweep when it did not hold.
 */
export interface SandboxPort {
  /** Creates and provisions the named sandbox; throws when it could not (or when `signal` aborted it). The sandbox may exist even then. */
  lease(request: { readonly name: string; readonly minutes: number }, signal?: AbortSignal): Promise<void>;
  /** Runs one session in the leased sandbox; the driver drops the worktree and terminates the sandbox on every exit path. */
  session(request: SessionRequest, signal?: AbortSignal): Promise<SessionRun>;
  /** Whether a sandbox by this name is up now; throws when that cannot be read. */
  present(name: string): Promise<boolean>;
  /** Terminates the sandbox by name; terminating one that is gone succeeds. Throws when it could not. */
  down(name: string): Promise<void>;
}
