import {
	type CredentialDisabledEvent,
	getOAuthProviders,
	type CredentialsApi,
	type DisabledCredentialSummary,
	resolveCredentialIdentityKey,
} from "@oh-my-pi/pi-ai";
import { sanitizeText, logger } from "@oh-my-pi/pi-utils";
import { isInvalidatedOAuthTokenError } from "@oh-my-pi/pi-ai/error";

/** `notice` source of an automatic credential disable; print mode writes these to stderr. */
export const CREDENTIAL_DISABLED_NOTICE_SOURCE = "auth";

/**
 * Warning for a credential the auth layer signed out on its own, or `undefined` when the
 * provider has no `/login` entry (MCP OAuth servers re-authorize through their own flow).
 *
 * The provider's failure text is left out on purpose: it is provider-controlled, and it
 * stays in the log line and the stored disable cause.
 */
export function formatCredentialDisabledNotice(event: CredentialDisabledEvent): string | undefined {
	const providers = getOAuthProviders();
	const login =
		providers.find(provider => provider.id === event.provider) ??
		providers.find(provider => provider.storeCredentialsAs === event.provider);
	if (!login) return undefined;
	const account = sanitizeText(event.email ?? event.accountId ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const organization = sanitizeText(event.orgName ?? event.orgId ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const subject = account ? `${login.name} account ${account}` : `A ${login.name} account`;
	return `${subject}${organization ? ` (${organization})` : ""} was signed out automatically. Run /login to sign in again.`;
}

/** Stable identity of one account/subscription, independent of its credential row. */
function accountKey(identity: {
	provider: string;
	accountId?: string;
	email?: string;
	orgId?: string;
}): string | undefined {
	const account = resolveCredentialIdentityKey(identity.provider, {
		type: "oauth",
		access: "",
		refresh: "",
		expires: 0,
		...identity,
	});
	return account ? JSON.stringify([identity.provider, account]) : undefined;
}

/** Owns unresolved accounts for the existing auth warning; outages never dismiss it. */
export class CredentialDisabledNotices {
	readonly #pending = new Map<string, CredentialDisabledEvent>();
	#revision = 0;
	#closed = false;
	#requested = false;
	#running?: Promise<void>;
	readonly #unsubscribe: () => void;

	constructor(
		readonly credentials: CredentialsApi,
		readonly publish: (key: string, message: string) => void,
	) {
		this.#unsubscribe = credentials.onGeneration(() => void this.reconcile());
	}

	disabled(event: CredentialDisabledEvent): void {
		if (this.#closed) return;
		if (/^(replaced by|deleted by user|logged out by user)/i.test(event.disabledCause)) return;
		const key = accountKey(event);
		if (!key) return;
		this.#revision++;
		this.#set(key, event);
		void this.reconcile();
	}

	#set(key: string, event: CredentialDisabledEvent): void {
		const message = formatCredentialDisabledNotice(event);
		if (!message || this.#pending.has(key)) return;
		this.#pending.set(key, event);
		this.publish(key, message);
	}

	/** Coalesce bursts; a stale read cannot dismiss a newer disable. */
	reconcile(): Promise<void> {
		this.#requested = true;
		return (this.#running ??= this.#drain().finally(() => {
			this.#running = undefined;
		}));
	}

	async #drain(): Promise<void> {
		while (this.#requested && !this.#closed) {
			this.#requested = false;
			const revision = this.#revision;
			const generation = this.credentials.generation;
			let disabled: DisabledCredentialSummary[];
			try {
				disabled = await this.credentials.listDisabled(undefined, AbortSignal.timeout(5000));
			} catch (error) {
				logger.debug("Credential notice reconciliation failed", { error: String(error) });
				continue;
			}
			if (this.#closed) return;
			if (revision !== this.#revision || generation !== this.credentials.generation) {
				this.#requested = true;
				continue;
			}
			const disabledRows = new Set(disabled.map(summary => summary.id));
			const active = new Set(
				this.credentials.list().flatMap(row => {
					if (row.credential.type !== "oauth" || disabledRows.has(row.id)) return [];
					const key = accountKey({ provider: row.provider, ...row.credential });
					return key ? [key] : [];
				}),
			);
			// A later deliberate logout/replacement supersedes historical failures.
			const latest = new Map<string, DisabledCredentialSummary>();
			for (const summary of disabled) {
				if (summary.type !== "oauth") continue;
				const key = accountKey(summary);
				if (!key) continue;
				const previous = latest.get(key);
				if (
					!previous ||
					(summary.disabledAtMs ?? 0) > (previous.disabledAtMs ?? 0) ||
					((summary.disabledAtMs ?? 0) === (previous.disabledAtMs ?? 0) && summary.id > previous.id)
				)
					latest.set(key, summary);
			}
			for (const [key, summary] of latest) {
				if (!/^oauth refresh failed:/i.test(summary.cause) && !isInvalidatedOAuthTokenError(summary.cause))
					continue;
				if (active.has(key) || /^(replaced by|deleted by user|logged out by user)/i.test(summary.cause)) continue;
				this.#set(key, { ...summary, credentialId: summary.id, disabledCause: summary.cause });
			}
			for (const key of this.#pending.keys()) {
				if (!active.has(key)) continue;
				this.#pending.delete(key);
				this.publish(key, "");
			}
		}
	}

	close(): void {
		this.#closed = true;
		this.#unsubscribe();
	}
}
