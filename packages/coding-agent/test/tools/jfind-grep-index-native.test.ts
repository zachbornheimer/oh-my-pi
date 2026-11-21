import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { grepIndex } from "@oh-my-pi/pi-coding-agent/tools/jfind/lexical";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

it("indexes keyword hits through the real native shell filesystem adapter", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-grep-index-native-"));
	try {
		await Bun.write(path.join(dir, "target.ts"), "refreshToken();\nrefreshToken();\n");
		await Bun.write(path.join(dir, "decoy.ts"), "unrelated();\n");
		const filesystem = new InternalUrlFilesystem({ context: { cwd: dir }, tier: "read" });
		const index = await grepIndex(dir, ["refreshToken"], {
			includeHidden: false,
			filesystem: filesystem.shellFilesystem(),
		});
		expect(index.keywords).toEqual(["refreshtoken"]);
		expect([...index.perFileKw]).toEqual([["target.ts", [2]]]);
		expect(index.filesScanned).toBe(2);
	} finally {
		await removeWithRetries(dir);
	}
});
