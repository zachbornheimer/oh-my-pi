import { describe, expect, it } from "bun:test";
import { decodeSqlBytePrefix } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";

/** The pre-`left()` Postgres result: first `limit` bytes of the UTF-8 content, leniently decoded. */
function bytePrefixOracle(content: string, limit: number): string {
	return new TextDecoder("utf-8").decode(new TextEncoder().encode(content).subarray(0, limit));
}

/** What the new Postgres query returns: `convert_to(left(content, limit), 'UTF8')`. */
function leftRow(content: string, limit: number): Uint8Array {
	return new TextEncoder().encode(Array.from(content).slice(0, limit).join(""));
}

describe("decodeSqlBytePrefix", () => {
	const samples: Record<string, string> = {
		ascii: "abcdefghijklmnopqrstuvwxyz".repeat(4),
		twoByte: "é".repeat(40),
		threeByte: "日本語".repeat(20),
		fourByte: "😀".repeat(30),
		mixed: "a😀é日b".repeat(10),
	};

	for (const [name, content] of Object.entries(samples)) {
		it(`matches the byte-prefix result for ${name} content at every limit`, () => {
			for (let limit = 0; limit <= 90; limit++) {
				expect(decodeSqlBytePrefix(leftRow(content, limit), limit)).toBe(bytePrefixOracle(content, limit));
			}
		});
	}

	it("decodes a character straddling the byte limit to U+FFFD, as a byte cut does", () => {
		// "aé" is 61 C3 A9: limit 2 cuts é in half.
		expect(decodeSqlBytePrefix(leftRow("aé", 2), 2)).toBe("a\uFFFD");
		expect(decodeSqlBytePrefix(leftRow("a😀", 3), 3)).toBe("a\uFFFD");
	});

	it("cuts an over-long ArrayBuffer row to the byte limit", () => {
		const bytes = leftRow("日本語", 3);
		expect(decodeSqlBytePrefix(bytes.buffer, 4)).toBe(bytePrefixOracle("日本語", 4));
	});
});
