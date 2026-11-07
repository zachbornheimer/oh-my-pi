/**
 * The closed list of facts an inventory can read from an asset, and the fixed read-only commands behind each. A model
 * that researches an advisory may only pick facts from this list and name package names; it never writes a command.
 * Plumbing only: `webmaster.security.inventory` owns what is collected, the risk check owns what it means.
 */

/** Facts read over SSH from a server: what it runs, how its SSH daemon is set up, who can log in with a password. */
export const SERVER_FACTS = [
  "os_release",
  "kernel",
  "kernel_package",
  "libc",
  "packages",
  "sshd_config",
  "sshd_links_pam",
  "shadow_states",
  "listening_ports",
  "sysctl",
  "ssh_banner",
] as const;

/** Facts read from a site: what its web server announces, and (over SSH) what WordPress runs. */
export const SITE_FACTS = ["web_headers", "wp_core_version", "wp_plugins", "wp_themes"] as const;

export const FACTS = [...SERVER_FACTS, ...SITE_FACTS] as const;
export type Fact = (typeof FACTS)[number];
export type ServerFact = (typeof SERVER_FACTS)[number];
export type SiteFact = (typeof SITE_FACTS)[number];

export const isFact = (value: string): value is Fact => (FACTS as readonly string[]).includes(value);

export const isServerFact = (fact: Fact): fact is ServerFact => (SERVER_FACTS as readonly string[]).includes(fact);
export const isSiteFact = (fact: Fact): fact is SiteFact => (SITE_FACTS as readonly string[]).includes(fact);

/** What each fact tells, in the words a model chooses facts by. */
export const FACT_DESCRIPTIONS: Readonly<Record<Fact, string>> = {
  os_release: "server: the operating system and its version (/etc/os-release, Synology's /etc.defaults/VERSION, or sw_vers)",
  kernel: "server: the kernel name, release, build and CPU (uname -srvm); on Ubuntu the `#NN` build is the upload number, so `6.8.0-1055-gke #61-Ubuntu` is package version 6.8.0-1055.61",
  kernel_package:
    "server: the installed package that holds the RUNNING kernel and its full distro version, such as `linux-image-6.8.0-139-generic 6.8.0-139.139` (dpkg) or `kernel-core 5.14.0-687.61.1.el9_8` (rpm), or `no package holds the running kernel` when it is not a package (a managed host, a container, Synology); compare it to the distro's fixed version",
  libc:
    "server: which C library the system runs (ldd --version, getconf GNU_LIBC_VERSION, and the dynamic loader files /lib/ld-musl-* or /lib64/ld-linux-*): glibc, musl or other",
  packages:
    "server: the installed version of each named package (apk, dpkg, rpm, opkg, pacman or brew, whichever the host has), or `not installed: <name>` for one it does not have; needs `package_names`",
  sshd_config:
    "server: the SSH daemon's effective settings (UsePAM, PasswordAuthentication, PermitRootLogin, KbdInteractiveAuthentication, AuthenticationMethods, PermitEmptyPasswords, Port) from `sshd -T` when it can run with passwordless sudo/doas, plus those lines from /etc/ssh/sshd_config*",
  sshd_links_pam: "server: whether the sshd binary is linked to a PAM library (ldd of sshd, PAM lines only)",
  shadow_states:
    "server: how many accounts in /etc/shadow have a hash, are locked (`!`), or hold a bare `*`, and the names of the `*` accounts; never prints a hash; needs passwordless sudo/doas",
  listening_ports: "server: the TCP ports listening (ss -ltn, or netstat -ltn)",
  sysctl:
    "server: the kernel's security settings that gate or mitigate attacks (fs.protected_hardlinks, fs.protected_symlinks, kernel.yama.ptrace_scope, kernel.unprivileged_userns_clone, user.max_user_namespaces, kernel.kptr_restrict, kernel.randomize_va_space, kernel.dmesg_restrict), one `key=value` per line (read with passwordless sudo/doas when the host hides /proc/sys from the login user), `unreadable` for a key the host does not have or will not show",
  ssh_banner: "server: the SSH identification string the daemon announces before login (for example SSH-2.0-OpenSSH_9.9)",
  web_headers:
    "site: the status, Server, X-Powered-By, X-Generator and Via headers of the home page, and its generator meta tag",
  wp_core_version: "site: the WordPress core version (wp core version over SSH; needs the site file's host block)",
  wp_plugins:
    "site: every WordPress plugin with its status and version (wp plugin list over SSH; needs the site file's host block)",
  wp_themes:
    "site: every WordPress theme with its status and version (wp theme list over SSH; needs the site file's host block)",
};

/** Package names a command line may carry: lowercase words, as every distro package manager spells them. */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]{0,63}$/;
export const MAX_PACKAGES = 12;

export function checkedPackages(names: readonly string[]): string[] {
  const bad = names.find((name) => !PACKAGE_NAME.test(name));
  if (bad !== undefined) throw new Error(`"${bad}" is not a package name: use lowercase letters, digits and + . _ -`);
  if (names.length > MAX_PACKAGES) throw new Error(`at most ${MAX_PACKAGES} package names can be read at once`);
  return [...new Set(names)];
}

/** Runs a command with the privileges a host grants without a password; gives up at once when it would ask for one. */
const asRoot = (command: string): string => `{ sudo -n ${command} 2>/dev/null || doas -n ${command} 2>/dev/null; }`;

/** The longest a fact's output may be, in characters: the rest is cut at the source. */
export const OUTPUT_CAP = 8000;

/** The kernel settings the `sysctl` fact reads: the ones that gate or mitigate local-root and sandbox-escape bugs. Fixed, never model-supplied. */
export const SYSCTL_KEYS = [
  "fs.protected_hardlinks",
  "fs.protected_symlinks",
  "kernel.yama.ptrace_scope",
  "kernel.unprivileged_userns_clone",
  "user.max_user_namespaces",
  "kernel.kptr_restrict",
  "kernel.randomize_va_space",
  "kernel.dmesg_restrict",
] as const;

const PAM_OPTIONS = "usepam|passwordauthentication|permitrootlogin|kbdinteractiveauthentication|"
  + "challengeresponseauthentication|pubkeyauthentication|authenticationmethods|permitemptypasswords|port";
const PAM_FILE_OPTIONS =
  "UsePAM|PasswordAuthentication|PermitRootLogin|KbdInteractiveAuthentication|AuthenticationMethods|PermitEmptyPasswords";

/** The shell text that reads one server fact; `ssh_banner` is read from the network, never by a command. */
export function serverCommand(fact: Exclude<ServerFact, "ssh_banner">, packages: readonly string[]): string {
  switch (fact) {
    case "os_release":
      // Synology DSM has no /etc/os-release; its product version and build are in /etc.defaults/VERSION.
      return "cat /etc/os-release 2>/dev/null || cat /etc.defaults/VERSION 2>/dev/null || sw_vers 2>/dev/null || uname -a";
    case "kernel":
      return "uname -srvm";
    case "kernel_package":
      // The package named for the running release only: `linux-image-<uname -r>` (Debian, Ubuntu) or
      // `kernel-core-<uname -r>` (Red Hat family). A line without a version is a package that is not installed.
      return "r=$(uname -r); out=''; "
        + "if command -v dpkg-query >/dev/null 2>&1; then "
        + "out=$(dpkg-query -W -f='${Package} ${Version}\\n' \"linux-image-$r\" \"linux-image-unsigned-$r\" 2>/dev/null | grep -E ' [^ ]+$'); "
        + "elif command -v rpm >/dev/null 2>&1; then "
        + "out=$(rpm -q --qf '%{NAME} %{VERSION}-%{RELEASE}\\n' \"kernel-core-$r\" \"kernel-$r\" 2>/dev/null | grep -v 'not installed'); fi; "
        + "if [ -n \"$out\" ]; then echo \"$out\"; else echo 'no package holds the running kernel'; fi";
    case "libc":
      return "ldd --version 2>&1 | head -n 2; getconf GNU_LIBC_VERSION 2>/dev/null; "
        + "ls /lib/ld-musl-* /usr/lib/ld-musl-* /lib64/ld-linux-* /lib/ld-linux-* 2>/dev/null";
    case "packages":
      return [
        "if command -v dpkg-query >/dev/null 2>&1; then pm=dpkg;",
        "elif command -v rpm >/dev/null 2>&1; then pm=rpm;",
        "elif command -v apk >/dev/null 2>&1; then pm=apk;",
        "elif command -v opkg >/dev/null 2>&1; then pm=opkg;",
        "elif command -v pacman >/dev/null 2>&1; then pm=pacman;",
        "elif command -v brew >/dev/null 2>&1; then pm=brew;",
        "else pm=none; fi;",
        "echo \"package manager: $pm\";",
        "if [ \"$pm\" = none ]; then echo 'no supported package manager found'; exit 3; fi;",
        `for p in ${checkedPackages(packages).join(" ")}; do`,
        "if [ \"$pm\" = dpkg ]; then out=$(dpkg-query -W -f='${Package} ${Version}\\n' \"$p\" 2>/dev/null | grep -E ' [^ ]');",
        "elif [ \"$pm\" = rpm ]; then out=$(rpm -q --qf '%{NAME} %{VERSION}-%{RELEASE}\\n' \"$p\" 2>/dev/null | grep -v 'not installed');",
        "elif [ \"$pm\" = apk ]; then out=$(apk list -I \"$p\" 2>/dev/null | head -n 5);",
        "elif [ \"$pm\" = opkg ]; then out=$(opkg list-installed \"$p\" 2>/dev/null);",
        "elif [ \"$pm\" = pacman ]; then out=$(pacman -Q \"$p\" 2>/dev/null);",
        "else out=$(brew list --versions \"$p\" 2>/dev/null); fi;",
        "if [ -n \"$out\" ]; then printf '%s\\n' \"$out\"; else echo \"not installed: $p\"; fi;",
        "done",
      ].join(" ");
    case "sshd_config":
      return [
        "cfg=$(sshd -T 2>/dev/null || sudo -n sshd -T 2>/dev/null || doas -n sshd -T 2>/dev/null);",
        "if [ -n \"$cfg\" ]; then echo 'effective (sshd -T):';",
        `printf '%s\\n' "$cfg" | grep -Ei '^(${PAM_OPTIONS}) ';`,
        "else echo 'effective settings unreadable: sshd -T needs root'; fi;",
        "echo 'config files:';",
        `grep -rEi '^[[:space:]]*(${PAM_FILE_OPTIONS})[[:space:]]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>&1 | head -n 40`,
      ].join(" ");
    case "sshd_links_pam":
      return "ldd \"$(command -v sshd || echo /usr/sbin/sshd)\" 2>&1 | grep -i pam || echo 'no PAM library linked'";
    case "shadow_states":
      return asRoot(
        "awk -F: '$2==\"*\"{s=s\" \"$1} substr($2,1,1)==\"$\"{h=h+1} substr($2,1,1)==\"!\"{l=l+1} "
          + "END{print \"star_accounts:\" s; print \"hashed_accounts:\" h+0; print \"locked_accounts:\" l+0}' /etc/shadow",
      ) + " || echo 'unreadable: /etc/shadow needs root'";
    case "listening_ports":
      return "ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null | head -n 60";
    case "sysctl":
      // Unprivileged first; hosts that harden /proc/sys (zysys answers "permission denied") get the passwordless
      // sudo/doas read that `sshd_config` and `shadow_states` already use. Read-only either way.
      return `for k in ${SYSCTL_KEYS.join(" ")}; do v=$(sysctl -n $k 2>/dev/null); `
        + "[ -n \"$v\" ] || v=$(cat /proc/sys/$(echo $k | tr . /) 2>/dev/null); "
        + "[ -n \"$v\" ] || v=$(" + asRoot("sysctl -n $k") + "); "
        + "echo \"$k=${v:-unreadable}\"; done";
  }
}

/** One fact's place in the script the server runs. */
export interface ScriptedFact {
  readonly fact: Fact;
  /** The text of the command, for the record. */
  readonly command_line: string;
}

/**
 * One shell script that reads every fact in turn, each between a begin and an end line carrying `nonce`, so one SSH
 * session reads the lot and the output of one fact can never pass for another's.
 */
export function factScript(facts: readonly ScriptedFact[], nonce: string): string {
  const sections = facts.map(({ fact, command_line }) =>
    [
      `echo "@@${nonce}:begin:${fact}"`,
      `out=$( { ${command_line}\n} 2>&1 ); code=$?`,
      `printf '%s\\n' "$out" | head -c ${OUTPUT_CAP}`,
      `echo "@@${nonce}:end:${fact}:$code"`,
    ].join("\n")
  );
  return ["PATH=\"$PATH:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin\"", ...sections].join("\n");
}

/** What one fact's section printed. */
export interface FactSection {
  readonly code: number;
  readonly output: string;
}

/** The sections a script printed, by fact; a fact whose end line never came is missing. */
export function readSections(stdout: string, nonce: string): Map<Fact, FactSection> {
  const sections = new Map<Fact, FactSection>();
  const lines = stdout.split("\n");
  let current: { fact: Fact; lines: string[] } | undefined;
  const begin = `@@${nonce}:begin:`;
  const end = `@@${nonce}:end:`;
  for (const line of lines) {
    if (current === undefined) {
      if (line.startsWith(begin)) {
        const name = line.slice(begin.length);
        if (isFact(name)) current = { fact: name, lines: [] };
      }
    } else if (line.startsWith(`${end}${current.fact}:`)) {
      const code = Number(line.slice(end.length + current.fact.length + 1));
      sections.set(current.fact, { code, output: current.lines.join("\n").trim() });
      current = undefined;
    } else {
      current.lines.push(line);
    }
  }
  return sections;
}

/** An SSH target as a command line may carry it: a plain word that cannot read as an option (`-oProxyCommand=...`). */
export const SSH_TARGET = /^[A-Za-z0-9_@:=+./][A-Za-z0-9_./@:=+-]*$/;

/** The ssh argument that runs `script` under `sh` however the remote account's own shell quotes things. */
export function remoteRunner(script: string): string {
  return `printf %s '${Buffer.from(script).toString("base64")}' | base64 -d | sh`;
}
