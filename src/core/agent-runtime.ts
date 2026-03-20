/**
 * Agent runtime helpers shared by repos that launch pi-compatible harnesses.
 */

export function resolveAgentBinary(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.PI_PATH?.trim();
	if (explicit) return explicit;

	const punkin = env.PUNKIN_BIN?.trim();
	if (punkin) return punkin;

	return "pi";
}
